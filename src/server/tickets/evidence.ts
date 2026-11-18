import { z } from "zod";

// Evidence that a ticket's check was met. Proofdesk stores it as reported and shows who
// reported it; it verifies nothing. The original report is kept exactly as sent.

export const EVIDENCE_KINDS = ["test", "check_run", "change_link", "note"] as const;

const httpLink = z
  .string()
  .trim()
  .max(500, "Must be at most 500 characters.")
  .pipe(z.url({ protocol: /^https?$/, error: "Must be a link that starts with http or https." }));

/** The most a report may hold, as JSON text. */
export const REPORT_LIMIT = 20000;

export const addEvidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  summary: z
    .string()
    .trim()
    .min(1, "Say in one line what this shows.")
    .max(500, "Must be at most 500 characters."),
  link: httpLink.optional(),
  revision: z
    .string()
    .trim()
    .max(100, "Must be at most 100 characters.")
    .optional()
    .meta({ description: "The commit or version that was tested." }),
  command: z
    .string()
    .trim()
    .max(300, "Must be at most 300 characters.")
    .optional()
    .meta({ description: "The command or check that ran." }),
  result: z
    .string()
    .trim()
    .max(100, "Must be at most 100 characters.")
    .optional()
    .meta({ description: "A short result, for example: passed." }),
  report: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= REPORT_LIMIT, {
      error: `Must be at most ${REPORT_LIMIT} characters as JSON.`,
    })
    .optional()
    .meta({ description: "The original report, for example the evidence.json of ops/prove." }),
});

/** What a reader can honestly say about one stage of a test report. */
export type StageReading = "failed" | "passed" | "unknown";

/**
 * The three stages of an ops/prove report, read for people: did the new test fail before the
 * fix, did the existing tests pass before it, did everything pass after it. A stage counts
 * only when the report says so plainly; anything missing or unclear is "unknown", never
 * "passed". A report in another shape gives null, and the page then shows only that a report
 * is attached.
 */
export function readProveReport(report: unknown): {
  before_fix: StageReading;
  existing_tests: StageReading;
  after_fix: StageReading;
} | null {
  const stage = z.object({ status: z.string(), failureMessage: z.string().optional() });
  const shape = z.object({
    baseline: stage.optional(),
    red: stage.optional(),
    green: stage.optional(),
  });
  const parsed = shape.safeParse(report);
  if (!parsed.success) return null;
  const { baseline, red, green } = parsed.data;
  if (baseline === undefined && red === undefined && green === undefined) return null;
  // The red stage "held" means the new test failed on the code before the fix, with an
  // assertion. Only then is "failed before the fix" true.
  const beforeFix: StageReading =
    red === undefined || red.status === "inconclusive"
      ? "unknown"
      : red.status === "held" && red.failureMessage !== undefined
        ? "failed"
        : red.status === "failed"
          ? "passed"
          : "unknown";
  const plain = (s: typeof baseline): StageReading =>
    s === undefined
      ? "unknown"
      : s.status === "held"
        ? "passed"
        : s.status === "failed"
          ? "failed"
          : "unknown";
  return { before_fix: beforeFix, existing_tests: plain(baseline), after_fix: plain(green) };
}
