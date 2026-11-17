import type { z } from "zod";
import { HttpError } from "./errors.js";

/** Checks a value against a zod schema, or throws a 400 that lists what is wrong. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ");
    throw new HttpError(400, "validation_error", details);
  }
  return result.data;
}
