import { describe, expect, it } from "vitest";
import { wireOpeningLinks, type OpeningLink, type Section } from "../src/browser/open-details.js";

// The script that opens a closed section when a link naming it is pressed, and every closed
// section around it.

describe("the script that opens it", () => {
  it("opens the named section when the link is pressed, and leaves others alone", () => {
    const section: Section = { open: false };
    const other: Section = { open: false };
    let press: () => void = () => undefined;
    const link: OpeningLink = {
      dataset: { opens: "ask" },
      addEventListener: (_type, listener) => (press = listener),
    };
    wireOpeningLinks([link], (id) => (id === "ask" ? [section] : []));
    expect(section.open).toBe(false);
    press();
    expect(section.open).toBe(true);
    expect(other.open).toBe(false);
  });

  it("opens the closed section around the named one too", () => {
    const section: Section = { open: false };
    const around: Section = { open: false };
    let press: () => void = () => undefined;
    const link: OpeningLink = {
      dataset: { opens: "ask" },
      addEventListener: (_type, listener) => (press = listener),
    };
    wireOpeningLinks([link], (id) => (id === "ask" ? [section, around] : []));
    press();
    expect(section.open).toBe(true);
    expect(around.open).toBe(true);
  });

  it("does nothing when the section is not on the page", () => {
    let press: () => void = () => undefined;
    const link: OpeningLink = {
      dataset: { opens: "missing" },
      addEventListener: (_type, listener) => (press = listener),
    };
    wireOpeningLinks([link], () => []);
    expect(() => press()).not.toThrow();
  });
});
