// Structured logging (Phase 6). One JSON line per event, always carrying incidentId, so
// `wrangler tail` output (or any log sink) can be filtered back to a single investigation even
// with several running concurrently across Durable Object instances.

export type LogFields = Record<string, string | number | boolean | null>;

export function logEvent(incidentId: string, event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ ts: Date.now(), incidentId, event, ...fields }));
}
