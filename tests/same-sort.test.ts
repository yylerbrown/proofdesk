import { describe, expect, it } from "vitest";
import { sameSort, type ListSort } from "../src/server/tickets/schemas.js";

// Whether two sorts of the list are the same, which decides if a cursor may be read with the
// sort a caller names. The default order is only ever the same as itself.

const titleUp: ListSort = { by: "title", direction: "asc" };

describe("two sorts of the list", () => {
  it.each<[string, ListSort, ListSort, boolean]>([
    ["the default and the default", "open_first", "open_first", true],
    ["the default and a column", "open_first", titleUp, false],
    ["a column and the default", titleUp, "open_first", false],
    ["the same column the same way", titleUp, { by: "title", direction: "asc" }, true],
    ["the same column the other way", titleUp, { by: "title", direction: "desc" }, false],
    ["another column the same way", titleUp, { by: "key", direction: "asc" }, false],
  ])("%s", (_name, a, b, same) => {
    expect(sameSort(a, b)).toBe(same);
  });
});
