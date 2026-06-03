import { defineConfig } from "vitest/config";

// Fundi's pure-logic tests run in plain Node — no Workers pool. They cover the
// deterministic skills (Plus Code, classification, the description guard, the
// boundary guard) and never import the mongodb driver or the Agents runtime.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
