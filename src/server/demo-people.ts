import type { Actor } from "./actor.js";

/**
 * Made-up customers who filed some of the samples. They cannot sign in. They make the team's
 * list hold more than one customer's tickets, so a customer's own list visibly holds fewer.
 */
export const OTHER_DEMO_CUSTOMERS: Actor[] = [
  {
    id: "demo-customer-2",
    kind: "person",
    role: "customer",
    name: "Second Demo Customer",
    demo: true,
  },
  {
    id: "demo-customer-3",
    kind: "person",
    role: "customer",
    name: "Third Demo Customer",
    demo: true,
  },
];
