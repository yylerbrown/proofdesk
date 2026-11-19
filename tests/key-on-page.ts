// Reads a new key from the page that made it. The key appears in the message to paste into an
// AI agent, after "Bearer", and nowhere else outside the folded manual setup.

/** The key shown on a key page's HTML. Fails the test when there is none. */
export function keyOnPage(html: string): string {
  const key = /Bearer (pd_[0-9a-f]{8}_[A-Za-z0-9_-]{32})/.exec(html)?.[1];
  if (key === undefined) throw new Error("The page shows no key.");
  return key;
}
