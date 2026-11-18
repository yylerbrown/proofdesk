import { betterAuth } from "better-auth";
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
      github: { clientId: signIn.githubClientId, clientSecret: signIn.githubClientSecret },
    },
    // One person, one GitHub account. By default the library would attach a second GitHub
    // account to an existing person when both show the same verified email address. Roles
    // are decided by the GitHub account, so that would let a different account inherit
    // someone's role.
    account: { accountLinking: { enabled: false } },
    // The library's own rate limits count per visitor address. Behind a proxy it must read
    // that address from the header the proxy sets.
    advanced:
      clientIpHeader === undefined ? {} : { ipAddress: { ipAddressHeaders: [clientIpHeader] } },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

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
