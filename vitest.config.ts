import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          // Bindings used only by tests — kept separate from production secrets.
          bindings: {
            WORKOS_CLIENT_ID: "client_test",
            WORKOS_CLIENT_SECRET: "sk_test_workos_client_secret",
            COOKIE_ENCRYPTION_KEY:
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            MONGODB_URI: "mongodb://invalid.test:27017",
            WORKOS_ALLOWED_ORG_IDS: "",
            WORKOS_REQUIRED_PERMISSION: "",
          },
          // Some transitive deps (e.g. ajv) require .json files; load them as
          // text modules so the workerd loader can resolve them.
          modulesRules: [
            { type: "ESModule", include: ["**/*.js", "**/*.mjs"], fallthrough: true },
            { type: "Text", include: ["**/*.json"] },
          ],
        },
      },
    },
  },
});
