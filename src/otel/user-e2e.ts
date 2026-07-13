// Shared constants + Redis key builders for the user_e2e SLO metric
// (otel/metrics.ts). Kept dependency-free so both the outbound service
// (writer) and the status processor (consumer) can import without cycles.

const env = process.env.ENV ?? 'development';

// How long a reply-wamid → send-timestamp mapping may wait for its
// delivered status. Statuses later than this would be `late` anyway;
// 15 min comfortably covers Meta status batching without hoarding keys.
export const USER_E2E_MAPPING_TTL_S = 900;

// Delivered-status delta above this records outcome="late" instead of
// "delivered" (offline phones produce hours-long tails that would wreck
// the histogram's percentiles).
export const USER_E2E_LATE_THRESHOLD_MS = 60_000;

// Sent-marker TTL: only needs to outlive the +20 s timeout fallback job's
// claim attempt (see message.processor / outbound sendMessage claim miss).
export const SENT_MARKER_TTL_S = 60;

// Payload stored under userE2eKey. lt/tp mirror the W3C baggage labels the
// rest of the pipeline uses; they ride through Redis because Meta's status
// webhook carries no baggage.
export interface UserE2eMapping {
  ts: number; // original user-message timestamp, ms (Meta clock)
  lt: string; // 'true' | 'false' — load_test label
  tp?: string; // test_phase label, load tests only
}

export function userE2eKey(replyWamid: string): string {
  return `{wabot:${env}}:user-e2e:wamid:${replyWamid}`;
}

export function sentMarkerKey(originalWamid: string): string {
  return `{wabot:${env}}:sent:wamid:${originalWamid}`;
}
