import { z } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Checks a value against a zod schema and returns the cleaned value, or throws a 400
 * ValidationError that says what is wrong, both as one line and per field.
 */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ");
    throw new ValidationError(details, z.flattenError(result.error).fieldErrors);
  }
  return result.data;
}
