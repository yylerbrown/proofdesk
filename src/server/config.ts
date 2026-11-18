import { z } from "zod";

// A list of GitHub user numbers separated by commas, for example "1234,5678". The number
// of a GitHub account never changes, unlike its user name.
const githubIds = z
  .string()
  .regex(/^\d+(,\d+)*$/, "must be GitHub user numbers separated by commas")
  .optional()
  .transform((value) => (value === undefined ? [] : value.split(",")));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("./data/app.db"),
  GIT_COMMIT: z.string().min(1).optional(),
  TICKET_PREFIX: z
    .string()
    .regex(/^[A-Z]{2,6}$/, "must be 2 to 6 capital letters")
    .default("SUP"),
  DEV_SIGN_IN: z.enum(["on", "off"]).default("off"),
  DEMO: z.enum(["on", "off"]).default("off"),
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
  BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  CLIENT_IP_HEADER: z
    .string()
    .regex(/^[a-z0-9-]+$/, "must be a header name in lower case, for example fly-client-ip")
    .optional(),
  TEAM_GITHUB_IDS: githubIds,
  ADMIN_GITHUB_IDS: githubIds,
  // The demo's address, offered on the real site's sign-in page to try it without signing in.
  DEMO_URL: z.url({ protocol: /^https$/ }).optional(),
  // On the demo: the real site's address, where GitHub sign-in with roles runs.
  REAL_SITE_URL: z.url({ protocol: /^https$/ }).optional(),
  // The repository's https address, for the "Source and setup" link to its README.
  SOURCE_URL: z.url({ protocol: /^https$/ }).optional(),
  // The address people and assistants reach this server at, given in the commands to paste.
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  // The mail server that email notices are sent through, for example
  // smtps://user:password@mail.example.com:465. Set together with MAIL_FROM, or not at all.
  SMTP_URL: z
    .url({ protocol: /^smtps?$/, error: "must be an smtp:// or smtps:// address" })
    .optional(),
  // The address notices are sent from, for example notices@example.com.
  MAIL_FROM: z.email({ error: "must be an email address" }).optional(),
});

const SIGN_IN_NAMES = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;

/** The two settings email notices need. They are set together or not at all. */
export type MailConfig = {
  /** The mail server's address. It may hold a password, so it is never logged or shown. */
  smtpUrl: string;
  /** The address notices are sent from. */
  from: string;
};

/** The four settings GitHub sign-in needs. They are set together or not at all. */
export type SignInConfig = {
  secret: string;
  baseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
};

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databasePath: string;
  gitCommit: string | undefined;
  ticketPrefix: string;
  /** True when the development entrance is open: anyone can pick who they are. */
  devSignIn: boolean;
  /** True when this server is the public demo: sample data and made-up people, no real sign-in. */
  demo: boolean;
  /** GitHub sign-in settings, or null when they are not set. */
  signIn: SignInConfig | null;
  /** The demo's address, linked from the sign-in page of a server that is not the demo. */
  demoUrl: string | undefined;
  /** On the demo: the real site's address, linked as where GitHub sign-in runs. */
  realSiteUrl: string | undefined;
  /** The repository's https address, for a link to its README. Optional. */
  sourceUrl: string | undefined;
  /** The address people and assistants reach this server at. Optional. */
  publicUrl: string | undefined;
  /**
   * A header that the host's proxy sets to the visitor's address, or undefined to use the
   * address of the connection. Behind a proxy the connection always comes from the proxy.
   */
  clientIpHeader: string | undefined;
  teamGithubIds: string[];
  adminGithubIds: string[];
  /** The mail server for email notices, or null when none is set. Always null on the demo. */
  mail: MailConfig | null;
};

/** Parses and validates environment variables. Throws a readable error when invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse({
    NODE_ENV: env.NODE_ENV || undefined,
    PORT: env.PORT || undefined,
    DATABASE_PATH: env.DATABASE_PATH || undefined,
    GIT_COMMIT: env.GIT_COMMIT || undefined,
    TICKET_PREFIX: env.TICKET_PREFIX || undefined,
    DEV_SIGN_IN: env.DEV_SIGN_IN || undefined,
    DEMO: env.DEMO || undefined,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET || undefined,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL || undefined,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID || undefined,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET || undefined,
    CLIENT_IP_HEADER: env.CLIENT_IP_HEADER || undefined,
    TEAM_GITHUB_IDS: env.TEAM_GITHUB_IDS || undefined,
    ADMIN_GITHUB_IDS: env.ADMIN_GITHUB_IDS || undefined,
    DEMO_URL: env.DEMO_URL || undefined,
    REAL_SITE_URL: env.REAL_SITE_URL || undefined,
    SOURCE_URL: env.SOURCE_URL || undefined,
    PUBLIC_URL: env.PUBLIC_URL || undefined,
    SMTP_URL: env.SMTP_URL || undefined,
    MAIL_FROM: env.MAIL_FROM || undefined,
  });
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const data = result.data;
  if (data.NODE_ENV === "production" && data.DEV_SIGN_IN === "on") {
    throw new Error(
      "Invalid environment configuration: DEV_SIGN_IN must not be on in production. " +
        "It lets anyone act as an admin.",
    );
  }
  // The sign-in settings come as a set: all four, or none.
  const missing = SIGN_IN_NAMES.filter((name) => data[name] === undefined);
  if (missing.length > 0 && missing.length < SIGN_IN_NAMES.length) {
    throw new Error(`Invalid environment configuration: also set ${missing.join(", ")}.`);
  }
  // The development entrance lets anyone pick who they are, the admin included. A server
  // that signs real people in through GitHub never offers it, whatever NODE_ENV says.
  if (data.DEV_SIGN_IN === "on" && missing.length === 0) {
    throw new Error(
      "Invalid environment configuration: DEV_SIGN_IN must not be on together with the " +
        "GitHub sign-in settings. It lets anyone act as an admin.",
    );
  }
  // The demo is fenced off: it never has real sign-in, so it can never hold a real account,
  // and it is a separate server with its own database.
  if (data.DEMO === "on" && missing.length === 0) {
    throw new Error(
      "Invalid environment configuration: DEMO must not be on together with the GitHub " +
        "sign-in settings. The demo runs as its own server with its own database.",
    );
  }
  if (data.DEMO === "on" && data.DEV_SIGN_IN === "on") {
    throw new Error("Invalid environment configuration: turn on DEMO or DEV_SIGN_IN, not both.");
  }
  if (data.NODE_ENV === "production" && missing.length > 0 && data.DEMO !== "on") {
    throw new Error(
      `Invalid environment configuration: sign-in is required in production. ` +
        `Set ${missing.join(", ")}.`,
    );
  }
  const url = data.BETTER_AUTH_URL;
  if (data.NODE_ENV === "production" && url !== undefined && !url.startsWith("https://")) {
    throw new Error(
      "Invalid environment configuration: BETTER_AUTH_URL must start with https:// in " +
        "production. Over plain http the session cookie would travel unprotected.",
    );
  }
  // The mail settings come as a pair: both, or neither.
  if ((data.SMTP_URL === undefined) !== (data.MAIL_FROM === undefined)) {
    const other = data.SMTP_URL === undefined ? "SMTP_URL" : "MAIL_FROM";
    throw new Error(`Invalid environment configuration: also set ${other}, or neither.`);
  }
  const signIn =
    missing.length > 0
      ? null
      : {
          secret: data.BETTER_AUTH_SECRET!,
          baseUrl: data.BETTER_AUTH_URL!,
          githubClientId: data.GITHUB_CLIENT_ID!,
          githubClientSecret: data.GITHUB_CLIENT_SECRET!,
        };

  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    databasePath: data.DATABASE_PATH,
    gitCommit: data.GIT_COMMIT,
    ticketPrefix: data.TICKET_PREFIX,
    devSignIn: data.DEV_SIGN_IN === "on",
    demo: data.DEMO === "on",
    signIn,
    demoUrl: data.DEMO === "on" ? undefined : data.DEMO_URL,
    realSiteUrl: data.DEMO === "on" ? data.REAL_SITE_URL : undefined,
    sourceUrl: data.SOURCE_URL?.replace(/\/+$/, ""),
    publicUrl: data.PUBLIC_URL?.replace(/\/+$/, ""),
    clientIpHeader: data.CLIENT_IP_HEADER,
    teamGithubIds: data.TEAM_GITHUB_IDS,
    adminGithubIds: data.ADMIN_GITHUB_IDS,
    // The demo never sends email, whatever is set.
    mail:
      data.DEMO === "on" || data.SMTP_URL === undefined || data.MAIL_FROM === undefined
        ? null
        : { smtpUrl: data.SMTP_URL, from: data.MAIL_FROM },
  };
}
