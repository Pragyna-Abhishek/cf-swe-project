// Hard caps applied to attacker-controlled strings before they can reach a prompt or the UI.
// See DESIGN.md section 11, mitigation 3.

export const MAX_ATTRIBUTE_CHARS = 120;
export const MAX_SYMPTOM_CHARS = 500;

/** Strip control characters and cap length. Marks truncation so it is visible, not silent. */
export function sanitizeAttribute(value: string, max = MAX_ATTRIBUTE_CHARS): string {
  let cleaned = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 and C1 control characters, and the two Unicode line separators.
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    if (!control) cleaned += ch;
  }
  return cleaned.length > max ? `${cleaned.slice(0, max)}...[truncated]` : cleaned;
}

export type SymptomCheck = { ok: true; symptom: string } | { ok: false; reason: string };

/** The operator's chat message is untrusted too. Rejected above the cap, never truncated. */
export function checkSymptom(input: unknown): SymptomCheck {
  if (typeof input !== "string") return { ok: false, reason: "symptom must be a string" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "symptom is empty" };
  if (trimmed.length > MAX_SYMPTOM_CHARS) {
    return { ok: false, reason: `symptom is longer than ${MAX_SYMPTOM_CHARS} characters` };
  }
  return { ok: true, symptom: sanitizeAttribute(trimmed, MAX_SYMPTOM_CHARS) };
}
