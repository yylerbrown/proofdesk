import { z } from "zod";

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
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databasePath: string;
  gitCommit: string | undefined;
  ticketPrefix: string;
  /** True when the development entrance is open: anyone can pick who they are. */
  devSignIn: boolean;
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
  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    databasePath: data.DATABASE_PATH,
    gitCommit: data.GIT_COMMIT,
    ticketPrefix: data.TICKET_PREFIX,
    devSignIn: data.DEV_SIGN_IN === "on",
  };
}
