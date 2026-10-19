import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
export default defineConfig({
  plugins: [{ name: "diagnostic-python-text", load(id) {
    if (id.endsWith("/Read-BoldBIDiagnostics.py")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
  } }],
  test: { include: ["eval-poc/worker.test.ts", "eval-poc/scoped-worker.test.ts"] },
});
