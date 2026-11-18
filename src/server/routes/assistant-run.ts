import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { HttpError } from "../errors.js";

// "An assistant's work": one real assistant run, kept in docs/assistant-run, for anyone, signed
// in or not. The summary is shown on the page; the transcript and the assistant's two files are
// served as plain text, exactly as they were kept.

export function assistantRunRouter(rootDir: string, recordedKey: () => string | null): Router {
  const dir = path.join(rootDir, "docs", "assistant-run");
  const summaryFile = path.join(dir, "summary.md");
  const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, "utf8") : null;
  const router = Router();
  router.get("/assistant-run", (_req, res) => {
    if (summary === null)
      throw new HttpError(404, "not_found", "There is no page at this address.");
    res.render("assistant-run", {
      title: "An assistant's work",
      summary,
      recordedKey: recordedKey(),
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
