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
