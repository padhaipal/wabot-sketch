import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('wabot');

export const messageE2eDuration = meter.createHistogram(
  'wabot.message.e2e_duration_ms',
  {
    description:
      'End-to-end milliseconds from WhatsApp message timestamp to wabot processing completion.',
    unit: 'ms',
  },
);
