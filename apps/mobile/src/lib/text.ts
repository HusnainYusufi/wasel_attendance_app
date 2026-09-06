/**
 * Ends a sentence, if it does not already.
 *
 * Server messages are written as complete sentences but are not contractually
 * guaranteed to carry terminal punctuation. Appending a second sentence to one
 * without checking produces run-ons like "…must keep at least one active
 * administrator Promote somebody else first", which reads as a rendering fault.
 */
function asSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Joins fragments into one paragraph, punctuating each. */
export function sentences(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map(asSentence)
    .join(' ');
}
