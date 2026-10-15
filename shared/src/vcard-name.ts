/**
 * Contact-card name rules (v1.42.0), one module for the serializer
 * (`qr.ts`), the QR search fields (`search.ts`) and the dashboard form. Kept
 * apart from `qr.ts` because `qr.ts` imports `search.ts`: a function here can
 * be used by both without an import cycle.
 */

/** A stored or form value as text: a string, else empty. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Whether a value is filled: text that is not blank. */
export function isFilled(value: unknown): boolean {
  return text(value).trim() !== '';
}

/** A contact card's name fields, read loosely (stored records and form state alike). */
export interface VcardNameFields {
  firstName?: unknown;
  surname?: unknown;
  displayName?: unknown;
  name?: unknown;
}

/** "First Surname": the first name and surname, trimmed, either one alone. */
export function vcardGivenAndSurname(card: VcardNameFields): string {
  return [text(card.firstName).trim(), text(card.surname).trim()].filter(Boolean).join(' ');
}

/** Whether a card has a name a write accepts: a filled first name, surname, or display name. */
export function vcardHasName(card: VcardNameFields): boolean {
  return [card.firstName, card.surname, card.displayName].some(isFilled);
}

/**
 * The name a contact card shows (its vCard FN): the display name, else the
 * legacy name, else "First Surname". Trimmed; empty only for a stored legacy
 * card whose name is blank.
 */
export function vcardFullName(card: VcardNameFields): string {
  return text(card.displayName).trim() || text(card.name).trim() || vcardGivenAndSurname(card);
}
