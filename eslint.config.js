import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // docs/assistant-run holds an assistant's files exactly as it wrote them: not this project's code.
  { ignores: ["dist", "node_modules", "data", "coverage", "public/js", "docs/assistant-run"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  { languageOptions: { globals: globals.node } },
  { files: ["src/browser/**"], languageOptions: { globals: globals.browser } },
);
