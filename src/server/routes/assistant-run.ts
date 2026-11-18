import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { HttpError } from "../errors.js";

// "An assistant's work": one real assistant run, kept in docs/assistant-run, for anyone, signed
// in or not. The page shows the summary as headed sections; the transcript and the assistant's
// two files are served as plain text, exactly as they were kept.

/** The exact command the run used, as the summary keeps it, so the page cannot shorten it. */
export function runCommand(summary: string): string | null {
  const section = summary.split(/^## How it was run$/m)[1] ?? "";
  return /^```sh\n([\s\S]*?)\n```$/m.exec(section)?.[1] ?? null;
}

export function assistantRunRouter(rootDir: string, recordedKey: () => string | null): Router {
  const dir = path.join(rootDir, "docs", "assistant-run");
  const summaryFile = path.join(dir, "summary.md");
  const kept = fs.existsSync(summaryFile);
  const command = kept ? runCommand(fs.readFileSync(summaryFile, "utf8")) : null;
  const router = Router();
  router.get("/assistant-run", (_req, res) => {
    if (!kept) throw new HttpError(404, "not_found", "There is no page at this address.");
    res.render("assistant-run", {
      title: "An assistant's work",
      recordedKey: recordedKey(),
      command,
    });
  });
  router.use(
    "/assistant-run/files",
    express.static(dir, {
      index: false,
      dotfiles: "deny",
      // Shown as text, never run: a script file here is something an assistant wrote.
      setHeaders: (res) => res.type("text/plain; charset=utf-8"),
    }),
  );
  return router;
}
