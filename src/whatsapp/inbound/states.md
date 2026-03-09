# Inbound Pipeline — Complete State Tree

Every branch of logic from webhook receipt to terminal state.

## How to read this document

- **■ T1, T2, ...** — terminal states (the job/request ends here).
- **→ sendFallback** — enters the shared sendFallbackMessage sub-tree (see bottom).
- **Max accumulated** — the maximum processing time to reach that terminal, assuming every step along the path takes the longest possible. Queue wait times between stages are excluded since they are variable.
- **msgTs ceiling** — where noted, the actual wall-clock limit from the original message timestamp. Steps 4 and sendFallbackMessage in the message handler use deadlines relative to msgTs (the timestamp of the user's original WhatsApp message), not relative to when the step begins. This means the "max accumulated" (sum of step-level caps) can exceed the msgTs ceiling; in practice the msgTs ceiling wins and forces earlier termination.
- Backoff durations (e.g. "backoff 10s") mean exponential backoff with that cap. Initial interval, multiplier, and jitter are unspecified in the prompts.

---

## STAGE 1 — INGRESS (synchronous HTTP handler)

Span: `wabot.ingress`
Sources: `wa-handle-ingress.controller` + `wa-handle-ingress.service`

```
1. Validate X-Hub-Signature-256
   │
   ├─ INVALID
   │  └─ ■ T1  HTTP 401. Log WARN. End span.
   │     Max accumulated: 0s
   │
   └─ VALID → step 2

2. Enqueue `webhook` job on BullMQ `ingest` queue
   │
   ├─ SUCCESS → step 3
   │
   └─ FAIL → backoff 10s
       │
       ├─ RETRY SUCCESS → step 3
       │
       └─ CAP HIT
          └─ ■ T2  HTTP 500. Log ERROR. End span.
                    WhatsApp will retry the webhook.
             Max accumulated: 10s

3. Return HTTP 200 to WhatsApp. Log INFO. End span.
   └─ ■ T3  HTTP 200 returned.
            Job now on `ingest` queue → STAGE 2.
      Max accumulated: 0–10s (10s if step 2 had temporary failures)
```

---

## STAGE 2 — INGEST (BullMQ worker on `ingest` queue)

Span: `wabot.ingest`
Source: `wa-message-ingest.processor`

```
1. Start span.

2. Structural validation (object, entry, id, changes, field, value)
   │
   ├─ FAIL
   │  └─ ■ T4  Log ERROR. End span. End job.
   │     Max accumulated: 0s
   │
   └─ PASS → step 3

3. Loop over entries
   │
   ├─ entry.id ≠ WHATSAPP_BUSINESS_ACCOUNT_ID → skip entry
   │
   └─ entry.id matches → step 3.1

   3.1. Loop over changes
        │
        ├─ field ≠ "messages" OR messaging_product ≠ "whatsapp" → skip change
        │
        └─ matches → steps 3.2, 3.3, 3.4

        3.2. For each message in value.messages ?? []:
             │
             ├─ VALIDATION FAIL (missing string from/id/timestamp/type)
             │  └─ Log WARN. Skip message.                        +0s
             │
             └─ VALID → enqueue `message` job on `process` queue
                │
                ├─ ENQUEUE SUCCESS → next message                 +0s
                │
                └─ ENQUEUE FAIL → backoff 10s
                    ├─ RETRY SUCCESS → next message               +up to 10s
                    └─ CAP HIT → Log ERROR. Next message.         +10s

        3.3. For each status in value.statuses ?? []:
             │
             ├─ VALIDATION FAIL (missing string id/status/recipient_id)
             │  └─ Log WARN. Skip status.                         +0s
             │
             └─ VALID → enqueue `status` job on `process` queue
                │
                ├─ ENQUEUE SUCCESS → next status                  +0s
                │
                └─ ENQUEUE FAIL → backoff 10s
                    ├─ RETRY SUCCESS → next status                +up to 10s
                    └─ CAP HIT → Log ERROR. Next status.          +10s

        3.4. For each error in value.errors ?? []:
             │
             ├─ VALIDATION FAIL (code is not a number)
             │  └─ Log WARN. Skip error.                          +0s
             │
             └─ VALID → enqueue `error` job on `process` queue
                │
                ├─ ENQUEUE SUCCESS → next error                   +0s
                │
                └─ ENQUEUE FAIL → backoff 10s
                    ├─ RETRY SUCCESS → next error                 +up to 10s
                    └─ CAP HIT → Log ERROR. Next error.           +10s

   ALL ENTRIES/CHANGES FILTERED (no items matched)
   └─ ■ T5  End span. End job.
      Max accumulated: 0s

4. End span. Log INFO. End job.
   └─ ■ T6  Ingest job complete. Items enqueued to `process` queue → STAGE 3.
      Max accumulated: (M + S + E) × 10s
      where M/S/E = count of messages/statuses/errors that all fail enqueue.
      Single item worst case: 10s
```

---

## STAGE 3 — PROCESS ROUTER (BullMQ worker on `process` queue)

Span: `wabot.process`
Source: `wa-message-process.processor`

```
1. Start span.

2. Route by job.name
   │
   ├─ "message" → STAGE 3A (Message Handler)
   │
   ├─ "status"  → STAGE 3B (Status Handler)
   │
   ├─ "error"   → STAGE 3C (Error Handler)
   │
   └─ UNKNOWN
      └─ ■ T7  Log ERROR. End job.
         Max accumulated: 0s
```

---

## STAGE 3A — MESSAGE HANDLER

Child span: `wabot.process.message`
Source: `process-message.handler`

```
0. Start child span.

1. DEDUPE — SET "{wabot:${ENV}}:dedupe:wamid:<wamid>" 1 NX (TTL 7 days)
   │
   ├─ REDIS FAIL → backoff 10s
   │  │
   │  ├─ RETRY SUCCESS → treat as SET result below
   │  │
   │  └─ CAP HIT
   │     └─ ■ T8  Log ERROR. Terminate job.
   │        Max accumulated: 10s
   │
   ├─ RETURNS nil (key already existed — duplicate message)
   │  └─ ■ T9  Dedupe hit metric. Terminate job.
   │     Max accumulated: 0s
   │
   └─ SET OK (not a duplicate) → step 2
      Step 1 worst case to continue: 10s (temporary failures then success)

2. TYPING INDICATOR — send to user via WhatsApp API
   │
   ├─ 2XX → step 3                                               +0s
   │
   ├─ 4XX → Log WARN → step 3                                    +0s
   │
   └─ 429 / 5XX → backoff 10s
       │
       ├─ RETRY SUCCESS → step 3                                 +up to 10s
       │
       └─ CAP HIT → Log WARN → step 3                            +10s
   │
   [All outcomes continue to step 3]
   Step 2 worst case: 10s

3. CONSECUTIVE CHECK — EXISTS "{wabot:${ENV}}:inflight:<wa_id>"
   │
   ├─ REDIS FAIL (EXISTS call) → backoff 10s
   │  │
   │  ├─ RETRY SUCCESS → treat as EXISTS result below
   │  │
   │  └─ CAP HIT → Log ERROR                                     +10s
   │     └─ → sendFallback (entry F-A)
   │        Accumulated before fallback: 10 + 10 + 10 = 30s
   │
   ├─ EXISTS = 0 (no inflight messages for this user)
   │  └─ SADD wamid to inflight set + EXPIRE 25s
   │     │
   │     ├─ REDIS FAIL (SADD) → backoff 10s
   │     │  │
   │     │  ├─ RETRY SUCCESS → step 4                            +up to 10s
   │     │  │
   │     │  └─ CAP HIT → Log ERROR                               +10s
   │     │     └─ → sendFallback (entry F-B)
   │     │        Accumulated before fallback: 10 + 10 + 10 = 30s
   │     │
   │     └─ SADD SUCCESS → step 4                                +0s
   │
   └─ EXISTS = 1 (inflight messages exist — consecutive)
      └─ Flag message as consecutive → step 4                    +0s

   Step 3 worst case to continue: 10s

4. FORWARD TO PADHAIPAL — HTTP POST extracted message data
   Timeout deadline: msgTs + 20s
   │
   ├─ 2XX from PadhaiPal
   │  └─ ■ T10  SUCCESS. Log INFO. End worker and span.
   │     Max accumulated: 10 + 10 + 10 + 0 = 30s
   │     msgTs ceiling: 20s (PP must respond before deadline)
   │
   ├─ NO RESPONSE by msgTs + 20s deadline → Log WARN
   │  └─ → sendFallback (entry F-C)
   │     Accumulated before fallback: 10 + 10 + 10 + (20s − elapsed from msgTs) = up to 30s
   │     msgTs elapsed at entry: 20s + queue waits + ingress + ingest
   │
   ├─ 5XX / 408 / 425 / 429 → Log ERROR
   │  └─ → sendFallback (entry F-D)
   │     Accumulated before fallback: up to 30s
   │
   └─ Other 4XX / 3XX → Log ERROR
      └─ → sendFallback (entry F-E)
         Accumulated before fallback: up to 30s
```

---

## STAGE 3B — STATUS HANDLER

Child span: `wabot.process.status`
Source: `process-status.handler`

```
0. Start child span.

1. Route by status value
   │
   ├─ "sent" or "read"
   │  └─ ■ T11  Ignore. Terminate worker.
   │     Max accumulated: 0s
   │
   ├─ "delivered" → step 2
   │
   └─ "failed" → step 3

2. CLEAR INFLIGHT — SCAN + UNLINK "{wabot:${ENV}}:inflight:wa_id:<wa_id>*"
   │
   ├─ REDIS SUCCESS
   │  └─ ■ T12  Inflight keys deleted. Terminate job.
   │     Max accumulated: 0s
   │
   └─ REDIS FAIL → retry every 250ms for 25s
       │
       ├─ RETRY SUCCESS
       │  └─ ■ T13  Inflight keys deleted (delayed). Terminate job.
       │     Max accumulated: up to 25s
       │
       └─ CAP HIT (25s)
          └─ ■ T14  Log ERROR. Terminate job.
                    Keys will self-expire via 25s TTL.
             Max accumulated: 25s

3. STATUS = "failed" — bot's outbound message failed to deliver
   └─ Log WARN. Attach status.errors[].
      └─ → sendFallback (entry F-F)
         Accumulated before fallback: 0s
```

---

## STAGE 3C — ERROR HANDLER

Child span: `wabot.process.error`
Source: `process-error.handler`

```
0. Start child span.

1. Classify error by code
   │
   ├─ WARN CODE (transient/rate-limit)  → Log WARN with error JSON
   ├─ ERROR CODE (auth/config/permanent) → Log ERROR with error JSON
   └─ UNKNOWN CODE                       → Log WARN with error JSON

2. Record metric: wabot_error_handler_total { code, level }

3. End span. Terminate job.
   └─ ■ T15  Error classified and recorded.
      Max accumulated: 0s
```

---

## SHARED — sendFallbackMessage(wa_id, messageTimestamp)

Source: `send-fallback-message`

Sends FALLBACK_VIDEO_URL with apology text via WhatsApp API.
Entered from six points (F-A through F-F). The accumulated time before entry varies by caller.

```
Send fallback message to user
│
├─ 2XX
│  └─ ■ F1  Log INFO. End worker and span.
│     Fallback processing: 0s
│
├─ 429 / 5XX
│  │
│  ├─ msgTs MORE than 20s old
│  │  └─ ■ F2  Log WARN. Mark job failed. Terminate.
│  │     Fallback processing: 0s
│  │
│  └─ msgTs LESS than 20s old → backoff up to msgTs + 25s
│     │
│     ├─ RETRY SUCCESS
│     │  └─ ■ F3  Log INFO. End worker and span.
│     │     Fallback processing: up to (25s − elapsed from msgTs)
│     │
│     └─ CAP HIT (msgTs + 25s)
│        └─ ■ F4  Log ERROR. Mark job failed. Terminate.
│           Fallback processing: up to (25s − elapsed from msgTs)
│
└─ 4XX
   └─ ■ F5  Log ERROR. Mark job failed. Terminate.
      Fallback processing: 0s
```

---

## Summary — All Terminal States

### Ingress terminals (HTTP response to WhatsApp)

| ID | Description | Level | Max processing |
|----|-------------|-------|----------------|
| T1 | Invalid signature | WARN | **0s** |
| T2 | Enqueue to ingest fails after backoff | ERROR | **10s** |
| T3 | Enqueue success, 200 returned | INFO | **0–10s** |

### Ingest terminals (BullMQ worker)

| ID | Description | Level | Max processing |
|----|-------------|-------|----------------|
| T4 | Structural validation fails | ERROR | **0s** |
| T5 | All entries/changes filtered out | INFO | **0s** |
| T6 | Job complete (items enqueued) | INFO | **(M+S+E) × 10s** |

### Process terminals — Router

| ID | Description | Level | Max processing |
|----|-------------|-------|----------------|
| T7 | Unknown job.name | ERROR | **0s** |

### Process terminals — Message Handler

| ID | Description | Level | Handler max | msgTs ceiling |
|----|-------------|-------|-------------|---------------|
| T8 | Dedupe Redis permanent failure | ERROR | **10s** | — |
| T9 | Dedupe hit (duplicate) | INFO | **0s** | — |
| T10 | PP returns 2XX (success) | INFO | **30s** | **20s from msgTs** |

### Process terminals — Message Handler via sendFallback

There are 6 entry points into sendFallback from the message handler and 1 from the status handler. Each entry point combines with 5 sendFallback outcomes, but the msgTs ceiling (25s) governs the practical maximum.

**Entry points and their accumulated processing before sendFallback:**

| Entry | Triggered when | Accumulated before fallback |
|-------|----------------|----------------------------|
| F-A | Step 3: EXISTS Redis backoff cap | 30s (10+10+10) |
| F-B | Step 3: SADD Redis backoff cap | 30s (10+10+10) |
| F-C | Step 4: PP no response by deadline | up to 30s |
| F-D | Step 4: PP returns 5XX/408/425/429 | up to 30s |
| F-E | Step 4: PP returns other 4XX/3XX | up to 30s |
| F-F | Status handler: status = "failed" | 0s |

**sendFallback outcomes and their additional processing time:**

| Exit | Outcome | Level | Additional time |
|------|---------|-------|-----------------|
| F1 | Fallback sent (2XX) | INFO | 0s |
| F2 | 429/5XX, msgTs > 20s old | WARN | 0s |
| F3 | 429/5XX, retry succeeds | INFO | up to (25s − elapsed from msgTs) |
| F4 | 429/5XX, backoff cap hit | ERROR | up to (25s − elapsed from msgTs) |
| F5 | Fallback returns 4XX | ERROR | 0s |

**Combined worst cases (entry + fallback):**

For message handler entries (F-A through F-E):
- Theoretical max (sum of step caps): **30s** handler + sendFallback time.
- Practical max from msgTs: **25s**. Since the sendFallback backoff cap is msgTs + 25s, the wall-clock time from the user's message can never exceed 25s regardless of how much internal processing time was consumed. If steps 1–3 already consumed 30s of processing, the message is already > 25s old (plus queue waits), so sendFallback terminates immediately (F2) adding 0s.

For status handler entry (F-F):
- The status handler does not have a prior processing delay, but sendFallback's own msgTs-relative backoff caps at 25s from the status timestamp passed in.
- Practical max: **25s** from the timestamp passed to sendFallback.

### Process terminals — Status Handler

| ID | Description | Level | Max processing |
|----|-------------|-------|----------------|
| T11 | Status = sent/read (ignored) | INFO | **0s** |
| T12 | Delivered, inflight keys cleared | INFO | **0s** |
| T13 | Delivered, keys cleared after retry | INFO | **up to 25s** |
| T14 | Delivered, Redis backoff cap hit | ERROR | **25s** |
| — | Failed → sendFallback (see above) | — | **up to 25s from msgTs** |

### Process terminals — Error Handler

| ID | Description | Level | Max processing |
|----|-------------|-------|----------------|
| T15 | Error classified and logged | WARN/ERROR | **0s** |

---

## End-to-End Maximum Processing Time (excluding queue waits)

The total wall-clock processing time for any single webhook item traversing the full pipeline is the sum of stage processing times plus BullMQ queue wait times (variable, excluded here).

| End-to-end path | Ingress | Ingest | Process | Total processing | msgTs ceiling |
|-----------------|---------|--------|---------|------------------|---------------|
| Ingress rejects (T1) | 0s | — | — | **0s** | — |
| Ingress enqueue fails (T2) | 10s | — | — | **10s** | — |
| Ingest structural fail (T4) | 10s | 0s | — | **10s** | — |
| Ingest all filtered (T5) | 10s | 0s | — | **10s** | — |
| Error handler (T15) | 10s | 10s | 0s | **20s** | — |
| Status: sent/read (T11) | 10s | 10s | 0s | **20s** | — |
| Status: delivered ok (T12) | 10s | 10s | 0s | **20s** | — |
| Status: delivered Redis fail (T14) | 10s | 10s | 25s | **45s** | — |
| Status: failed → fallback (F4) | 10s | 10s | 25s | **45s** | 25s from msgTs |
| Message: duplicate (T9) | 10s | 10s | 0s | **20s** | — |
| Message: dedupe fail (T8) | 10s | 10s | 10s | **30s** | — |
| Message: PP success (T10) | 10s | 10s | 30s | **50s** | 20s from msgTs |
| Message → fallback (F4) | 10s | 10s | 30s | **50s** | 25s from msgTs |

**Worst-case by stage:**
- Ingress: **10s**
- Ingest (single item): **10s**
- Message handler (incl. sendFallback): **30s** step-max sum, **25s** msgTs ceiling
- Status handler (delivered path): **25s**
- Status handler (failed + fallback): **25s** msgTs ceiling
- Error handler: **0s**

**Absolute worst-case total processing (single item, all stages):**
- Theoretical (sum of step maxes): **50s** (10 + 10 + 30) for a message that hits every backoff cap then reaches sendFallback
- Practical (msgTs ceiling governs): **25s from the user's message timestamp** for any path through sendFallback, plus ingress/ingest processing and queue waits that occurred before the process stage. The message handler's step 4 and sendFallback will self-terminate based on the msgTs deadline, so the practical user-facing latency is bounded by 25s regardless of upstream delays.
- For paths without msgTs ceiling (e.g. status delivered + Redis fail): **45s** of pure processing time (10 + 10 + 25), with no timestamp-based cutoff.
