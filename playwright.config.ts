import { defineConfig } from "@playwright/test";

// End-to-end tests run against the real stack: `npm run dev` must already be
// up (Temporal in Docker, Worker, API on :3000).
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [["list"]],
});
