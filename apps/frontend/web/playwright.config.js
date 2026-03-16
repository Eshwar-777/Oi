/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: "./e2e/playwright",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
};

export default config;
