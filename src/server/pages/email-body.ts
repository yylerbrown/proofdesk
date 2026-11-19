// The body of an email notice, cut into pieces for the notices page, so the link to the ticket
// can be pressed there as it would be in a mail program. Only the address of the email's own
// ticket becomes a link, and it opens that ticket's page on this site. Every other web address,
// such as one a customer typed, stays plain text.

/** One piece of an email's body: plain text, or the ticket's address with the page it opens. */
export type EmailBodyPart = { text: string; href: string | null };

/** Every run of text that starts like a web address and has no space in it. */
const WEB_ADDRESS = /(https?:\/\/\S+)/;

/** The ticket's page when the address points to it, or null for any other text. */
function ticketPathOf(text: string, ticketPath: string): string | null {
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  if (url.pathname !== ticketPath || url.search !== "" || url.hash !== "") return null;
  return ticketPath;
}

/** The body of one ticket's email as pieces in order. Joined together they are the body exactly. */
export function emailBodyParts(body: string, ticketKey: string): EmailBodyPart[] {
  const ticketPath = `/tickets/${ticketKey}`;
  const parts: EmailBodyPart[] = [];
  // Splitting on a pattern with brackets keeps each address as a piece of its own.
  for (const piece of body.split(WEB_ADDRESS)) {
    if (piece === "") continue;
    parts.push({ text: piece, href: ticketPathOf(piece, ticketPath) });
  }
  return parts;
}
