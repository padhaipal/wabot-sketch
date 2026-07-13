import { context, metrics, propagation } from '@opentelemetry/api';
import { BAGGAGE_LOAD_TEST, BAGGAGE_TEST_PHASE } from './baggage-keys.js';

const meter = metrics.getMeter('wabot');

export const messageE2eDuration = meter.createHistogram(
  'wabot.message.e2e_duration_ms',
  {
    description:
      'End-to-end milliseconds from WhatsApp message timestamp to wabot processing completion.',
    unit: 'ms',
    advice: {
      explicitBucketBoundaries: [
        5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
        15000, 20000, 25000, 30000, 60000,
      ],
    },
  },
);

// ─── user_e2e: the user-perceived SLO ────────────────────────────────────────
// Meta-clock milliseconds from the user pressing send (inbound
// `messages[].timestamp`) to the FIRST reply item reaching their device
// (Meta's delivered/read `statuses[].timestamp`). Both ends are stamped by
// WhatsApp's servers, so there is no skew against our clocks — but
// resolution is 1 second, hence no sub-second buckets. Correlation state
// lives in Redis (see otel/user-e2e.ts); recording happens in the status
// processor. `late` = delivered after USER_E2E_LATE_THRESHOLD_MS (phone
// offline etc.) — query latency percentiles on outcome="delivered" only.
export const userE2eDuration = meter.createHistogram(
  'wabot.user_e2e_duration_ms',
  {
    description:
      'User-perceived ms from user send (Meta message timestamp) to first reply delivered to the device (Meta status timestamp).',
    unit: 'ms',
    advice: {
      explicitBucketBoundaries: [
        1000, 2000, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 30000, 45000,
        60000,
      ],
    },
  },
);

export type UserE2eOutcome = 'delivered' | 'late';

// Unlike buildE2eAttributes this does NOT read baggage: the delivered-status
// webhook is a fresh Meta request with no baggage, so load_test/test_phase
// travel through the Redis correlation payload instead.
export function buildUserE2eAttributes(
  outcome: UserE2eOutcome,
  loadTest: string,
  testPhase?: string,
  replyKind?: string,
): Record<string, string> {
  const attrs: Record<string, string> = {
    outcome,
    load_test: loadTest,
    // A delivered fallback ("sorry, something went wrong" audio) is a
    // FAILURE that arrived on time — SLO queries must filter
    // reply_kind="real"; the fallback rate is its own alarm.
    reply_kind: replyKind === 'fallback' ? 'fallback' : 'real',
  };
  if (typeof testPhase === 'string' && testPhase.length > 0) {
    attrs.test_phase = testPhase;
  }
  return attrs;
}

export type MessageE2eOutcome =
  | 'success'
  | 'delivered'
  | 'inflight-expired'
  | 'whatsapp-error'
  | 'fallback';

// Builds the attribute set for messageE2eDuration. Reads padhaipal.load_test
// + padhaipal.test_phase from the active context's W3C Baggage so every
// record() site gets the labels without threading flags through DTOs.
// load_test defaults to 'false' (so the label is always present and queries
// can use exact-match filters). test_phase is optional — only set when the
// upstream accept controller saw the x-test-phase header.
export function buildE2eAttributes(
  outcome: MessageE2eOutcome,
): Record<string, string> {
  const baggage = propagation.getBaggage(context.active());
  const loadTest = baggage?.getEntry(BAGGAGE_LOAD_TEST)?.value ?? 'false';
  const testPhase = baggage?.getEntry(BAGGAGE_TEST_PHASE)?.value;

  const attrs: Record<string, string> = { outcome, load_test: loadTest };
  if (typeof testPhase === 'string' && testPhase.length > 0) {
    attrs.test_phase = testPhase;
  }
  return attrs;
}

// Counts outbound text media items dropped for exceeding the WhatsApp
// 4096-character text body limit (see TEXT_BODY_MAX_CHARS in
// whatsapp/outbound/outbound.service.ts). Text bodies are runtime-generated
// upstream (e.g. pp-sketch sentence prompts), so a non-zero rate here means
// an upstream producer is emitting oversize prompts and students are missing
// messages. `path` is the send entry point ('sendMessage' | 'sendNotification').
export const oversizeTextBlocked = meter.createCounter(
  'wabot.outbound.oversize_text_blocked',
  {
    description:
      'Outbound text items dropped for exceeding the WhatsApp 4096-char body limit.',
  },
);

export function buildOversizeTextAttributes(
  path: 'sendMessage' | 'sendNotification',
): Record<string, string> {
  const baggage = propagation.getBaggage(context.active());
  const loadTest = baggage?.getEntry(BAGGAGE_LOAD_TEST)?.value ?? 'false';
  return { path, load_test: loadTest };
}
