// The rate limits, in one place: the app enforces them and the API's guide states them.

// How many tickets one person may file in ten minutes, and how many sign-ins one address
// may start in a minute.
export const FILING_LIMIT = 20;
export const SIGN_IN_LIMIT = 10;
// How many requests that change something one person, one connection (or one address, on the
// demo) may make in ten minutes, across every page, API route and tool. Reading is not counted.
export const WRITE_LIMIT = 120;
// How many times one person (or one address, on the demo) may ask the new ticket form's
// "Similar ticket" question in ten minutes. These asks change nothing, so the write allowance
// does not count them.
export const SIMILAR_LIMIT = 60;
// How many assistant connections one address may get from the demo's About page (/sign-in) in an
// hour.
export const DEMO_CONNECTIONS_PER_HOUR = 5;

export const WRITE_LIMIT_DESCRIPTION = `${WRITE_LIMIT} writes per 10 minutes per person or connection (per address on the demo), across the pages, the API and the tools. Reading is not counted.`;
