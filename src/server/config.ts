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
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databasePath: string;
  gitCommit: string | undefined;
  ticketPrefix: string;
};

/** Parses and validates environment variables. Throws a readable error when invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse({
    NODE_ENV: env.NODE_ENV || undefined,
    PORT: env.PORT || undefined,
    DATABASE_PATH: env.DATABASE_PATH || undefined,
    GIT_COMMIT: env.GIT_COMMIT || undefined,
    TICKET_PREFIX: env.TICKET_PREFIX || undefined,
  });
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const data = result.data;
  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    databasePath: data.DATABASE_PATH,
    gitCommit: data.GIT_COMMIT,
    ticketPrefix: data.TICKET_PREFIX,
  };
}
