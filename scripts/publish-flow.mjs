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

if (!ACCESS_TOKEN || !WABA_ID) {
  console.error(
    'Missing WHATSAPP_ACCESS_TOKEN and/or WHATSAPP_BUSINESS_ACCOUNT_ID',
  );
  process.exit(1);
}

const FLOW_JSON = {
  version: '5.0',
  screens: [
    {
      id: 'COMPREHENSION',
      title: 'सवाल',
      terminal: true,
      data: {
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
              {
                type: 'TextBody',
                text: '${data.question_text}',
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

// 1. Create the draft flow.
const created = await graphFetch('create-flow', `${WABA_ID}/flows`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: FLOW_NAME, categories: ['OTHER'] }),
});
const flowId = created.id;
console.log(`Created draft flow ${flowId}`);

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

// 3. Publish (irreversible — published flows are immutable).
await graphFetch('publish', `${flowId}/publish`, { method: 'POST' });
console.log(`Published flow ${flowId}`);
console.log('');
console.log('Next step: set on the pp-sketch deployment:');
console.log(`  WHATSAPP_COMPREHENSION_FLOW_ID=${flowId}`);
