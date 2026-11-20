import { expect, test, type Page } from "@playwright/test";
import { samplePicture } from "../../src/server/pictures/sample.js";

// Pictures in a real browser, with the page's script on: chosen pictures show as a strip of
// small squares above the "Add pictures" control, each with a remove button named for its
// file; at the limit the control reads "4 of 4 pictures"; a picture pasted into the box or
// dropped on it is added the same way; and the form sends exactly what the strip shows.

const PNG = samplePicture();

// Customer Two files these tickets, since the other journeys use up much of Customer One's
// filing limit in one run.

/** A chosen file as Playwright hands it to a file input. */
const picture = (name: string) => ({ name, mimeType: "image/png", buffer: PNG });

async function signIn(page: Page, person: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `View as ${person}` }).click();
  await expect(page.locator(".person-menu summary strong")).toHaveText(person);
}

/** Puts a picture on the page's clipboard or drag data, made from the bytes in the page. */
async function sendPictureEvent(
  page: Page,
  selector: string,
  kind: "paste" | "drop",
  name: string,
) {
  await page.evaluate(
    async ({ selector, kind, name, bytes }) => {
      const file = new File([new Uint8Array(bytes)], name, { type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const target = document.querySelector(selector)!;
      const event =
        kind === "paste"
          ? new ClipboardEvent("paste", {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            })
          : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    },
    { selector, kind, name, bytes: [...PNG] },
  );
}

test("the strip shows, removes, stops at four, and takes a paste and a drop", async ({ page }) => {
  await signIn(page, "Customer Two");
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill("The export is blank");
  await page.getByLabel("Description").fill("The file it downloads is empty.");

  // Found by its name attribute, since its words change to the count at the limit.
  const control = page.locator('input[name="pictures"]');
  await expect(page.getByLabel("Add pictures")).toBeAttached();
  const strip = page.locator("#ticket-picture-strip");
  await expect(strip).toBeHidden();

  await control.setInputFiles([picture("settings.png"), picture("export.png")]);
  await expect(strip.locator("img")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Remove settings.png" })).toBeVisible();

  await page.getByRole("button", { name: "Remove settings.png" }).click();
  await expect(strip.locator("img")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove export.png" })).toBeFocused();

  // Pasting into the box, and dropping on it, add a picture each.
  await sendPictureEvent(page, 'textarea[name="description"]', "paste", "image.png");
  await expect(page.getByRole("button", { name: "Remove pasted-picture-1.png" })).toBeVisible();
  await sendPictureEvent(page, 'textarea[name="description"]', "drop", "dropped.png");
  await expect(page.getByRole("button", { name: "Remove dropped.png" })).toBeVisible();
  await expect(strip.locator("img")).toHaveCount(3);

  // Two more chosen: only one fits, and the control says the limit is reached.
  await control.setInputFiles([picture("one-more.png"), picture("too-many.png")]);
  await expect(strip.locator("img")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Remove too-many.png" })).toHaveCount(0);
  await expect(page.locator("label.add-pictures .add-pictures-words")).toHaveText(
    "4 of 4 pictures",
  );
  // The picker holds exactly what the strip shows.
  expect(await control.evaluate((input: HTMLInputElement) => input.files?.length)).toBe(4);

  // Filed, the four show under the description as squares that open the full picture.
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+\?step=verify$/);
  const thumbs = page.locator(".pictures img");
  await expect(thumbs).toHaveCount(4);
  await expect(thumbs.first()).toHaveAttribute("alt", "Picture 1 of 4 from Customer Two");
  await expect(thumbs.first()).toHaveJSProperty("naturalWidth", 480);
  await expect(page.locator(".pictures a").first()).toHaveAttribute("target", "_blank");
  const box = await thumbs.first().boundingBox();
  expect(box?.width).toBe(80);
  expect(box?.height).toBe(80);
});

test("a reply's pictures show under it, and four fit on one line at phone width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "Customer Two");
  await page.goto("/tickets/new");
  await page.getByLabel("Title").fill("Four pictures on a phone");
  await page.getByLabel("Description").fill("A ticket to answer with pictures.");
  await page.getByRole("button", { name: "File ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/SUP-\d+\?step=verify$/);

  await page.locator("summary", { hasText: "Write a message" }).click();
  await page.getByRole("textbox", { name: "Your message" }).fill("Here is what I see.");
  await page
    .getByLabel("Add pictures")
    .setInputFiles(["a.png", "b.png", "c.png", "d.png"].map(picture));
  await expect(page.locator("#reply-picture-strip img")).toHaveCount(4);
  await page.getByRole("button", { name: "Send" }).click();

  const thumbs = page.locator("article.entry .pictures img");
  await expect(thumbs).toHaveCount(4);
  const tops = await thumbs.evaluateAll((images) =>
    images.map((image) => Math.round(image.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBe(1);
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(sideways).toBe(0);
});
