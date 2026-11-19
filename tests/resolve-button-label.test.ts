import { describe, expect, it } from "vitest";
import {
  resolveLabelFor,
  wireResolveLabel,
  type KindChoice,
  type ResolveButton,
} from "../src/browser/send-label.js";

// The Status menu's Resolved form ends in one button. While the reason Fixed is chosen it reads
// "Mark fixed and tell the customer", since Fixed also tells the customer; otherwise "Resolve
// ticket". Without the script it reads "Resolve ticket".

const labels = { labelFixed: "Mark fixed and tell the customer", labelOther: "Resolve ticket" };

/** A stand-in radio button that keeps its change listener. */
function fakeReason(value: string, checked: boolean) {
  let listener: () => void = () => undefined;
  const choice: KindChoice = {
    value,
    checked,
    addEventListener: (_type, given) => (listener = given),
  };
  return { choice, change: () => listener() };
}

describe("the resolve button's words", () => {
  it("name what Fixed does, and say Resolve ticket for any other reason", () => {
    const button: ResolveButton = { dataset: { ...labels }, textContent: "Resolve ticket" };
    expect(resolveLabelFor(button, "fixed_no_reply")).toBe("Mark fixed and tell the customer");
    expect(resolveLabelFor(button, "wont_fix")).toBe("Resolve ticket");
    expect(resolveLabelFor(button, undefined)).toBe("Resolve ticket");
  });

  it("follow the reason as it changes", () => {
    const button: ResolveButton = { dataset: { ...labels }, textContent: "Resolve ticket" };
    const fixed = fakeReason("fixed_no_reply", false);
    const other = fakeReason("other", false);
    wireResolveLabel(button, [fixed.choice, other.choice]);
    expect(button.textContent).toBe("Resolve ticket");

    fixed.choice.checked = true;
    fixed.change();
    expect(button.textContent).toBe("Mark fixed and tell the customer");

    fixed.choice.checked = false;
    other.choice.checked = true;
    other.change();
    expect(button.textContent).toBe("Resolve ticket");
  });
});
