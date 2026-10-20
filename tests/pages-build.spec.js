const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

// build/pages/ is what "python build.py --pages" produces: a self-contained
// deployment for a static host, which must work from any subdirectory. The
// static server's roots include build/, so it is served from /pages/ here --
// exactly the condition the relative references exist for.
//
// Nothing else in this suite needs a build artifact, so skip rather than fail
// when it has not been built.
const pagesDir = path.join(__dirname, "..", "build", "pages");
const pageFile = path.join(pagesDir, "index.html");

test.skip(!fs.existsSync(pageFile), "build/pages/index.html is missing; run build.py --pages");

test("the static-host build runs from a subdirectory", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto("/pages/index.html");
  await expect(page).toHaveTitle(/^Podium/);
  await expect.poll(() => page.evaluate(() => typeof window._FileSrc_)).toBe("function");
  expect(errors).toEqual([]);
});

test("the service worker takes the subdirectory as its scope", async ({ page }) => {
  await page.goto("/pages/index.html");

  // A scope of "/" would claim the whole origin and would be refused for a
  // script served from a subdirectory. 127.0.0.1 is a secure context, so
  // registration really happens here.
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("./");
    return registration?.scope ?? null;
  });

  try {
    expect(scope).toMatch(/\/pages\/$/);
  } finally {
    // Leaving it registered would let it answer later runs from its cache.
    await page.evaluate(async () => {
      for (const registration of await navigator.serviceWorker.getRegistrations())
        await registration.unregister();
    });
  }
});

test("the static-host build references everything relatively", async () => {
  const html = fs.readFileSync(pageFile, "utf8");
  expect(html).toContain('<link rel="manifest" href="manifest.webmanifest" />');
  expect(html).toContain('<link rel="apple-touch-icon" href="icon192.png">');
  expect(html).toContain("navigator.serviceWorker.register('sw.js')");
  // The deployment's own URL is not known at build time, so claiming another
  // site as canonical would be wrong.
  expect(html).not.toContain('rel="canonical"');

  const manifest = JSON.parse(fs.readFileSync(path.join(pagesDir, "manifest.webmanifest"), "utf8"));
  expect(manifest.start_url).toBe("./");
  expect(manifest.scope).toBe("./");
  // The icons are named as siblings of the manifest, so that is where the build
  // must put them.
  for (const icon of manifest.icons) {
    expect(icon.src.startsWith("/")).toBe(false);
    expect(fs.existsSync(path.join(pagesDir, icon.src))).toBe(true);
  }

  const worker = fs.readFileSync(path.join(pagesDir, "sw.js"), "utf8");
  expect(worker).not.toMatch(/urlsToCache\s*=\s*\[[^\]]*['"]\//);
  expect(fs.existsSync(path.join(pagesDir, "podauth.html"))).toBe(true);
});

test("the static-host build stamps itself so a device can be checked", async ({ page }) => {
  // "Which build is this device running?" is the question every PWA update
  // raises, because the service worker may still be answering from its cache.
  await page.goto("/pages/index.html");
  const build = await page.evaluate(() => window._podiumBuild_);
  expect(build).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);

  // Served from src/ the sources are unstamped, and must say so rather than
  // claiming a build they are not.
  await page.goto("/pod.html");
  expect(await page.evaluate(() => window._podiumBuild_)).toBe("dev");
});

test("the service worker's cache name follows the page it serves", async () => {
  // A deployment whose sw.js is byte-identical to the last one goes unnoticed:
  // the browser sees no new worker, never reinstalls, and keeps answering from
  // the old cache. The digest is what makes a changed page a changed worker.
  const digest = crypto.createHash("sha256")
    .update(fs.readFileSync(pageFile)).digest("hex").slice(0, 12);
  const worker = fs.readFileSync(path.join(pagesDir, "sw.js"), "utf8");

  expect(worker).toContain(`const CACHE_NAME = 'podium-v2.3.0-${digest}';`);
  // The source must stay unstamped, or the build would have nothing to replace.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "sw.js"), "utf8");
  expect(source).toContain("const CACHE_NAME = 'podium-v2.3.0';");
});
