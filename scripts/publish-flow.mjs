#!/usr/bin/env node
/**
 * One-off publisher for the comprehension multiple-choice WhatsApp Flow asset.
 *
 * Usage (Railway wabot-sketch terminal):
 *   node scripts/publish-flow.mjs
 *
 * Required env (already present on the wabot-sketch deployment):
 *   WHATSAPP_ACCESS_TOKEN          Cloud API access token
 *   WHATSAPP_BUSINESS_ACCOUNT_ID   WABA id the flow is attached to
 * Optional:
 *   GRAPH_API_VERSION              default v21.0 (matches outbound.service.ts)
 *   FLOW_NAME                      default comprehension-mcq-v1
 *   FLOW_VARIANT                   mcq (default) | passage — `passage` adds a
 *                                  TextBody bound to data.passage_text above
 *                                  the question (level 11+ read-in-flow,
 *                                  2026-09). Pair with e.g.
 *                                  FLOW_NAME=comprehension-mcq-passage-v1.
 *   PUBLISH                        set to 0 to stop after the asset upload
 *                                  (draft stays editable; prints the preview
 *                                  URL) — publishing is irreversible.
 *
 * What it does:
 *   1. POST /{WABA}/flows                 → create a draft flow (category OTHER)
 *   2. POST /{FLOW_ID}/assets             → upload the flow JSON below
 *   3. POST /{FLOW_ID}/publish            → publish (immutable afterwards)
 *   4. Prints the flow id — set it as WHATSAPP_COMPREHENSION_FLOW_ID on the
 *      pp-sketch deployment.
 *
 * The flow is a single static screen (no data endpoint): TextBody question +
 * RadioButtonsGroup whose options arrive at send time via
 * flow_action_payload.data, so ONE published asset serves 2-, 3- and 4-option
 * questions (option titles are the fixed letters A-D; the answer text rides
 * in the description, ≤300 chars). The Footer's complete action echoes the
 * selected option id back as `answer_id` inside nfm_reply.response_json.
 * Keep screen id 'COMPREHENSION' in sync with COMPREHENSION_FLOW_SCREEN in
 * pp-sketch (interfaces/wabot/outbound/outbound.dto.ts).
 */

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const GRAPH_VERSION = process.env.GRAPH_API_VERSION ?? 'v21.0';
const FLOW_NAME = process.env.FLOW_NAME ?? 'comprehension-mcq-v1';
const FLOW_VARIANT = process.env.FLOW_VARIANT ?? 'mcq';
const PUBLISH = process.env.PUBLISH !== '0';
if (FLOW_VARIANT !== 'mcq' && FLOW_VARIANT !== 'passage') {
  console.error(`FLOW_VARIANT must be mcq or passage (got ${FLOW_VARIANT})`);
  process.exit(1);
}
const WITH_PASSAGE = FLOW_VARIANT === 'passage';

if (!ACCESS_TOKEN || !WABA_ID) {
  console.error(
    'Missing WHATSAPP_ACCESS_TOKEN and/or WHATSAPP_BUSINESS_ACCOUNT_ID',
  );
  process.exit(1);
}

const FLOW_JSON = {
  // Meta freezes Flow JSON versions ~12 months after release ('5.0' now
  // rejected with INVALID_FLOW_JSON_VERSION). 7.3 = current recommended,
  // 2026-08; no breaking changes for the components used here.
  version: '7.3',
  screens: [
    {
      id: 'COMPREHENSION',
      title: 'सवाल',
      terminal: true,
      data: {
        // Passage variant: the reading passage rendered above the question.
        ...(WITH_PASSAGE && {
          passage_text: {
            type: 'string',
            __example__: 'राम के घर एक गाय है। गाय हरी घास खाती है।',
          },
        }),
        question_text: {
          type: 'string',
          __example__: 'कहानी में कौन था?',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
            },
          },
          __example__: [
            { id: 'opt-1', title: 'A', description: 'पहला उत्तर' },
            { id: 'opt-2', title: 'B', description: 'दूसरा उत्तर' },
          ],
        },
      },
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'Form',
            name: 'comprehension_form',
            children: [
              ...(WITH_PASSAGE
                ? [{ type: 'TextBody', text: '${data.passage_text}' }]
                : []),
              {
                type: 'TextBody',
                text: '${data.question_text}',
                // Bold question under the passage (Flow JSON ≥ 5.1).
                ...(WITH_PASSAGE && { markdown: true }),
              },
              {
                type: 'RadioButtonsGroup',
                name: 'answer',
                label: 'जवाब चुनो',
                required: true,
                'data-source': '${data.options}',
              },
              {
                type: 'Footer',
                label: 'जवाब भेजो',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    answer_id: '${form.answer}',
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

const graph = (path) => `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;

// `label` is a static step name for logs — the path itself contains
// env-derived ids (WABA id) and must never be logged (js/clear-text-logging).
async function graphFetch(label, path, init) {
  const response = await fetch(graph(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`${label} → HTTP ${response.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
}

// 1. Find-or-create the draft flow. Flow names are unique per WABA, so a
// failed earlier run leaves a stray draft that would 400 the create with
// "Flow name is not unique" — reuse it instead (uploading the asset again
// replaces the draft's flow JSON). An already-PUBLISHED flow of this name
// is immutable: just print its id and exit (idempotent success).
const listing = await graphFetch(
  'list-flows',
  `${WABA_ID}/flows?fields=id,name,status&limit=200`,
  { method: 'GET' },
);
const existing = (listing.data ?? []).find((f) => f.name === FLOW_NAME);
let flowId;
if (existing && existing.status === 'PUBLISHED') {
  console.log(`Flow "${FLOW_NAME}" already published as ${existing.id}`);
  console.log('');
  console.log('Next step: set on the pp-sketch deployment:');
  console.log(`  WHATSAPP_COMPREHENSION_FLOW_ID=${existing.id}`);
  process.exit(0);
} else if (existing && existing.status === 'DRAFT') {
  flowId = existing.id;
  console.log(`Reusing existing draft flow ${flowId}`);
} else if (existing) {
  console.error(
    `Flow "${FLOW_NAME}" exists with status ${existing.status} — delete it in WhatsApp Manager or pick a new FLOW_NAME.`,
  );
  process.exit(1);
} else {
  const created = await graphFetch('create-flow', `${WABA_ID}/flows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FLOW_NAME, categories: ['OTHER'] }),
  });
  flowId = created.id;
  console.log(`Created draft flow ${flowId}`);
}

// 2. Upload the flow JSON asset.
const form = new FormData();
form.append(
  'file',
  new Blob([JSON.stringify(FLOW_JSON, null, 2)], {
    type: 'application/json',
  }),
  'flow.json',
);
form.append('name', 'flow.json');
form.append('asset_type', 'FLOW_JSON');
const uploaded = await graphFetch('upload-asset', `${flowId}/assets`, {
  method: 'POST',
  body: form,
});
const validationErrors = uploaded.validation_errors ?? [];
if (validationErrors.length > 0) {
  console.error('Flow JSON validation errors — NOT publishing:');
  console.error(JSON.stringify(validationErrors, null, 2));
  console.error(`Draft ${flowId} left unpublished; fix and re-run.`);
  process.exit(1);
}
console.log('Flow JSON uploaded, no validation errors');

if (!PUBLISH) {
  const preview = await graphFetch(
    'preview',
    `${flowId}?fields=preview.invalidate(false)`,
    { method: 'GET' },
  );
  console.log(`Draft ${flowId} left unpublished (PUBLISH=0).`);
  console.log(`Preview: ${preview.preview?.preview_url ?? '(no preview url returned)'}`);
  console.log('Re-run without PUBLISH=0 to publish this draft.');
  process.exit(0);
}

// 3. Publish (irreversible — published flows are immutable).
await graphFetch('publish', `${flowId}/publish`, { method: 'POST' });
console.log(`Published flow ${flowId}`);
console.log('');
console.log('Next step: set on the pp-sketch deployment:');
console.log(`  WHATSAPP_COMPREHENSION_FLOW_ID=${flowId}`);
