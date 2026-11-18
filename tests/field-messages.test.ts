import fs from "node:fs";
import { describe, expect, it } from "vitest";

// Every message about a field or a form sits outside the label, so a screen reader does not read
// it as part of the field's name, and the field or button it is about points to it.

const views = fs.readdirSync("views").filter((file) => file.endsWith(".ejs"));

describe("field messages in every template", () => {
  for (const file of views) {
    const text = fs.readFileSync(`views/${file}`, "utf8");
    const messages = [...text.matchAll(/<small id="([a-z_-]+-error)"/g)];
    for (const message of messages) {
      const id = message[1]!;
      it(`${file}: ${id} sits after its label, and something points to it`, () => {
        const before = text.slice(0, message.index);
        expect(before.lastIndexOf("<label")).toBeLessThan(before.lastIndexOf("</label>"));
        const pointedTo =
          new RegExp(`aria-describedby="[^"]*${id}`).test(text) ||
          // The new-ticket form builds the check's description from both its ids.
          (id === "fix_check-error" && text.includes('"fix_check-error fix_check-hint"'));
        expect(pointedTo).toBe(true);
      });
    }
  }
});
