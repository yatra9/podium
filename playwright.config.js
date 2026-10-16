const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:9876",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/static-server.js",
    url: "http://127.0.0.1:9876/pod.html",
    reuseExistingServer: true,
  },
});
