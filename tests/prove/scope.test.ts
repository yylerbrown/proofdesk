import { renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkScope, type ScopeReason } from "../../ops/prove/scope.js";
import {
  fixAndTest,
  FIXED_CLAMP,
  IMPL,
  makeExecutable,
  makeFixture,
  makePatch,
  REGRESSION_TEST,
  removeFixture,
  TEST,
  writeFiles,
  writePatch,
  type Fixture,
} from "./fixture.js";

let fx: Fixture;
beforeAll(() => {
  fx = makeFixture();
});
afterAll(() => removeFixture(fx));

// Each case builds its patch either with git (`edit`) or by hand (`text`).
interface Case {
  name: string;
  reason: ScopeReason;
  edit?: (dir: string) => void;
  text?: string;
  test?: string; // allowlisted test path, when not the usual one
}

const longTest = (lines: number) =>
  REGRESSION_TEST + Array.from({ length: lines }, (_, i) => `// line ${i}`).join("\n") + "\n";

const cases: Case[] = [
  { name: "an allowed patch", reason: "accepted", edit: (d) => fixAndTest(d) },
  {
    name: "a change to another source file",
    reason: "not-allowed-path",
    edit: (d) => {
      fixAndTest(d);
      writeFiles(d, { "src/other.js": "export const other = 2;\n" });
    },
  },
  {
    name: "a second new file",
    reason: "not-allowed-path",
    edit: (d) => {
      fixAndTest(d);
      writeFiles(d, { "src/helper.js": "export const helper = 1;\n" });
    },
  },
  {
    name: "a deleted file",
    reason: "deleted-file",
    edit: (d) => {
      fixAndTest(d);
      rmSync(path.join(d, "src/other.js"));
    },
  },
  {
    name: "a renamed file",
    reason: "renamed-file",
    edit: (d) => {
      fixAndTest(d);
      renameSync(path.join(d, "src/other.js"), path.join(d, "src/moved.js"));
    },
  },
  {
    name: "a change to an existing test",
    reason: "modifies-existing-test",
    edit: (d) => {
      fixAndTest(d);
      writeFiles(d, { "tests/clamp.test.js": REGRESSION_TEST });
    },
  },
  {
    name: "an allowlisted test path that already exists",
    reason: "modifies-existing-test",
    test: "tests/clamp.test.js",
    edit: (d) => fixAndTest(d),
  },
  {
    name: "a binary file",
    reason: "binary-file",
    edit: (d) => {
      fixAndTest(d);
      writeFiles(d, { "assets/blob.bin": Buffer.from([0, 1, 2, 0, 255, 0]) });
    },
  },
  {
    name: "a symlink",
    reason: "symlink",
    edit: (d) => {
      fixAndTest(d);
      symlinkSync("clamp.js", path.join(d, "src/link.js"));
    },
  },
  {
    name: "a mode change",
    reason: "mode-change",
    edit: (d) => {
      fixAndTest(d);
      makeExecutable(d, IMPL);
    },
  },
  {
    name: "a path with ..",
    reason: "unsafe-path",
    text: [
      "diff --git a/../evil.js b/../evil.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/../evil.js",
      "@@ -0,0 +1 @@",
      "+x",
      "",
    ].join("\n"),
  },
  {
    name: "an absolute path",
    reason: "unsafe-path",
    text: ["--- /dev/null", "+++ /tmp/evil.js", "@@ -0,0 +1 @@", "+x", ""].join("\n"),
  },
  {
    name: "a patch over 128 KiB",
    reason: "patch-too-large",
    edit: (d) => fixAndTest(d, REGRESSION_TEST + "// " + "x".repeat(140 * 1024) + "\n"),
  },
  {
    name: "more than 150 changed lines",
    reason: "too-many-lines",
    edit: (d) => fixAndTest(d, longTest(160)),
  },
  {
    name: "a new test with .only(",
    reason: "focused-or-skipped-test",
    edit: (d) => fixAndTest(d, REGRESSION_TEST.replace("it(", "it.only(")),
  },
  {
    name: "a new test with .skip(",
    reason: "focused-or-skipped-test",
    edit: (d) => fixAndTest(d, REGRESSION_TEST.replace("it(", "it.skip(")),
  },
  {
    name: "a change to package.json",
    reason: "protected-file",
    edit: (d) => {
      fixAndTest(d);
      writeFiles(d, { "package.json": '{ "type": "module" }\n' });
    },
  },
  {
    name: "a new lockfile",
    reason: "protected-file",
    edit: (d) => {
      fixAndTest(d);
      writeFiles(d, { "package-lock.json": "{}\n" });
    },
  },
  {
    name: "a file under .github/",
    reason: "protected-file",
    edit: (d) => {
      fixAndTest(d);
      writeFiles(d, { ".github/workflows/ci.yml": "name: x\n" });
    },
  },
  {
    name: "a change to a config file",
    reason: "protected-file",
    edit: (d) => {
      fixAndTest(d);
      writeFiles(d, { "vitest.config.js": "export default {};\n" });
    },
  },
  {
    name: "a fix with no new test",
    reason: "missing-test",
    edit: (d) => writeFiles(d, { [IMPL]: FIXED_CLAMP }),
  },
  {
    name: "a patch that does not apply to the base",
    reason: "patch-does-not-apply",
    text: [
      `diff --git a/${IMPL} b/${IMPL}`,
      `--- a/${IMPL}`,
      `+++ b/${IMPL}`,
      "@@ -1,2 +1,2 @@",
      " this line is not in the base",
      "-nor is this one",
      "+replacement",
      "",
    ].join("\n"),
  },
];

describe("checkScope", () => {
  it.each(cases)("$name gives $reason", async (c) => {
    const patchFile = c.text !== undefined ? writePatch(fx, c.text) : makePatch(fx, c.edit!);
    const result = await checkScope({
      repo: fx.repo,
      base: fx.base,
      patchFile,
      implPath: IMPL,
      testPath: c.test ?? TEST,
    });
    expect(result.reason, result.detail).toBe(c.reason);
    expect(result.accepted).toBe(c.reason === "accepted");
  });

  it("lists the files and line count of an accepted patch", async () => {
    const patchFile = makePatch(fx, (d) => fixAndTest(d));
    const result = await checkScope({
      repo: fx.repo,
      base: fx.base,
      patchFile,
      implPath: IMPL,
      testPath: TEST,
    });
    expect(result.files.sort()).toEqual([IMPL, TEST].sort());
    expect(result.changedLines).toBe(8); // 1 removed + 1 added in the module, 6 new test lines
  });

  it("rejects an allowlist whose test path is not a test file", async () => {
    const patchFile = makePatch(fx, (d) => fixAndTest(d));
    const result = await checkScope({
      repo: fx.repo,
      base: fx.base,
      patchFile,
      implPath: IMPL,
      testPath: "src/not-a-test.js",
    });
    expect(result.reason).toBe("bad-allowlist");
  });
});
