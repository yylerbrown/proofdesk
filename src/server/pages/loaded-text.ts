import { createHash } from "node:crypto";

// The edit form remembers what each box held when it was opened, so a save refused because
// someone else changed the ticket can name only what they changed. It keeps a short fingerprint
// of each box's text rather than a second copy of it, so a long ticket's form stays well under
// the size limit for a request. The fingerprint ignores the spaces around the text and treats a
// browser's CR LF line breaks the same as plain ones, the way a ticket stores its text.

/** A short fingerprint of a box's text, the same for text that a ticket would store the same. */
export function fingerprint(text: string | null): string {
  const plain = (text ?? "").replace(/\r\n?/g, "\n").trim();
  return createHash("sha256").update(plain).digest("hex");
}
