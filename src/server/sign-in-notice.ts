import type { Request, Response } from "express";

// What the sign-in page says when someone comes back to it: from GitHub or Microsoft with an
// error, or after signing out. Every message is fixed text written here. From the address,
// the page shows at most an unknown error code, and only when it is plain lowercase letters
// and underscores.

/** One message for the sign-in page. An alert is read out at once by screen readers. */
export type SignInNotice = { text: string; alert: boolean };

/** A way to sign in: GitHub, or Microsoft beside it. */
export type SignInWay = "github" | "microsoft";

/** The ways to sign in, as the pages name them. */
export const WAY_NAMES: Record<SignInWay, string> = { github: "GitHub", microsoft: "Microsoft" };

/**
 * When GitHub shares no verified email address. An unverified address is withheld before the
 * library sees it, so the answer is the same whether or not that address has a person here.
 */
const NO_VERIFIED_EMAIL =
  "GitHub did not share a verified email address for this account. Verify one on GitHub, then sign in again.";

const EXPIRED = "That sign-in expired before GitHub sent you back. Sign in again.";

/** What GitHub or the sign-in library reported, by the code it put in "?error=...". */
const GITHUB_MESSAGES: Record<string, string> = {
  access_denied:
    "You cancelled signing in with GitHub, so nothing was shared. Sign in again when you are ready.",
  state_mismatch: EXPIRED,
  state_not_found: EXPIRED,
  state_invalid: EXPIRED,
  account_not_linked:
    "Your email address already belongs to a different GitHub account here. Sign in with that account.",
  email_not_found: NO_VERIFIED_EMAIL,
  email_not_verified: NO_VERIFIED_EMAIL,
};

/**
 * On a site with both ways in, one email address still belongs to one person, so an address
 * may already belong to someone who signed in the other way. This says so for either way.
 */
const ADDRESS_TAKEN =
  "Your email address already belongs to a different account here. Sign in with the account you used before.";

/** GitHub's messages on a site with both ways in. */
const GITHUB_BESIDE_MICROSOFT: Record<string, string> = {
  ...GITHUB_MESSAGES,
  account_not_linked: ADDRESS_TAKEN,
};

const MICROSOFT_NO_EMAIL =
  "Microsoft did not share a verified email address for this account. Ask whoever runs your organization's Microsoft accounts to add one, then sign in again.";

const MICROSOFT_EXPIRED = "That sign-in expired before Microsoft sent you back. Sign in again.";

/** What Microsoft or the sign-in library reported about a Microsoft sign-in. */
const MICROSOFT_MESSAGES: Record<string, string> = {
  access_denied:
    "You cancelled signing in with Microsoft, so nothing was shared. Sign in again when you are ready.",
  state_mismatch: MICROSOFT_EXPIRED,
  state_not_found: MICROSOFT_EXPIRED,
  state_invalid: MICROSOFT_EXPIRED,
  account_not_linked: ADDRESS_TAKEN,
  email_not_found: MICROSOFT_NO_EMAIL,
  email_not_verified: MICROSOFT_NO_EMAIL,
};

const UNKNOWN_EXPIRED = "That sign-in expired before you were sent back. Sign in again.";

/**
 * On a site with both ways in, a return that lost its sign-in, such as one from a tab left
 * open overnight, does not say which way it was. These messages name neither.
 */
const UNKNOWN_MESSAGES: Record<string, string> = {
  state_mismatch: UNKNOWN_EXPIRED,
  state_not_found: UNKNOWN_EXPIRED,
  state_invalid: UNKNOWN_EXPIRED,
  account_not_linked: ADDRESS_TAKEN,
};

/** An error code that may be shown as it is: lowercase letters and underscores, kept short. */
const PLAIN_CODE = /^[a-z_]{1,64}$/;

/**
 * The message for a failed return from GitHub or Microsoft, or null when the address has no
 * error. siteUrl is this site's own address from the settings, used to name its GitHub
 * callback. way is the way the failed sign-in started, or null when the return does not say.
 * bothWays is true on a site that offers Microsoft beside GitHub.
 */
export function noticeForError(
  error: unknown,
  siteUrl: string | undefined,
  way: SignInWay | null = "github",
  bothWays = false,
): SignInNotice | null {
  if (error === undefined) return null;
  const code = typeof error === "string" ? error : "";
  let messages = UNKNOWN_MESSAGES;
  if (way === "github") messages = bothWays ? GITHUB_BESIDE_MICROSOFT : GITHUB_MESSAGES;
  if (way === "microsoft") messages = MICROSOFT_MESSAGES;
  const message = Object.hasOwn(messages, code) ? messages[code] : undefined;
  if (message !== undefined) return { text: message, alert: true };
  if (code === "redirect_uri_mismatch" && way === "github" && siteUrl !== undefined) {
    const callback = new URL("/api/auth/callback/github", siteUrl).href;
    return {
      text: `GitHub did not accept this site's return address. If you run this site, set your GitHub OAuth app's callback URL to ${callback}.`,
      alert: true,
    };
  }
  const shown = PLAIN_CODE.test(code)
    ? ` If it keeps failing, give the site's owner this code: ${code}.`
    : "";
  const started = way === null ? "Sign-in" : `${WAY_NAMES[way]} sign-in`;
  return { text: `${started} did not finish. Sign in again.${shown}`, alert: true };
}

/** Messages kept for the next sign-in page, after the browser is sent there. */
const LATER_MESSAGES = {
  signedOut:
    "You are signed out. To sign in with a different GitHub account, sign out of GitHub first.",
  signedOutMicrosoft:
    "You are signed out. To sign in with a different Microsoft account, sign out of Microsoft first.",
} as const;

export type LaterNotice = keyof typeof LATER_MESSAGES;

const COOKIE = "sign_in_notice";

/**
 * Remembers a message for the next sign-in page this browser opens. The cookie holds only
 * one of the words above. It lives a minute and is read once.
 */
export function rememberSignInNotice(res: Response, key: LaterNotice): void {
  res.cookie(COOKIE, key, { httpOnly: true, sameSite: "lax", maxAge: 60_000, path: "/" });
}

/** The message kept for this sign-in page, once: reading it clears it. Null when there is none. */
export function takeSignInNotice(req: Request, res: Response): SignInNotice | null {
  const key: unknown = req.cookies?.[COOKIE];
  if (key === undefined) return null;
  res.clearCookie(COOKIE, { path: "/" });
  if (typeof key !== "string" || !Object.hasOwn(LATER_MESSAGES, key)) return null;
  return { text: LATER_MESSAGES[key as LaterNotice], alert: false };
}
