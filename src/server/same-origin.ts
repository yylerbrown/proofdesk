import type { RequestHandler } from "express";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";

/**
 * Refuses a request that changes something unless the browser says it comes from this
 * site. This is the defence against forged cross-site requests: a page on another site
 * making a signed-in visitor's browser post a form here.
 *
 * A browser states where a request comes from in two headers that a page cannot fake.
 * "Sec-Fetch-Site" says it outright and is trusted when present. Older browsers send only
 * "Origin", which must then be this site's own address. A request that states neither is
 * refused: nothing legitimate here needs to hide where it comes from.
 */
export function sameOriginOnly(config: Config): RequestHandler {
  // The address people open in the browser, for example "https://desk.example". It is
  // known when sign-in is configured. Without it, Origin is compared with the Host header.
  const ownOrigin = config.signIn === null ? null : new URL(config.signIn.baseUrl).origin;

  return (req, _res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    // An agent signed in with its connection key in the Authorization header. A browser never
    // adds that header by itself, so another site cannot forge such a request.
    if (req.actor?.kind === "agent") {
      next();
      return;
    }
    const site = req.get("Sec-Fetch-Site");
    const origin = req.get("Origin");
    let fromThisSite = false;
    if (site !== undefined) {
      // "none" means the person started it themselves, for example from the address bar.
      fromThisSite = site === "same-origin" || site === "none";
    } else if (origin !== undefined) {
      fromThisSite =
        ownOrigin === null ? isThisHost(origin, req.get("Host")) : origin === ownOrigin;
    }
    if (!fromThisSite) {
      throw new HttpError(403, "cross_site_request", "This request did not come from this site.");
    }
    next();
  };
}

/** True when an Origin such as "https://example.com" names the host this request was sent to. */
function isThisHost(origin: string, host: string | undefined): boolean {
  return URL.canParse(origin) && new URL(origin).host === host;
}
