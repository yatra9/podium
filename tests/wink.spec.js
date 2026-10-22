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
//
// A wink is read from how far apart the two eyes are *relative to this
// player's own resting level*, because the model's raw scores measure nothing
// absolute: in two real recordings they sat around 0.45 whatever the eyes did
// and moved between sessions. So the frames here are written in the units the
// model really produces -- a resting level well away from zero, a range
// narrower than 0..1, and the two eyes not even alike -- and the judge is
// expected to find that range for itself.
const pageFile = path.join(__dirname, "..", "build", "podium.html");
test.skip(!fs.existsSync(pageFile), "build/podium.html is missing; run build.py --podium");

test.beforeEach(async ({ page }) => {
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._WinkJudge_);
});

const LIMITS = {
  start: 0.2, hold: 0.5, shut: 0.35, showMs: 100, fireMs: 500,
  cooldownMs: 800, restMs: 400, restOpen: 0.3, fpsMin: 7, gapMs: 250,
  sepMin: 110, restSec: 6, restQuantile: 0.2, peakSec: 30, minSpan: 0.15,
};

// This imaginary player's eyes, in the model's own units. Taken from the real
// recordings: open nowhere near zero, shut nowhere near one, and the left eye
// reading differently from the right throughout.
const OPEN = { left: 0.42, right: 0.33 };
const SHUT = { left: 0.81, right: 0.74 };

// How shut each eye is, as a fraction of this player's own range.
function eyes(left, right) {
  return {
    left: OPEN.left + (SHUT.left - OPEN.left) * left,
    right: OPEN.right + (SHUT.right - OPEN.right) * right,
  };
}

// A run of frames at a steady rate. Each span is a stretch of time the face
// held one expression: { ms, left, right } as fractions of the player's range,
// plus anything else a sample carries (yaw, eyes, fps, face, sep), which
// defaults to a face being followed squarely and close enough to read.
function frames(spans, { fps = 15, t0 = 1000 } = {}) {
  const step = 1000 / fps;
  const out = [];
  let t = t0;
  for (const { ms, left = 0, right = 0, ...rest } of spans) {
    const until = t + ms;
    while (t < until) {
      out.push({
        t: Math.round(t), face: true, fps, ...eyes(left, right),
        eyes: { left: { x: 0.4, y: 0.4 }, right: { x: 0.6, y: 0.4 } },
        sep: 160, yaw: 0, pitch: 0, roll: 0,
        ...rest,
      });
      t += step;
    }
  }
  return out;
}

// Blinking is what teaches the judge this player's range, and it happens by
// itself every few seconds. Nothing can be read until it has.
const blink = (ms = 130) => [
  { ms: 60, left: 0.45, right: 0.45 },
  { ms, left: 1, right: 1 },
  { ms: 60, left: 0.45, right: 0.45 },
];

// Enough time open, with a couple of blinks in it, for the range to be learnt
// and the eyes to have settled afterwards.
const settled = [
  { ms: 900, left: 0.02, right: 0.02 },
  ...blink(),
  { ms: 900, left: 0.02, right: 0.02 },
  ...blink(),
  { ms: 900, left: 0.02, right: 0.02 },
];

async function play(page, spans, { limits = {}, sides = {}, fps = 15 } = {}) {
  const samples = frames(spans, { fps });
  return page.evaluate(([samples, limits, sides]) => {
    const judge = new window._WinkJudge_(limits, sides);
    return samples.map(sample => ({ t: sample.t, ...judge.feed(sample) }));
  }, [samples, { ...LIMITS, ...limits }, sides]);
}

const turns = (verdicts) => verdicts.filter(v => v.turn).map(v => v.turn);
const charged = (verdicts) => verdicts.filter(v => v.state == "charging");

test("the range is learnt from the player, not assumed", async ({ page }) => {
  // The judge is given eyes that rest at 0.42 and 0.33 and shut at 0.81 and
  // 0.74 -- nothing like 0 and 1, and not even alike. It has to find that for
  // itself, and refuse to read anything until it has.
  const verdicts = await play(page, [
    { ms: 800, left: 0.02, right: 0.02 },
    ...blink(),
    { ms: 900, left: 0.02, right: 0.02 },
  ]);

  // Before any blink there is no range, and the judge says so rather than
  // guessing: nothing is ready and nothing could fire.
  expect(verdicts[5].why).toBe("learning");
  expect(verdicts[5].ready).toBe(false);
  expect(verdicts[5].rest).toBe(null);

  // Afterwards it has found both ends of both eyes, close to the truth.
  const last = verdicts.at(-1);
  expect(last.rest.left).toBeCloseTo(OPEN.left, 1);
  expect(last.rest.right).toBeCloseTo(OPEN.right, 1);
  expect(last.peak.left).toBeCloseTo(SHUT.left, 1);
  expect(last.peak.right).toBeCloseTo(SHUT.right, 1);
  // And in those units the resting eyes read as open, so a wink would count.
  expect(last.norm.left).toBeLessThan(0.1);
  expect(last.ready).toBe(true);
  expect(last.why).toBe("ready");
});

test("a blink turns no page and shows no gauge", async ({ page }) => {
  // Both eyes together, which is what a blink is. They pass through the middle
  // of the range on the way down and back, so this also covers the halfway
  // point being read as neither.
  const verdicts = await play(page, [
    ...settled,
    { ms: 60, left: 0.5, right: 0.5 },
    { ms: 150, left: 1, right: 1 },
    { ms: 60, left: 0.5, right: 0.5 },
    { ms: 900, left: 0.02, right: 0.02 },
  ]);

  expect(turns(verdicts)).toEqual([]);
  expect(charged(verdicts)).toEqual([]);
  // A blink leaves the two eyes level, which is the whole reason it is safe to
  // read a wink from the difference between them.
  const shut = verdicts.filter(v => v.why == "eyes-shut");
  expect(shut.length).toBeGreaterThan(0);
  expect(Math.max(...shut.map(v => Math.abs(v.gap)))).toBeLessThan(LIMITS.start);
});

test("a blink is still a blink when the two eyes are not quite together", async ({ page }) => {
  // Real blinks are not symmetrical. This one is 0.15 of the range out of step
  // at its worst, and must still not be read as a wink.
  const verdicts = await play(page, [
    ...settled,
    { ms: 70, left: 0.55, right: 0.40 },
    { ms: 140, left: 1, right: 0.88 },
    { ms: 70, left: 0.50, right: 0.38 },
    { ms: 900, left: 0.02, right: 0.02 },
  ]);

  expect(turns(verdicts)).toEqual([]);
  expect(charged(verdicts)).toEqual([]);
});

test("a held wink turns the page once, and fills the gauge on the way", async ({ page }) => {
  const verdicts = await play(page, [
    ...settled,
    { ms: 700, left: 0.05, right: 0.95 },
    { ms: 900, left: 0.02, right: 0.02 },
  ]);

  expect(turns(verdicts)).toEqual(["next"]);
  // The gauge is monotonic while charging and reaches the top: a player
  // watching it must be able to trust it as a countdown.
  const fill = charged(verdicts).map(v => v.progress);
  expect(fill.length).toBeGreaterThan(1);
  expect(fill).toEqual([...fill].sort((a, b) => a - b));
  expect(Math.max(...fill)).toBeLessThanOrEqual(1);
  expect(charged(verdicts).every(v => v.direction == "next")).toBe(true);
});

test("a wink shorter than the hold turns no page", async ({ page }) => {
  // 300ms is past the gauge appearing and well short of the 500ms turn. The
  // recordings say an unprompted wink lasts about this long, which is exactly
  // why the hold is deliberately longer than one: a page that turns itself
  // mid-phrase costs more than a wink that has to be held on purpose.
  const verdicts = await play(page, [
    ...settled,
    { ms: 300, left: 0.05, right: 0.95 },
    { ms: 900, left: 0.02, right: 0.02 },
  ]);

  expect(turns(verdicts)).toEqual([]);
  expect(charged(verdicts).length).toBeGreaterThan(0);
  expect(Math.max(...verdicts.map(v => v.progress))).toBeLessThan(1);
});

test("a wink survives the open eye drifting shut with it", async ({ page }) => {
  // Winking screws up that side of the face and the other eye comes part way
  // with it: in the recordings the open eye reached 0.7 of its range while the
  // winking one was at 0.9. Demanding that it stay wide open would refuse most
  // real winks, so what is asked is only that the two stay far enough apart.
  const verdicts = await play(page, [
    ...settled,
    { ms: 120, left: 0.30, right: 0.55 },
    { ms: 700, left: 0.55, right: 0.95 },
    { ms: 900, left: 0.02, right: 0.02 },
  ]);

  expect(turns(verdicts)).toEqual(["next"]);
});

test("a wink is not read from the other eye opening wider", async ({ page }) => {
  // A difference can also be made by one eye opening *wider* than it usually
  // sits, which is not a wink. The normalised scale floors at the resting
  // level, so this shows up as a difference with neither eye closing -- which
  // is what `shut` is there to refuse.
  const verdicts = await play(page, [
    ...settled,
    { ms: 800, left: 0.30, right: -0.6 },
    { ms: 900, left: 0.02, right: 0.02 },
  ]);

  expect(turns(verdicts)).toEqual([]);
  expect(charged(verdicts)).toEqual([]);
});

test("opening the eye part way calls the turn off", async ({ page }) => {
  const verdicts = await play(page, [
    ...settled,
    { ms: 350, left: 0.05, right: 0.95 },
    { ms: 900, left: 0.02, right: 0.02 },
  ]);

  expect(turns(verdicts)).toEqual([]);
  expect(charged(verdicts).length).toBeGreaterThan(0);
  expect(verdicts.at(-1).state).toBe("idle");
  expect(verdicts.at(-1).progress).toBe(0);
});

test("an eye held shut does not walk through the score", async ({ page }) => {
  // Two and a half seconds of one eye shut: three cooldowns, so a judge that
  // only had a cooldown and no spent rest would turn three pages.
  const verdicts = await play(page, [
    ...settled,
    { ms: 2500, left: 0.05, right: 0.95 },
    { ms: 900, left: 0.02, right: 0.02 },
  ]);

  expect(turns(verdicts)).toEqual(["next"]);
});

test("opening the eye and winking again turns the next page", async ({ page }) => {
  const verdicts = await play(page, [
    ...settled,
    { ms: 700, left: 0.05, right: 0.95 },
    // Long enough to clear the cooldown and settle again, which is what the
    // player is doing anyway while they watch the page move.
    { ms: 1400, left: 0.02, right: 0.02 },
    { ms: 700, left: 0.05, right: 0.95 },
    { ms: 400, left: 0.02, right: 0.02 },
  ]);

  expect(turns(verdicts)).toEqual(["next", "next"]);
});

test("a wink inside the cooldown is ignored", async ({ page }) => {
  const verdicts = await play(page, [
    ...settled,
    { ms: 700, left: 0.05, right: 0.95 },
    // Open only briefly, then ask again at once.
    { ms: 120, left: 0.02, right: 0.02 },
    { ms: 700, left: 0.05, right: 0.95 },
  ]);

  expect(turns(verdicts)).toEqual(["next"]);
});

test("each eye asks for its own direction, and the sides can be swapped", async ({ page }) => {
  const spans = [
    ...settled,
    { ms: 700, left: 0.95, right: 0.05 },
    { ms: 1400, left: 0.02, right: 0.02 },
    { ms: 700, left: 0.05, right: 0.95 },
    { ms: 400, left: 0.02, right: 0.02 },
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
  // 350ms of each: neither reaches the turn, and a judge that carried the
  // charge from the first eye to the second would turn a page on 700ms of
  // something the player never asked for.
  const verdicts = await play(page, [
    ...settled,
    { ms: 350, left: 0.95, right: 0.05 },
    { ms: 350, left: 0.05, right: 0.95 },
    { ms: 900, left: 0.02, right: 0.02 },
  ]);

  expect(turns(verdicts)).toEqual([]);
});

test("a wink is not read from a face that is not being followed", async ({ page }) => {
  const held = { ms: 800, left: 0.05, right: 0.95 };
  const cases = {
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
    // The model stalled: held times measured half a second against are
    // guesswork at three frames a second.
    slow: { ...held, fps: 3 },
    // Too far away. Measured at 69 px between the eye centres, where the
    // scores drifted about the middle of their range whatever the eyes did and
    // five deliberate winks went unread by every threshold in a grid of 144.
    far: { ...held, sep: 69 },
  };

  for (const [why, span] of Object.entries(cases)) {
    const verdicts = await play(page, [...settled, span]);
    expect(turns(verdicts), why).toEqual([]);
    expect(charged(verdicts), why).toEqual([]);
    expect(verdicts.at(-1).track, why).toBe(false);
    expect(verdicts.at(-1).why, why).toBe(why);
  }
});

test("ready says whether a wink made now would be read", async ({ page }) => {
  const verdicts = await play(page, [
    ...settled,
    { ms: 200, left: 1, right: 1 },
    { ms: 700, left: 0.02, right: 0.02 },
    { ms: 300, face: false },
    { ms: 700, left: 0.02, right: 0.02 },
  ]);

  const from = frames(settled).length;
  const after = (ms) => verdicts.find(v => v.t >= verdicts[from].t + ms).why;
  // Eyes shut; then open but not yet settled; then settled and ready.
  expect(after(0)).toBe("eyes-shut");
  expect(after(300)).toBe("settling");
  expect(after(800)).toBe("ready");
  // The face goes away and comes back: the rest clock starts again from the
  // frame it came back on, because the eye could have been shut the whole time
  // the face was missing.
  expect(after(1000)).toBe("no-face");
  expect(after(1300)).toBe("settling");
  expect(verdicts.at(-1).ready).toBe(true);
});

test("a wink is not believed until the eyes have rested", async ({ page }) => {
  // One eye shut from the moment the range was learnt: the face was never seen
  // resting, so this could as easily be a face that arrived mid-blink.
  const verdicts = await play(page, [
    { ms: 600, left: 0.02, right: 0.02 },
    ...blink(),
    { ms: 900, left: 0.05, right: 0.95 },
  ]);

  expect(turns(verdicts)).toEqual([]);
});

test("a wink cannot be held through a stall", async ({ page }) => {
  // Held time comes from the clock, not from a count of frames, so a gap in
  // the frames is the one way a gesture can appear to have been held for
  // longer than it was. A backgrounded tab, a big page being rendered, the
  // model losing its GPU context: the clock runs on through all of them, and
  // what the eye did meanwhile is simply not known.
  const before = frames([...settled, { ms: 300, left: 0.05, right: 0.95 }]);
  const after = frames([{ ms: 300, left: 0.05, right: 0.95 }],
    { t0: before.at(-1).t + 4000 });
  const verdicts = await page.evaluate(([samples, limits]) => {
    const judge = new window._WinkJudge_(limits);
    return samples.map(sample => judge.feed(sample));
  }, [[...before, ...after], LIMITS]);

  expect(verdicts.filter(v => v.turn)).toEqual([]);
  expect(verdicts[before.length].state).toBe("idle");
});

test("the ring does not say ready while the cooldown is running", async ({ page }) => {
  // A green ring means "wink now and it will count". During the cooldown a
  // wink is thrown away, so saying ready would be inviting the player to make
  // one for nothing -- and to conclude the whole feature is unreliable.
  const verdicts = await play(page, [
    ...settled,
    { ms: 700, left: 0.05, right: 0.95 },
    { ms: 1000, left: 0.02, right: 0.02 },
  ]);

  expect(verdicts.some(v => v.turn)).toBe(true);
  const cooling = verdicts.filter(v => v.state == "cooldown");
  expect(cooling.length).toBeGreaterThan(1);
  expect(cooling.every(v => v.ready == false)).toBe(true);
  expect(cooling.every(v => v.why == "cooling")).toBe(true);
  expect(verdicts.at(-1).ready).toBe(true);
});

test("the range follows the player rather than sticking to one session", async ({ page }) => {
  // The light changes, the player shifts in their seat, the camera gains up:
  // the readings move wholesale. A fixed threshold would be wrong from then on,
  // which is the case that made a learnt scale necessary in the first place.
  //
  // What it costs is a few seconds of refusing to read anything. Until the
  // resting window has flushed the old readings, the judge genuinely does not
  // know where this player's eyes sit any more, and the safe answer to that is
  // to say so rather than to read a wink against a stale notion of open.
  const shift = 0.3;
  const first = frames([...settled, { ms: 700, left: 0.05, right: 0.95 }]);
  const after = frames([
    { ms: 7000, left: 0.02, right: 0.02 },
    ...blink(),
    { ms: 900, left: 0.02, right: 0.02 },
    { ms: 700, left: 0.05, right: 0.95 },
  ], { t0: first.at(-1).t + 70 }).map(sample => ({
    ...sample, left: sample.left + shift, right: sample.right + shift,
  }));

  const verdicts = await page.evaluate(([samples, limits]) => {
    const judge = new window._WinkJudge_(limits);
    return samples.map(sample => judge.feed(sample));
  }, [[...first, ...after], LIMITS]);

  // One turn before the shift and one after it, and nothing spurious in
  // between while the scale was catching up.
  expect(verdicts.filter(v => v.turn).map(v => v.turn)).toEqual(["next", "next"]);
  expect(verdicts.at(-1).rest.left).toBeCloseTo(OPEN.left + shift, 1);
  // It really did take a moment: the frames just after the shift are not ready,
  // so the ring tells the player to wait rather than letting them wink in vain.
  const settling = verdicts.slice(first.length, first.length + 30);
  expect(settling.some(v => !v.ready)).toBe(true);
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
