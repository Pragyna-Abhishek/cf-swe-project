// Evidence citation checking. A hypothesis or report cites evidence IDs inline in its text
// (e.g. "the ASN breakdown (ev_4) shows..."); this extracts them and checks each one is real,
// so a fabricated citation is a detected failure rather than something the UI renders as if it
// were backed by data. DESIGN.md section 9, "Evidence IDs are validated."

const CITATION_PATTERN = /\bev_[a-zA-Z0-9_]+\b/g;

/** Every evidence ID token that appears in `text`, in order, de-duplicated. */
export function extractCitations(text: string): string[] {
  const found = text.match(CITATION_PATTERN) ?? [];
  return [...new Set(found)];
}

export type CitationCheck = { ok: true } | { ok: false; fabricated: string[] };

/** Every citation in `text` must be a member of `knownIds`. */
export function checkCitations(text: string, knownIds: ReadonlySet<string>): CitationCheck {
  const fabricated = extractCitations(text).filter((id) => !knownIds.has(id));
  return fabricated.length === 0 ? { ok: true } : { ok: false, fabricated };
}
