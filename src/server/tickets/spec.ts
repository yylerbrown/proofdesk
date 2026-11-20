import { z } from "zod";

// A test spec for a ticket: how to test that the customer's check is met, as scenarios a
// person can read. It is proposed, usually by a visitor's own AI assistant, and is a
// suggestion until a person accepts it. Proofdesk verifies none of it.

const words = (most: number) =>
  z.string().trim().min(1, "Must not be empty.").max(most, `Must be at most ${most} characters.`);

export const scenarioSchema = z.object({
  title: words(120).meta({ description: "A short name for the scenario." }),
  given: words(500).meta({ description: "The situation before, in plain words." }),
  when: words(500).meta({ description: "What happens, in plain words." }),
  then: words(500).meta({ description: "What must be true afterwards, in plain words." }),
  test_name: z
    .string()
    .trim()
    .max(200, "Must be at most 200 characters.")
    .optional()
    .meta({ description: "The name of the automated test that would prove it, if there is one." }),
});

/** The most scenarios one spec may hold. */
export const SCENARIO_LIMIT = 20;

export const proposeSpecSchema = z.object({
  summary: words(1000).meta({
    description: "One paragraph, in plain words a customer can read: what the scenarios test.",
  }),
  scenarios: z
    .array(scenarioSchema)
    .min(1, "Give at least one scenario.")
    .max(SCENARIO_LIMIT, `Give at most ${SCENARIO_LIMIT} scenarios.`)
    .meta({ description: "The scenarios that make the customer's check testable." }),
});

export type Scenario = z.infer<typeof scenarioSchema>;

/** What a person decides about a proposed spec. */
export const decideSpecSchema = z.object({
  decision: z.enum(["accept", "discard"]),
  // The suggested test the decision was made on, as the page showed it.
  spec_id: z.coerce.number().int().positive().optional(),
});
