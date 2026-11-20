import { expect, test, type Page } from "@playwright/test";
import { expectOneLook, foldLines } from "./fold-lines.js";

// Every fold-open line reads as one thing to press: its chevron follows its words with the same
// small gap, the whole line shows a pointer, and the line is only as wide as its words and
// chevron, so the focus ring wraps them together. A summary drawn as a button, a menu drawn as
// a dropdown and the closed message box drawn as a text box keep their own look. The ticket
// page's lines are checked in menus-webkit.spec.ts, on a ticket that test files anyway, since
// each address may file only a few tickets in ten minutes.

async function signIn(page: Page, person: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.locator(".person-menu summary strong")).toHaveText(person);
}

test("the issued connection's 'If that did not work' has its chevron right after the words", async ({
  page,
}) => {
  await signIn(page, "Admin");
  await page.goto("/connections");
  await page.getByLabel("Name").fill("Fold line check");
  await page.getByRole("button", { name: "Issue connection" }).click();
  const lines = await foldLines(page);
  expect(lines.map((line) => line.words)).toContain("If that did not work");
  expectOneLook(lines);
});
