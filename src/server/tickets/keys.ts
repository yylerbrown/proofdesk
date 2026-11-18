/** Builds the public key of a ticket, for example buildKey("SUP", 42) gives "SUP-42". */
export function buildKey(prefix: string, id: number): string {
  return `${prefix}-${id}`;
}

/**
 * Turns a public key back into the ticket number. Returns null when the key does not have
 * the form PREFIX-NUMBER, when the prefix differs, or when the number is not a positive
 * whole number without leading zeros.
 */
export function parseKey(prefix: string, key: string): number | null {
  const start = `${prefix}-`;
  if (!key.startsWith(start)) return null;
  const digits = key.slice(start.length);
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  const id = Number(digits);
  if (!Number.isSafeInteger(id)) return null;
  return id;
}
