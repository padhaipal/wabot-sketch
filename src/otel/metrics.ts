import { metrics } from '@opentelemetry/api';

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
