import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        // Bindings used only by tests — kept separate from production secrets.
        bindings: {
          MONGODB_URI: "mongodb://invalid.test:27017",
          WORKOS_AUTHKIT_DOMAIN: "",
          WORKOS_M2M_CLIENT_ID: "",
          WORKOS_ALLOWED_ORG_IDS: "",
        },
        // Some transitive deps (e.g. ajv) require .json files; load them as
        // text modules so the workerd loader can resolve them.
        modulesRules: [
          { type: "ESModule", include: ["**/*.js", "**/*.mjs"], fallthrough: true },
          { type: "Text", include: ["**/*.json"] },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
