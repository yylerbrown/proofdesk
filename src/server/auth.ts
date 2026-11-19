import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { parseStringBoolean, verifyProviderIdToken } from "better-auth/oauth2";
import {
  type GithubOptions,
  type GithubProfile,
  github,
  type MicrosoftEntraIDProfile,
  type MicrosoftOptions,
  microsoft,
} from "better-auth/social-providers";
import type { Role } from "./actor.js";
import type { Config, MicrosoftConfig, SignInConfig } from "./config.js";
import type { Db } from "./db.js";
import type { SignInWay } from "./sign-in-notice.js";

/**
 * Builds the sign-in library (Better Auth) with GitHub as the way in, and Microsoft beside it
 * when its settings are present. It keeps people and sessions in the same database, in the
 * tables of migration 0006.
 */
export function createAuth(db: Db, signIn: SignInConfig, clientIpHeader: string | undefined) {
  const githubSettings = {
    clientId: signIn.githubClientId,
    clientSecret: signIn.githubClientSecret,
    // Only the permission to read the person's email addresses. Who they are needs no
    // permission at all. The library's default also asks for read:user, which reads
    // private profile data the app never uses.
    disableDefaultScope: true,
    scope: ["user:email"],
    // Names come only from GitHub, where a display name can be very long or empty.
    mapProfileToUser: (profile: GithubProfile) => ({
      name: shownName(profile.name, profile.login),
    }),
  } satisfies GithubOptions;
  // GitHub asked the library's own way, so the app can look at the answer before the library.
  const askGithub = github(githubSettings);

  /**
   * Who came back from GitHub. The library looks up the email address GitHub reports before
   * anything else runs, and answers differently when that address already has a person here.
   * So an address GitHub has not verified is withheld: the library then sends the browser to
   * the sign-in page with error=email_not_found, whether or not the address is known here.
   * Someone who already signed in with this GitHub account is found by the account, not the
   * address, so they keep their way in.
   */
  async function whoCameBack(token: Parameters<typeof askGithub.getUserInfo>[0]) {
    const info = await askGithub.getUserInfo(token);
    if (info === null || info.user.emailVerified === true) return info;
    if (hasAccount(db, "github", String(info.data.id))) return info;
    return { ...info, user: { ...info.user, email: null } };
  }

  return betterAuth({
    database: db,
    secret: signIn.secret,
    baseURL: signIn.baseUrl,
    socialProviders: {
      github: { ...githubSettings, getUserInfo: whoCameBack },
      ...(signIn.microsoft === null ? {} : { microsoft: microsoftProvider(db, signIn.microsoft) }),
    },
    // One person, one GitHub account. By default the library would attach a second GitHub
    // account to an existing person when both show the same verified email address. Roles
    // are decided by the GitHub account, so that would let a different account inherit
    // someone's role.
    // GitHub's tokens are needed only during sign-in, and the account hooks below keep none
    // of them. Encryption with the secret stays on as a second guard, should one ever be
    // written.
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    // A session ends seven days after sign-in, however much it is used. By default the
    // library would extend a session in use once a day, so one used every week never ended.
    session: { expiresIn: 7 * 24 * 60 * 60, disableSessionRefresh: true },
    databaseHooks: {
      // GitHub's tokens are used once, to read who the person is, and the app never calls
      // GitHub after that. So no account row keeps them, and a copy of the database hands out
      // no GitHub token. The library updates the account row at every sign-in, so a token an
      // earlier version stored goes at that person's next sign-in.
      account: {
        create: { before: async () => withoutTokens() },
        update: { before: async () => withoutTokens() },
      },
      user: {
        create: {
          // A person is created only with an email address GitHub has verified. Each address
          // belongs to one person here, so an account showing someone else's address first
          // would lock its real owner out. whoCameBack above already withholds such an
          // address, so this is a second guard. Thrown before the row is written, the refusal
          // sends the browser to the sign-in page with error=email_not_verified.
          before: async (user) => {
            if (user.emailVerified !== true) {
              throw new APIError("FORBIDDEN", {
                code: "email_not_verified",
                message: "Verify your email address on GitHub, then sign in again.",
              });
            }
          },
        },
      },
    },
    // Where a GitHub return goes when it fails before the library knows which sign-in it
    // belongs to, for example from a GitHub tab left open overnight: the sign-in page, with
    // the reason as error=..., like every other failed sign-in. Without this the library
    // would send it to its own error page, which is not offered.
    onAPIError: { errorURL: new URL("/sign-in", signIn.baseUrl).href },
    // The library's own rate limits count per visitor address. Behind a proxy it must read
    // that address from the header the proxy sets.
    advanced:
      clientIpHeader === undefined ? {} : { ipAddress: { ipAddressHeaders: [clientIpHeader] } },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Microsoft sign-in for one organization: the tenant in the settings. The library's own
 * Microsoft provider asks that tenant's sign-in page and token address, never the shared
 * ones that take any Microsoft account.
 */
function microsoftProvider(db: Db, settings: MicrosoftConfig) {
  const microsoftSettings = {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    tenantId: settings.tenantId,
    // Only who the person is, their name and their email address. The library's default
    // also asks to read their Microsoft profile and to keep signing in without them
    // (offline_access), which the app never does.
    disableDefaultScope: true,
    scope: ["openid", "profile", "email"],
    // Reading the profile picture needs a further permission, so there is no picture.
    disableProfilePhoto: true,
    mapProfileToUser: (profile: MicrosoftEntraIDProfile) => ({
      name: shownName(profile.name, profile.preferred_username ?? ""),
    }),
  } satisfies MicrosoftOptions;
  // Microsoft asked the library's own way, so the app can check the answer before the library.
  const askMicrosoft = microsoft(microsoftSettings);

  /**
   * Who came back from Microsoft. Microsoft's answer holds an ID token, signed by Microsoft,
   * that says who the person is and which organization signed them in. It is checked here:
   * Microsoft's signature, that it was made for this app, by the tenant in the settings,
   * within the last hour. Anything else signs nobody in, and the browser goes to the sign-in
   * page with error=unable_to_get_user_info.
   *
   * As with GitHub, an email address Microsoft has not verified is withheld, so the library
   * sends the browser to the sign-in page with error=email_not_found. Microsoft calls an
   * address verified with an optional claim of the app registration: email_verified, the
   * verified address lists, or xms_edov, which says the organization owns the address's
   * domain.
   */
  async function whoCameBack(token: Parameters<typeof askMicrosoft.getUserInfo>[0]) {
    if (token.idToken === undefined) return null;
    const genuine = await verifyProviderIdToken(askMicrosoft, token.idToken);
    if (!genuine) return null;
    const info = await askMicrosoft.getUserInfo(token);
    if (info === null || info.data.tid !== settings.tenantId) return null;
    const domainOwned = parseStringBoolean(info.data.xms_edov) === true;
    if (info.user.emailVerified === true || domainOwned) {
      return { ...info, user: { ...info.user, emailVerified: true } };
    }
    if (hasAccount(db, "microsoft", info.data.oid)) return info;
    return { ...info, user: { ...info.user, email: null } };
  }

  return { ...microsoftSettings, getUserInfo: whoCameBack };
}

/** What an account hook writes over GitHub's tokens, in place of what the library would. */
function withoutTokens() {
  return { data: { accessToken: null, refreshToken: null, idToken: null } };
}

/** The most characters of a GitHub display name that are kept. */
const NAME_LIMIT = 100;

/**
 * Splits text into the characters a reader sees. A flag, an emoji with a skin tone or a
 * family emoji is made of several joined together, and counts as one.
 */
const readerCharacters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The name kept for a person: their display name cut to NAME_LIMIT characters, or their
 * GitHub login or Microsoft sign-in name when the display name is empty or only spaces. The cut counts the
 * characters a reader sees, so it never leaves half of one, such as half a flag.
 */
function shownName(name: string | null, login: string): string {
  const trimmed = (name ?? "").trim();
  const chosen = trimmed === "" ? login : trimmed;
  return Array.from(readerCharacters.segment(chosen), (part) => part.segment)
    .slice(0, NAME_LIMIT)
    .join("");
}

/**
 * True when someone here has already signed in this way with this account: a GitHub user
 * number, or a Microsoft account's object id.
 */
function hasAccount(db: Db, way: SignInWay, accountId: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM "account" WHERE "providerId" = ? AND "accountId" = ?`)
    .get(way, accountId);
  return row !== undefined;
}

/** How a signed-in person signed in, or undefined for someone with no account here. */
export function signInWayOf(db: Db, userId: string): SignInWay | undefined {
  const row = db.prepare(`SELECT "providerId" FROM "account" WHERE "userId" = ?`).get(userId) as
    { providerId: string } | undefined;
  if (row?.providerId === "github" || row?.providerId === "microsoft") return row.providerId;
  return undefined;
}

/** The GitHub user number of a signed-in person, or undefined if they have no GitHub account. */
export function githubIdOf(db: Db, userId: string): string | undefined {
  const row = db
    .prepare(`SELECT "accountId" FROM "account" WHERE "userId" = ? AND "providerId" = 'github'`)
    .get(userId) as { accountId: string } | undefined;
  return row?.accountId;
}

/**
 * The role the server settings give a GitHub user number, or undefined when neither
 * ADMIN_GITHUB_IDS nor TEAM_GITHUB_IDS names it. A role set there cannot be changed in the
 * product, so the site can never lock its own admins out.
 */
export function settingsRoleOf(config: Config, githubId: string | undefined): Role | undefined {
  if (githubId !== undefined && config.adminGithubIds.includes(githubId)) return "admin";
  if (githubId !== undefined && config.teamGithubIds.includes(githubId)) return "team";
  return undefined;
}

/**
 * The one answer to "what is this person's role": the server settings first, then the role
 * an admin chose on the People page, otherwise customer. It is asked on every request, so a
 * change applies on the person's next page with no restart.
 */
export function roleOf(config: Config, githubId: string | undefined, chosen: Role | null): Role {
  return settingsRoleOf(config, githubId) ?? chosen ?? "customer";
}
