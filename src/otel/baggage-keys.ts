// W3C Baggage entries that wabot propagates and surfaces on signals
// (spans, metrics, logs). Centralized so producers (message.processor,
// accept.controller) and consumers (BaggageSpanProcessor, OtelLogger,
// metric record helpers) all agree on the exact set of forwarded keys.

export const BAGGAGE_LOAD_TEST = 'padhaipal.load_test';
export const BAGGAGE_TEST_PHASE = 'padhaipal.test_phase';

export const PROPAGATED_BAGGAGE_KEYS = [
  BAGGAGE_LOAD_TEST,
  BAGGAGE_TEST_PHASE,
] as const;
