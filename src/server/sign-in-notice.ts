import type { Request, Response } from "express";

// What the sign-in page says when someone comes back to it: from GitHub with an error, or
// after signing out. Every message is fixed text written here. From the address, the page
// shows at most an unknown error code, and only when it is plain lowercase letters and
// underscores.

/** One message for the sign-in page. An alert is read out at once by screen readers. */
export type SignInNotice = { text: string; alert: boolean };

/**
 * When GitHub shares no verified email address. An unverified address is withheld before the
 * library sees it, so the answer is the same whether or not that address has a person here.
 */
const NO_VERIFIED_EMAIL =
  "GitHub did not share a verified email address for this account. Verify one on GitHub, then sign in again.";

/** What GitHub or the sign-in library reported, by the code it put in "?error=...". */
const ERROR_MESSAGES = {
  access_denied:
    "You cancelled signing in with GitHub, so nothing was shared. Sign in again when you are ready.",
  state_mismatch: "That sign-in expired before GitHub sent you back. Sign in again.",
  state_not_found: "That sign-in expired before GitHub sent you back. Sign in again.",
  state_invalid: "That sign-in expired before GitHub sent you back. Sign in again.",
  account_not_linked:
    "Your email address already belongs to a different GitHub account here. Sign in with that account.",
  email_not_found: NO_VERIFIED_EMAIL,
  email_not_verified: NO_VERIFIED_EMAIL,
} as const;

/** An error code that may be shown as it is: lowercase letters and underscores, kept short. */
const PLAIN_CODE = /^[a-z_]{1,64}$/;

/**
 * The message for a failed return from GitHub, or null when the address has no error.
 * siteUrl is this site's own address from the settings, used to name its GitHub callback.
 */
export function noticeForError(error: unknown, siteUrl: string | undefined): SignInNotice | null {
  if (error === undefined) return null;
  const code = typeof error === "string" ? error : "";
  if (Object.hasOwn(ERROR_MESSAGES, code)) {
    return { text: ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES], alert: true };
  }
  if (code === "redirect_uri_mismatch" && siteUrl !== undefined) {
    const callback = new URL("/api/auth/callback/github", siteUrl).href;
    return {
      text: `GitHub did not accept this site's return address. If you run this site, set your GitHub OAuth app's callback URL to ${callback}.`,
      alert: true,
    };
  }
  const shown = PLAIN_CODE.test(code)
    ? ` If it keeps failing, give the site's owner this code: ${code}.`
    : "";
  return { text: `GitHub sign-in did not finish. Sign in again.${shown}`, alert: true };
}

/** Messages kept for the next sign-in page, after the browser is sent there. */
const LATER_MESSAGES = {
  signedOut:
    "You are signed out. To sign in with a different GitHub account, sign out of GitHub first.",
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
