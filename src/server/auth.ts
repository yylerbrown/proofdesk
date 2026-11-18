import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import type { Role } from "./actor.js";
import type { Config, SignInConfig } from "./config.js";
import type { Db } from "./db.js";

/**
 * Builds the sign-in library (Better Auth) with GitHub as the only way in. It keeps people
 * and sessions in the same database, in the tables of migration 0006.
 */
export function createAuth(db: Db, signIn: SignInConfig, clientIpHeader: string | undefined) {
  return betterAuth({
    database: db,
    secret: signIn.secret,
    baseURL: signIn.baseUrl,
    socialProviders: {
      github: {
        clientId: signIn.githubClientId,
        clientSecret: signIn.githubClientSecret,
        // Only the permission to read the person's email addresses. Who they are needs no
        // permission at all. The library's default also asks for read:user, which reads
        // private profile data the app never uses.
        disableDefaultScope: true,
        scope: ["user:email"],
        // Names come only from GitHub, where a display name can be very long or empty.
        mapProfileToUser: (profile) => ({ name: shownName(profile.name, profile.login) }),
      },
    },
    // One person, one GitHub account. By default the library would attach a second GitHub
    // account to an existing person when both show the same verified email address. Roles
    // are decided by the GitHub account, so that would let a different account inherit
    // someone's role.
    // The GitHub access token is only needed during sign-in. It is kept encrypted with the
    // secret, so a copy of the database does not hand out working GitHub tokens.
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    // A session ends seven days after sign-in, however much it is used. By default the
    // library would extend a session in use once a day, so one used every week never ended.
    session: { expiresIn: 7 * 24 * 60 * 60, disableSessionRefresh: true },
    databaseHooks: {
      user: {
        create: {
          // A person is created only with an email address GitHub has verified. Each address
          // belongs to one person here, so an account showing someone else's address first
          // would lock its real owner out. Thrown before the row is written, the refusal
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

/** The most characters of a GitHub display name that are kept. */
const NAME_LIMIT = 100;

/**
 * The name kept for a person: their GitHub display name cut to NAME_LIMIT characters, or
 * their GitHub login when the display name is empty or only spaces. Array.from splits the
 * name into whole characters, so the cut never leaves half of one, such as half an emoji.
 */
function shownName(name: string | null, login: string): string {
  const trimmed = (name ?? "").trim();
  const chosen = trimmed === "" ? login : trimmed;
  return Array.from(chosen).slice(0, NAME_LIMIT).join("");
}

/** The GitHub user number of a signed-in person, or undefined if they have no GitHub account. */
export function githubIdOf(db: Db, userId: string): string | undefined {
  const row = db
    .prepare(`SELECT "accountId" FROM "account" WHERE "userId" = ? AND "providerId" = 'github'`)
    .get(userId) as { accountId: string } | undefined;
  return row?.accountId;
}

/**
 * The role of a GitHub user number. Admins and team members are named in configuration.
 * Everyone else who signs in is a customer.
 */
export function roleOf(config: Config, githubId: string | undefined): Role {
  if (githubId !== undefined && config.adminGithubIds.includes(githubId)) return "admin";
  if (githubId !== undefined && config.teamGithubIds.includes(githubId)) return "team";
  return "customer";
}
