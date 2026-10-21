const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

// The camera half of wink page turning: the model loading from the files
// vendored beside the app, the panel being a window onto a camera it does not
// own, and a finished wink reaching the same page-turning road a pedal takes.
//
// Chromium's fake camera plays a test pattern, so there is no face in any of
// this and no wink is ever read from it. That is the point: what is being
// checked here is the plumbing, and the gesture itself is checked against
// made-up frames in wink.spec.js, where a face is not needed.
const pageFile = path.join(__dirname, "..", "build", "podium.html");
test.skip(!fs.existsSync(pageFile), "build/podium.html is missing; run build.py --podium");

const modelFile = path.join(__dirname, "..", "lib", "mediapipe", "face_landmarker.task");

test.use({
  permissions: ["camera"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

// Open the Wink panel and report what the turner made of starting up. Also
// collects every request that tried to leave the test server: the model is
// vendored precisely so that turning this on does not call anybody.
async function start(page) {
  const outside = [];
  await page.route("**/*", route => {
    const url = route.request().url();
    if (!url.startsWith("http://127.0.0.1:9876")) outside.push(url);
    route.continue();
  });
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._menu_?.rings?.more?.cells?.wink);
  const started = await page.evaluate(async () => {
    const panel = window._panels_.WinkPanel.get(window._menu_.rings.more.cells.wink);
    panel.show();
    const turner = window._WinkTurner_.it;
    const ok = await turner.on();
    return { ok, status: turner.status, detail: turner.detail };
  });
  return { started, outside };
}

// Wait for the model to deliver frames, and report the last one.
async function watched(page, ms = 3000) {
  return page.evaluate(async (ms) => {
    const turner = window._WinkTurner_.it;
    let seen = 0, last = null;
    const off = turner.listen((what, sample, verdict) => {
      if (what == "frame") { seen++; last = { sample, verdict }; }
    });
    await new Promise(done => setTimeout(done, ms));
    off();
    return { seen, last };
  }, ms);
}

test("the model loads from the files beside the app, and calls nobody", async ({ page }) => {
  test.skip(!fs.existsSync(modelFile), "lib/mediapipe is missing; run fetch-wink-assets.sh");
  const { started, outside } = await start(page);

  expect(started, started.detail).toMatchObject({ ok: true, status: "on" });
  const { seen, last } = await watched(page);
  expect(seen).toBeGreaterThan(0);
  // A test pattern is not a face, and the judge says so rather than reading a
  // wink out of whatever the mesh made of it.
  expect(last.sample.face).toBe(false);
  expect(last.verdict).toMatchObject({ track: false, ready: false, why: "no-face" });
  // Turning Wink on must not be a request to anybody: the whole of the model
  // is vendored, and nothing about the face goes anywhere.
  expect(outside).toEqual([]);
});

test("the ring in the corner says what the camera makes of the player", async ({ page }) => {
  test.skip(!fs.existsSync(modelFile), "lib/mediapipe is missing; run fetch-wink-assets.sh");
  await start(page);
  await watched(page, 1500);

  // Grey, because there is no face: the reader can see the camera is on and
  // getting nothing, which is the state most worth telling them about.
  const hud = page.locator(".WinkHud");
  await expect(hud).toHaveClass(/WinkHud-shown/);
  await expect(hud).toHaveClass(/WinkHud-lost/);
  await expect(hud).not.toHaveClass(/WinkHud-ready/);

  // Where it sits is the reader's, and the setting is in plain words.
  await page.evaluate(() => {
    const turner = window._WinkTurner_.it;
    turner.stash.place = "Low Left";
    turner.tune();
  });
  await expect(hud).toHaveClass(/WinkHud-at-bottomLeft/);

  // Turning it off takes the ring away with the camera.
  await page.evaluate(() => window._WinkTurner_.it.off());
  await expect(hud).not.toHaveClass(/WinkHud-shown/);
});

test("closing the panel leaves the camera watching", async ({ page }) => {
  test.skip(!fs.existsSync(modelFile), "lib/mediapipe is missing; run fetch-wink-assets.sh");
  // The point of the feature is to aim the camera, close the panel and go and
  // play. Every other tool panel stops its device on the way out, so this is
  // the one that has to be pinned down.
  await start(page);
  await watched(page, 1200);

  const after = await page.evaluate(async () => {
    const turner = window._WinkTurner_.it;
    window._panels_.wink.close();
    // Past the panel's delayed destruction, which is when a tool that took
    // its device with it would have done so.
    await new Promise(done => setTimeout(done, 900));
    let seen = 0;
    const off = turner.listen((what) => { if (what == "frame") seen++; });
    await new Promise(done => setTimeout(done, 1200));
    off();
    return { running: turner.running, live: turner.watch.stream?.getVideoTracks()[0]?.readyState, seen };
  });

  expect(after.running).toBe(true);
  expect(after.live).toBe("live");
  expect(after.seen).toBeGreaterThan(0);

  // And opening it again picks up the camera that is already running rather
  // than starting a second one.
  const again = await page.evaluate(async () => {
    const panel = window._panels_.WinkPanel.get(window._menu_.rings.more.cells.wink);
    panel.show();
    await new Promise(done => setTimeout(done, 900));
    return {
      watching: panel.wink.view.watch,
      preview: !!panel.wink.preview?.srcObject,
      cameras: window._WinkTurner_.it.watch.stream?.getVideoTracks().length,
    };
  });

  expect(again).toEqual({ watching: "Stop", preview: true, cameras: 1 });
});

test("turning Wink off puts the camera out", async ({ page }) => {
  test.skip(!fs.existsSync(modelFile), "lib/mediapipe is missing; run fetch-wink-assets.sh");
  // The camera light going out is the only assurance a player has that this is
  // not watching them, so the tracks have to be stopped and not merely dropped.
  await start(page);
  await watched(page, 1200);

  const off = await page.evaluate(async () => {
    const turner = window._WinkTurner_.it;
    const track = turner.watch.stream.getVideoTracks()[0];
    turner.off();
    await new Promise(done => setTimeout(done, 400));
    let seen = 0;
    const stop = turner.listen((what) => { if (what == "frame") seen++; });
    await new Promise(done => setTimeout(done, 600));
    stop();
    return { state: track.readyState, running: turner.running, status: turner.status, seen };
  });

  expect(off).toEqual({ state: "ended", running: false, status: "off", seen: 0 });
});

test("a recording keeps every score the model read, and no picture", async ({ page }) => {
  test.skip(!fs.existsSync(modelFile), "lib/mediapipe is missing; run fetch-wink-assets.sh");
  await start(page);
  const csv = await page.evaluate(async () => {
    const turner = window._WinkTurner_.it;
    turner.record(true);
    await new Promise(done => setTimeout(done, 2500));
    turner.log.label("wink");
    await new Promise(done => setTimeout(done, 400));
    turner.record(false);
    return { text: turner.log.toCsv(), rows: turner.log.rows.length, marked: turner.log.marked };
  });

  const lines = csv.text.trim().split("\n");
  const head = lines[0].split(",");
  expect(csv.rows).toBeGreaterThan(0);
  expect(lines).toHaveLength(csv.rows + 1);
  // The judge's reading of each frame, beside the numbers it read it from.
  expect(head.slice(0, 5)).toEqual(["t", "mark", "face", "left", "right"]);
  expect(head).toContain("why");
  expect(head).toContain("yaw");
  // A fake camera has no face, so the model offers no blendshapes and the
  // recording has no columns for them -- but every row still has to line up
  // with the header, or a spreadsheet reads the whole thing crookedly.
  for (const line of lines) expect(line.split(",")).toHaveLength(head.length);
  // Nothing in here is an image, by any name.
  expect(csv.text).not.toMatch(/data:|base64|blob:/);
});

test("a finished wink turns the page the way a pedal does", async ({ page }) => {
  // The gesture is checked without a camera in wink.spec.js; what matters here
  // is that a finished one reaches the score, through the same road a pedal
  // and an arrow key take -- and that "Hold" fills the gauge and leaves the
  // page alone, so the gesture can be tried out without losing your place.
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._menu_?.rings?.layout?.cells?.book);
  await page.evaluate(() => { window._menu_.rings.score.cells.new.stash.pgCount = 8; });
  await page.evaluate(() => window._menu_.notify("score/new/up"));
  await expect.poll(() => page.evaluate(() => !!window._score_), { timeout: 30_000 }).toBe(true);

  const turned = await page.evaluate(async () => {
    const Layout = window._Layout_;
    await Layout.open(window._menu_.rings.layout.cells.book);
    await new Promise(done => setTimeout(done, _gs_ * 3));
    await Layout.activeLayout.pgGoTo(1);
    await new Promise(done => setTimeout(done, _gs_ * 2));

    const at = () => window._score_.numbers.pn;
    const turner = window._WinkTurner_.it;
    // A verdict with a turn in it is what the judge hands back on the frame a
    // gauge fills; this is that frame, without the eye.
    const wink = (direction) => turner.frame(
      { t: performance.now(), face: true, left: 0, right: 0, fps: 15 },
      { track: true, ready: false, why: "eye-shut", state: "cooldown",
        direction: null, progress: 1, turn: direction });

    const first = at();
    turner.stash.turn = "Turn";
    wink("next");
    await new Promise(done => setTimeout(done, _gs_ * 3));
    const onward = at();
    wink("prev");
    await new Promise(done => setTimeout(done, _gs_ * 3));
    const back = at();

    // Held: the gauge fills, the page stays.
    turner.stash.turn = "Hold";
    wink("next");
    await new Promise(done => setTimeout(done, _gs_ * 3));
    const held = at();

    return { first, onward, back, held, turns: turner.turns };
  });

  expect(turned.onward).toBeGreaterThan(turned.first);
  expect(turned.back).toBe(turned.first);
  expect(turned.held).toBe(turned.first);
  // Only the two that moved the page were counted as turns.
  expect(turned.turns).toBe(2);
});

test("every hands-free way of asking for a page goes down one road", async ({ page }) => {
  // _turnPage_ is what a pedal, an arrow key and a wink all call, so it is
  // also where the score's own Numbers settings about moving by bookmark are
  // honoured -- once, rather than once per caller.
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._menu_?.rings?.layout?.cells?.book);
  await page.evaluate(() => { window._menu_.rings.score.cells.new.stash.pgCount = 8; });
  await page.evaluate(() => window._menu_.notify("score/new/up"));
  await expect.poll(() => page.evaluate(() => !!window._score_), { timeout: 30_000 }).toBe(true);

  const walked = await page.evaluate(async () => {
    const Layout = window._Layout_;
    await Layout.open(window._menu_.rings.layout.cells.book);
    await new Promise(done => setTimeout(done, _gs_ * 3));
    const settle = () => new Promise(done => setTimeout(done, _gs_ * 3));
    const go = async (how, marks) => {
      const answered = window._turnPage_(how, marks);
      await settle();
      return { at: window._score_.numbers.pn, answered };
    };

    await Layout.activeLayout.pgGoTo(1);
    await settle();
    const steps = {
      next: await go("next"),
      last: await go("last"),
      prev: await go("prev"),
      first: await go("first"),
    };
    // With no score there is nothing to turn, and saying so is how a caller
    // that has shown the reader a filling gauge can tell them it went nowhere.
    const score = window._score_;
    window._score_ = null;
    const empty = window._turnPage_("next");
    window._score_ = score;
    return { steps, empty };
  });

  // Book opens pages in pairs, so how far each step moves is the layout's
  // business; what matters is that each of the four goes the way it was asked.
  expect(walked.steps.next.at).toBeGreaterThan(1);
  expect(walked.steps.last.at).toBeGreaterThan(walked.steps.next.at);
  expect(walked.steps.prev.at).toBeLessThan(walked.steps.last.at);
  expect(walked.steps.first.at).toBe(1);
  expect(Object.values(walked.steps).every(step => step.answered)).toBe(true);
  expect(walked.empty).toBe(false);
});
