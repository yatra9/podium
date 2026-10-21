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

  // And the date alone cannot be matched against the repository, so the commit
  // is stamped beside it: a whole hash, optionally marked as carrying
  // uncommitted changes. "unknown" is allowed, for a build made without git.
  const commit = await page.evaluate(() => window._podiumCommit_);
  expect(commit).toMatch(/^([0-9a-f]{40}(-dirty)?|unknown)$/);

  // Served from src/ the sources are unstamped, and must say so rather than
  // claiming a build they are not.
  await page.goto("/pod.html");
  expect(await page.evaluate(() => [window._podiumBuild_, window._podiumCommit_]))
    .toEqual(["dev", "dev"]);
});

test("the About panel names the build's commit both ways", async ({ page }) => {
  // The short hash is what a person reads off a tablet and quotes; the whole one
  // is what a tool is given. A build with uncommitted changes says so, once.
  await page.goto("/pages/index.html");
  await page.waitForFunction(() => !!window._menu_?.rings?.app?.cells?.about);
  // The panel itself, without the menu gesture that would place it: opening it
  // for real needs a pointer to put it under.
  await page.evaluate(() => {
    const panel = _panels_.AboutPanel.get(_menu_.rings.app.cells.about);
    _body_.append(panel.elm);
  });
  const face = page.locator(".Panel__elm", { hasText: "PODIUM: Sheet Music Studio" });
  await expect(face).toBeVisible();
  const shown = {
    text: await face.textContent(),
    commit: await page.evaluate(() => window._podiumCommit_),
  };
  const dirty = shown.commit.endsWith("-dirty");
  const hash = dirty ? shown.commit.slice(0, -6) : shown.commit;
  expect(shown.text).toContain(`Commit ${hash.slice(0, 8)}${dirty ? "-dirty" : ""}`);
  expect(shown.text).toContain(hash);
  // The whole hash is shown as a hash, so it can be copied and used as one.
  expect(shown.text).not.toContain(`${hash}-dirty`);
});

test("the deployed guidebook is used in place of the published one", async ({ page }) => {
  // Deploying the guidebook is the whole of what makes App -> Guide work here:
  // the panel probes for a local copy and borrows studiop5.org's only when
  // there is none. Neither path may need the network to decide, so any request
  // off the origin fails the test.
  const offOrigin = [];
  await page.route("**", route => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:9876/") || url.startsWith("http://localhost:9876/"))
      return route.continue();
    offOrigin.push(url);
    return route.abort();
  });

  await page.goto("/pages/index.html");
  await expect.poll(() => page.evaluate(() => typeof window._panels_?.GuidePanel)).toBe("function");
  // Only the translation is deployed; English is the published copy, which the
  // language switch reaches over the network.
  expect(await page.evaluate(() => window._panels_.GuidePanel.resolveUrls()))
    .toEqual({
      ja: "http://127.0.0.1:9876/pages/Guidebook.ja.html",
      en: "https://studiop5.org/Guidebook.html",
    });

  // And where the deployment carries none, the published copy alone. A 404 body
  // would otherwise load into the iframe exactly as a guidebook would, which is
  // why the probe exists at all.
  const borrowed = await page.evaluate(() => {
    const panel = window._panels_.GuidePanel;
    panel.urls = null;
    panel.localNames = { en: "no-such-guidebook.html" };
    return panel.resolveUrls();
  });
  expect(borrowed).toEqual({ en: "https://studiop5.org/Guidebook.html" });

  expect(offOrigin).toEqual([]);
});

test("the guidebook panel offers the language it cannot read offline", async ({ page }) => {
  // The title bar is Podium's DOM, not the iframe's, which is the whole reason
  // the switch can be there at all: it stays put while the document under it is
  // replaced, and works the same for the published copy as for the local one.
  await page.goto("/pages/index.html");
  await expect.poll(() => page.evaluate(() => !!window._menu_?.rings?.app?.cells?.guide)).toBe(true);
  // studiop5.org is never contacted: the English guidebook is only ever named.
  await page.route("https://studiop5.org/**", route => route.abort());

  const state = await page.evaluate(async () => {
    const GuidePanel = window._panels_.GuidePanel;
    localStorage.removeItem(GuidePanel.preference);
    // The real cell, so the panel is the one App -> Guide opens, title bar and
    // all -- a Panel cannot be built without one.
    const panel = GuidePanel.get(window._menu_.rings.app.cells.guide);
    panel.urls = await GuidePanel.resolveUrls();
    const read = () => ({
      language: panel.language,
      switcher: panel.switcherLabel.textContent,
      shown: panel.switcher.style.display != "none",
      src: new URL(panel.iframe.src).pathname,
      stored: localStorage.getItem(GuidePanel.preference),
    });
    panel.setLanguage("ja");
    const opened = read();
    panel.setLanguage(panel.other());
    return { opened, switched: read() };
  });

  // The pill names where the tap goes, not where the reader already is.
  expect(state.opened).toMatchObject({
    language: "ja", switcher: "EN", shown: true,
    src: "/pages/Guidebook.ja.html", stored: "ja",
  });
  expect(state.switched).toMatchObject({
    language: "en", switcher: "日本語", shown: true,
    src: "/Guidebook.html", stored: "en",
  });
});

test("the deployed guidebook points at the images that were deployed with it", async () => {
  const guidebook = fs.readFileSync(path.join(pagesDir, "Guidebook.ja.html"), "utf8");
  // Every screenshot is recompressed to WebP, so a .jpg reference left behind
  // would 404. The videos keep both their codec container and their names.
  expect(guidebook).not.toMatch(/\.jpg/);
  expect(guidebook.match(/src="assets\/[^"]+\.webp"/g)).toHaveLength(62);
  expect(guidebook.match(/src="assets\/[^"]+\.webm"/g)).toHaveLength(16);

  // Reading one chapter must not fetch all 62 screenshots.
  expect(guidebook.match(/<img /g)).toHaveLength(62);
  expect(guidebook.match(/<img [^>]*loading="lazy"/g)).toHaveLength(62);

  for (const reference of guidebook.match(/(?:src|href)="(assets\/[^"]+)"/g) ?? []) {
    const relative = reference.replace(/^(?:src|href)="/, "").replace(/"$/, "");
    expect(fs.existsSync(path.join(pagesDir, relative)), relative).toBe(true);
  }
});

test("every deployed screenshot decodes, and so does a re-encoded clip", async ({ page }) => {
  // The build re-encodes all 78 assets, so this is where a codec the browser
  // cannot read, or a file ffmpeg wrote only half of, is caught. WebP and AV1
  // are both decoded here rather than merely declared.
  test.setTimeout(60_000);   // 62 images and a video, all decoded for real
  await page.goto("/pages/Guidebook.ja.html");
  const images = await page.evaluate(async () => {
    const all = [...document.images];
    // Undo the deferral the guidebook ships with: only the images near the top
    // of the document would load otherwise, and this is about all of them.
    all.forEach(img => { img.loading = "eager"; });
    await Promise.all(all.map(img => img.complete ? null : new Promise((done) => {
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
    })));
    return {
      count: all.length,
      broken: all.filter(img => !img.naturalWidth).map(img => img.getAttribute("src")),
      widest: Math.max(...all.map(img => img.naturalWidth)),
    };
  });

  expect(images.count).toBe(62);
  expect(images.broken).toEqual([]);
  // Capture resolution went up to 2856px wide, against a 600px column.
  expect(images.widest).toBe(1280);

  const clip = await page.evaluate(() => new Promise((resolve) => {
    const video = document.querySelector("video");
    video.addEventListener("loadedmetadata", () => resolve(
      { width: video.videoWidth, duration: Math.round(video.duration) }));
    video.addEventListener("error", () => resolve({ error: video.error?.message ?? "failed" }));
    video.preload = "metadata";
    video.load();
  }));

  expect(clip.error).toBeUndefined();
  expect(clip.width).toBe(1280);
});

test("the worker precaches the guidebook and its images, but no video", async () => {
  const worker = fs.readFileSync(path.join(pagesDir, "sw.js"), "utf8");
  const listed = [...worker.matchAll(/^\s*'(\.\/[^']*)',$/gm)].map(m => m[1]);
  const precached = listed.filter(url => url !== "./podium.html"); // absent by design

  expect(precached).toContain("./");
  expect(precached).toContain("./Guidebook.ja.html");
  expect(precached.filter(url => url.endsWith(".webp"))).toHaveLength(62);
  // 11.5 MB of video against 2.5 MB for every image, and the guidebook already
  // defers them: they are fetched when played and not before.
  expect(precached.filter(url => url.endsWith(".webm"))).toEqual([]);

  for (const url of precached) {
    if (url === "./") continue;
    expect(fs.existsSync(path.join(pagesDir, url.slice(2))), url).toBe(true);
  }
});

test("the service worker's cache name follows everything it serves", async () => {
  // A deployment whose sw.js is byte-identical to the last one goes unnoticed:
  // the browser sees no new worker, never reinstalls, and keeps answering from
  // the old cache. The digest is what makes changed content a changed worker --
  // and it covers the whole precached set, because a corrected screenshot with
  // an unchanged page would otherwise never reach a device that had installed.
  const worker = fs.readFileSync(path.join(pagesDir, "sw.js"), "utf8");
  const precached = [...worker.matchAll(/^\s*'(\.\/[^']*)',$/gm)]
    .map(m => m[1]).filter(url => url !== "./podium.html");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(pageFile));
  for (const url of precached)
    if (url !== "./") hash.update(fs.readFileSync(path.join(pagesDir, url.slice(2))));
  const digest = hash.digest("hex").slice(0, 12);

  expect(worker).toContain(`const CACHE_NAME = 'podium-v2.3.0-${digest}';`);
  // The source must stay unstamped, or the build would have nothing to replace.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "sw.js"), "utf8");
  expect(source).toContain("const CACHE_NAME = 'podium-v2.3.0';");
  expect(source).toContain("const docToCache = [];");
});

test("installing the worker really stores the guidebook", async ({ page }) => {
  // The list being right is not the same as the install succeeding: it opens 64
  // entries, and an install that rejects leaves a device with no offline
  // guidebook at all. Each entry is added on its own and allowed to fail, so
  // only counting what landed in the cache proves it.
  await page.goto("/pages/index.html");
  const stored = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    const name = (await caches.keys()).find(key => key.startsWith("podium-"));
    const cache = await caches.open(name);
    const keys = (await cache.keys()).map(request => new URL(request.url).pathname);
    return { name, keys };
  });

  try {
    expect(stored.name).toMatch(/^podium-v2\.3\.0-[0-9a-f]{12}$/);
    expect(stored.keys).toContain("/pages/Guidebook.ja.html");
    expect(stored.keys.filter(p => p.endsWith(".webp"))).toHaveLength(62);
    expect(stored.keys.filter(p => p.endsWith(".webm"))).toEqual([]);
  } finally {
    await page.evaluate(async () => {
      for (const registration of await navigator.serviceWorker.getRegistrations())
        await registration.unregister();
      for (const key of await caches.keys()) await caches.delete(key);
    });
  }
});
