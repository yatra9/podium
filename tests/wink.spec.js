const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

// Winking at the page to turn it. The whole point of the gesture is that it
// refuses far more than it accepts: a blink closes both eyes and must do
// nothing, a glance must not fill the gauge, and a face that is not being
// followed properly must not be read at all. None of that needs a camera to
// check -- WinkJudge is fed one plain object per video frame and says what it
// makes of the gesture -- so these play frames at it the way a blink, a wink,
// a turned head or a stalled model would arrive, and never open a device.
const pageFile = path.join(__dirname, "..", "build", "podium.html");
test.skip(!fs.existsSync(pageFile), "build/podium.html is missing; run build.py --podium");

test.beforeEach(async ({ page }) => {
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._WinkJudge_);
});

const LIMITS = {
  closed: 0.7, open: 0.3, showMs: 100, fireMs: 400,
  cooldownMs: 800, restMs: 400, fpsMin: 7, gapMs: 250, sepMin: 110,
};

// A run of frames at a steady rate. Each span is a stretch of time the face
// held one expression: { ms, left, right } plus anything else a sample carries
// (yaw, eyes, fps, face), which defaults to a face being followed squarely.
function frames(spans, { fps = 15, t0 = 1000 } = {}) {
  const step = 1000 / fps;
  const out = [];
  let t = t0;
  for (const { ms, ...sample } of spans) {
    const until = t + ms;
    while (t < until) {
      out.push({
        t: Math.round(t), face: true, left: 0, right: 0, fps,
        eyes: { left: { x: 0.4, y: 0.4 }, right: { x: 0.6, y: 0.4 } },
        sep: 160, yaw: 0, pitch: 0, roll: 0,
        ...sample,
      });
      t += step;
    }
  }
  return out;
}

// Both eyes resting open for long enough that a wink made after it counts.
const settled = { ms: 600, left: 0.05, right: 0.05 };

// Play the frames and report what the judge made of each one.
async function play(page, spans, { limits = {}, sides = {}, fps = 15 } = {}) {
  const samples = frames(spans, { fps });
  return page.evaluate(([samples, limits, sides]) => {
    const judge = new window._WinkJudge_(limits, sides);
    return samples.map(sample => ({ t: sample.t, ...judge.feed(sample) }));
  }, [samples, { ...LIMITS, ...limits }, sides]);
}

const turns = (verdicts) => verdicts.filter(v => v.turn).map(v => v.turn);
const charged = (verdicts) => verdicts.filter(v => v.state == "charging");

test("a blink turns no page and shows no gauge", async ({ page }) => {
  // Both eyes, 120ms, which is an ordinary blink. The eyes pass through the
  // middle of the range on the way down and back, so this also covers the gap
  // between open and closed being read as neither.
  const verdicts = await play(page, [
    settled,
    { ms: 60, left: 0.5, right: 0.5 },
    { ms: 120, left: 0.95, right: 0.95 },
    { ms: 60, left: 0.5, right: 0.5 },
    { ms: 600, left: 0.05, right: 0.05 },
  ]);

  expect(turns(verdicts)).toEqual([]);
  expect(charged(verdicts)).toEqual([]);
  expect(verdicts.every(v => v.progress == 0)).toBe(true);
  // And it said why it was not listening, rather than just going quiet.
  expect(verdicts.some(v => v.why == "eyes-shut")).toBe(true);
});

test("a wink too short to charge turns no page", async ({ page }) => {
  // 200ms is past the gauge appearing and well short of the turn: the player
  // should see it start and see it come to nothing.
  const verdicts = await play(page, [
    settled,
    { ms: 200, left: 0.05, right: 0.9 },
    { ms: 600, left: 0.05, right: 0.05 },
  ]);

  expect(turns(verdicts)).toEqual([]);
  expect(charged(verdicts).length).toBeGreaterThan(0);
  expect(Math.max(...verdicts.map(v => v.progress))).toBeLessThan(1);
});

test("a held wink turns the page once, and fills the gauge on the way", async ({ page }) => {
  const verdicts = await play(page, [
    settled,
    { ms: 500, left: 0.05, right: 0.9 },
    { ms: 600, left: 0.05, right: 0.05 },
  ]);

  expect(turns(verdicts)).toEqual(["next"]);
  // The gauge is monotonic while charging and reaches the top: a player
  // watching it must be able to trust it as a countdown.
  const fill = charged(verdicts).map(v => v.progress);
  expect(fill.length).toBeGreaterThan(1);
  expect(fill).toEqual([...fill].sort((a, b) => a - b));
  expect(Math.max(...fill)).toBeLessThanOrEqual(1);
  // It charged in the direction the eye asked for, all the way along.
  expect(charged(verdicts).every(v => v.direction == "next")).toBe(true);
});

test("opening the eye part way calls the turn off", async ({ page }) => {
  // 300ms is past the gauge and short of the turn. The gauge has to go away
  // the moment the eye opens, or the player cannot tell a cancel from a turn.
  const verdicts = await play(page, [
    settled,
    { ms: 300, left: 0.05, right: 0.9 },
    { ms: 600, left: 0.05, right: 0.05 },
  ]);

  expect(turns(verdicts)).toEqual([]);
  expect(charged(verdicts).length).toBeGreaterThan(0);
  expect(verdicts.at(-1).state).toBe("idle");
  expect(verdicts.at(-1).progress).toBe(0);
});

test("an eye held shut does not walk through the score", async ({ page }) => {
  // Two seconds of one eye shut: two and a half cooldowns, so a judge that
  // only had a cooldown and no latch would turn three pages.
  const verdicts = await play(page, [
    settled,
    { ms: 2000, left: 0.05, right: 0.9 },
    { ms: 600, left: 0.05, right: 0.05 },
  ]);

  expect(turns(verdicts)).toEqual(["next"]);
});

test("opening the eye and winking again turns the next page", async ({ page }) => {
  const verdicts = await play(page, [
    settled,
    { ms: 500, left: 0.05, right: 0.9 },
    // Long enough to clear the cooldown and settle again, which is what the
    // player is doing anyway while they watch the page move.
    { ms: 1200, left: 0.05, right: 0.05 },
    { ms: 500, left: 0.05, right: 0.9 },
    { ms: 300, left: 0.05, right: 0.05 },
  ]);

  expect(turns(verdicts)).toEqual(["next", "next"]);
});

test("a wink inside the cooldown is ignored", async ({ page }) => {
  const verdicts = await play(page, [
    settled,
    { ms: 500, left: 0.05, right: 0.9 },
    // Open just long enough to clear the latch, then ask again immediately.
    { ms: 100, left: 0.05, right: 0.05 },
    { ms: 500, left: 0.05, right: 0.9 },
  ]);

  expect(turns(verdicts)).toEqual(["next"]);
});

test("each eye asks for its own direction, and the sides can be swapped", async ({ page }) => {
  const spans = [
    settled,
    { ms: 500, left: 0.9, right: 0.05 },
    { ms: 1200, left: 0.05, right: 0.05 },
    { ms: 500, left: 0.05, right: 0.9 },
    { ms: 300, left: 0.05, right: 0.05 },
  ];

  expect(turns(await play(page, spans))).toEqual(["prev", "next"]);
  // A player who finds the mapping back to front swaps it, and a player who
  // can only wink one eye switches the other direction off rather than live
  // with an eye that turns the page the wrong way.
  const swapped = { left: "next", right: "prev" };
  expect(turns(await play(page, spans, { sides: swapped }))).toEqual(["next", "prev"]);
  expect(turns(await play(page, spans, { sides: { left: null } }))).toEqual(["next"]);
});

test("glancing from one eye to the other starts the gesture over", async ({ page }) => {
  // 300ms of each: neither reaches the turn, and a judge that carried the
  // charge from the first eye to the second would turn a page on 600ms of
  // something the player never asked for.
  const verdicts = await play(page, [
    settled,
    { ms: 300, left: 0.9, right: 0.05 },
    { ms: 300, left: 0.05, right: 0.9 },
    { ms: 600, left: 0.05, right: 0.05 },
  ]);

  expect(turns(verdicts)).toEqual([]);
});

test("a wink is not read from a face that is not being followed", async ({ page }) => {
  const held = { ms: 600, left: 0.05, right: 0.9 };
  const cases = {
    // No face in the frame at all.
    "no-face": { ...held, face: false },
    // Turned away, as a flute is played: past this angle the eye on the far
    // side is not really being seen, so the difference a wink is read from
    // stops meaning anything.
    turned: { ...held, yaw: 50 },
    tilted: { ...held, pitch: 45 },
    rolled: { ...held, roll: 40 },
    // An eye off the edge of the frame. The model fits a whole face even where
    // half of it is missing, so the landmark still arrives, just made up.
    "eye-right-out": { ...held, eyes: { left: { x: 0.4, y: 0.4 }, right: { x: 1.3, y: 0.4 } } },
    // The model stalled: held times measured a tenth of a second against are
    // guesswork at three frames a second, so the gesture is refused.
    slow: { ...held, fps: 3 },
    // Too far away. The eye scores drift about the middle of their range at
    // this size whatever the eyes do, so there is nothing to read a wink
    // from -- measured at 69 px, where five deliberate winks went unread by
    // every threshold in a grid of 144.
    far: { ...held, sep: 69 },
  };

  for (const [why, span] of Object.entries(cases)) {
    const verdicts = await play(page, [settled, span]);
    expect(turns(verdicts), why).toEqual([]);
    expect(charged(verdicts), why).toEqual([]);
    // The last word on it names what was wrong, so the panel can tell the
    // player which thing to go and fix.
    expect(verdicts.at(-1).track, why).toBe(false);
    expect(verdicts.at(-1).why, why).toBe(why);
  }
});

test("ready says whether a wink made now would be read", async ({ page }) => {
  const verdicts = await play(page, [
    // The face arrives mid-blink, so it is neither ready nor settled.
    { ms: 200, left: 0.9, right: 0.9 },
    { ms: 600, left: 0.05, right: 0.05 },
    { ms: 300, face: false, left: 0.05, right: 0.05 },
    { ms: 600, left: 0.05, right: 0.05 },
  ]);

  const why = (ms) => verdicts.find(v => v.t >= 1000 + ms).why;
  // Eyes shut; then open but not yet settled; then settled and ready.
  expect(why(0)).toBe("eyes-shut");
  expect(why(250)).toBe("settling");
  expect(why(700)).toBe("ready");
  // The face goes away and comes back: the rest clock starts again from the
  // frame it came back on, because the eye could have been shut the whole time
  // the face was missing.
  expect(why(900)).toBe("no-face");
  expect(why(1200)).toBe("settling");
  expect(verdicts.at(-1).ready).toBe(true);
  expect(verdicts.at(-1).why).toBe("ready");
});

test("a wink is not believed until the eyes have rested", async ({ page }) => {
  // One eye shut from the very first frame: the face was never seen resting,
  // so this could as easily be a face that arrived mid-blink as a wink.
  const verdicts = await play(page, [{ ms: 800, left: 0.05, right: 0.9 }]);

  expect(turns(verdicts)).toEqual([]);
});

test("a face too small to read its eyelids is refused, and says so", async ({ page }) => {
  // The size is in pixels across the face, not in how much of the frame it
  // fills: the model crops the face and resizes that crop to its own input, so
  // a bigger capture of the same distant face is a better reading. A sample
  // from before this was measured carries no separation, and is taken at its
  // word rather than refused.
  const held = { ms: 600, left: 0.05, right: 0.9 };
  expect(turns(await play(page, [settled, { ...held, sep: 69 }]))).toEqual([]);
  expect(turns(await play(page, [settled, { ...held, sep: 160 }]))).toEqual(["next"]);
  const legacy = frames([settled, held]).map(({ sep, ...rest }) => rest);
  const verdicts = await page.evaluate(([samples, limits]) => {
    const judge = new window._WinkJudge_(limits);
    return samples.map(sample => judge.feed(sample));
  }, [legacy, LIMITS]);
  expect(verdicts.filter(v => v.turn).map(v => v.turn)).toEqual(["next"]);
});

test("a wink in the recovery of a blink is treated as the blink", async ({ page }) => {
  // This is what restMs is for. A blink spends the rest that came before it,
  // so the wink that follows has to wait for a rest of its own -- otherwise
  // "blink, then hold one eye" reads as a deliberate wink, which is the
  // commonest thing a face does by accident.
  const verdicts = await play(page, [
    settled,
    { ms: 150, left: 0.95, right: 0.95 },
    { ms: 500, left: 0.05, right: 0.9 },
  ]);

  expect(turns(verdicts)).toEqual([]);
  // And once the eyes have rested again, the same wink counts.
  expect(turns(await play(page, [
    settled,
    { ms: 150, left: 0.95, right: 0.95 },
    { ms: 600, left: 0.05, right: 0.05 },
    { ms: 500, left: 0.05, right: 0.9 },
  ]))).toEqual(["next"]);
});

test("the lid passing through the middle of its range still begins a wink", async ({ page }) => {
  // The other side of the test above: an eye on its way shut is briefly
  // neither open nor closed, and that must not be read as spending the rest,
  // or no wink could ever start.
  const verdicts = await play(page, [
    settled,
    { ms: 80, left: 0.05, right: 0.5 },
    { ms: 500, left: 0.05, right: 0.9 },
  ]);

  expect(turns(verdicts)).toEqual(["next"]);
});

test("the ring does not say ready while the cooldown is running", async ({ page }) => {
  // A green ring means "wink now and it will count". During the cooldown a
  // wink is thrown away, so saying ready would be inviting the player to make
  // one for nothing -- and to conclude the whole feature is unreliable.
  const verdicts = await play(page, [
    settled,
    { ms: 500, left: 0.05, right: 0.9 },
    { ms: 900, left: 0.05, right: 0.05 },
  ]);

  const fired = verdicts.findIndex(v => v.turn);
  expect(fired).toBeGreaterThan(-1);
  const cooling = verdicts.filter(v => v.state == "cooldown");
  expect(cooling.length).toBeGreaterThan(1);
  expect(cooling.every(v => v.ready == false)).toBe(true);
  expect(cooling.every(v => v.why == "cooling")).toBe(true);
  // And once it has passed, the ring comes back.
  expect(verdicts.at(-1).ready).toBe(true);
});

test("a wink cannot be held through a stall", async ({ page }) => {
  // Held time comes from the clock, not from a count of frames, so a gap in
  // the frames is the one way a gesture can appear to have been held for
  // longer than it was. A backgrounded tab, a big page being rendered, the
  // model losing its GPU context: the clock runs on through all of them, and
  // what the eye did meanwhile is simply not known.
  //
  // So: 150ms of wink, a stall, then 150ms more. Neither half is long enough
  // to turn a page, and the two together must not be either.
  const before = frames([settled, { ms: 150, left: 0.05, right: 0.9 }]);
  const after = frames([{ ms: 150, left: 0.05, right: 0.9 }], { t0: 4000 });
  const verdicts = await page.evaluate(([samples, limits]) => {
    const judge = new window._WinkJudge_(limits);
    return samples.map(sample => judge.feed(sample));
  }, [[...before, ...after], LIMITS]);

  expect(verdicts.filter(v => v.turn)).toEqual([]);
  // And the gesture starts over rather than carrying on, so the frame after
  // the stall is back to idle however long the eye had been shut.
  expect(verdicts[before.length].state).toBe("idle");
});

test("head rotation is read out of the model's matrix in degrees", async ({ page }) => {
  const pose = await page.evaluate(() => {
    // Column-major, as MediaPipe hands them over: a turn about each axis in
    // turn, by an angle no limit would pass.
    const rad = 30 * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    const about = {
      yaw: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1],
      pitch: [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1],
      roll: [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      identity: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    };
    // `|| 0` only to fold the negative zero an exactly-zero angle rounds to,
    // which is the same angle but not the same value to a deep compare.
    const round = (p) => ({
      yaw: Math.round(p.yaw) || 0,
      pitch: Math.round(p.pitch) || 0,
      roll: Math.round(p.roll) || 0,
    });
    return {
      yaw: round(window._winkPose_(about.yaw)),
      pitch: round(window._winkPose_(about.pitch)),
      roll: round(window._winkPose_(about.roll)),
      identity: round(window._winkPose_(about.identity)),
      // The model hands the matrix over wrapped in an object with a data
      // array, and a frame with no face hands over nothing at all.
      wrapped: round(window._winkPose_({ data: about.yaw })),
      missing: round(window._winkPose_(null)),
    };
  });

  expect(pose.identity).toEqual({ yaw: 0, pitch: 0, roll: 0 });
  expect(pose.yaw).toEqual({ yaw: 30, pitch: 0, roll: 0 });
  expect(pose.pitch).toEqual({ yaw: 0, pitch: 30, roll: 0 });
  expect(pose.roll).toEqual({ yaw: 0, pitch: 0, roll: 30 });
  expect(pose.wrapped).toEqual({ yaw: 30, pitch: 0, roll: 0 });
  expect(pose.missing).toEqual({ yaw: 0, pitch: 0, roll: 0 });
});
