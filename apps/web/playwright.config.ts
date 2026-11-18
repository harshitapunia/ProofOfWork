import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test", testMatch: "**/*.spec.ts", fullyParallel: true, workers: 2,
  reporter: "list", use: { baseURL: "http://127.0.0.1:4174", trace: "retain-on-failure" },
  webServer: { command: "npm run preview -- --port=4174", url: "http://127.0.0.1:4174", reuseExistingServer: false },
  projects: [ { name: "desktop", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } } ],
});
