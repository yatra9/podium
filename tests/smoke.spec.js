const { test, expect } = require("@playwright/test");

test("Podium starts without page errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto("/pod.html");
  await expect(page).toHaveTitle(/^Podium/);
  await expect.poll(() => page.evaluate(() => typeof window._FileSrc_)).toBe("function");

  expect(errors).toEqual([]);
});
