const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

// Replay real recordings through the real judge.
//
// Everything else about this gesture can be argued from made-up frames, but
// not the one question that matters: does it read the winks a person actually
// makes, and does it stay silent through everything else their face does? So
// recordings saved from the Wink panel are checked in beside this file and
// played back through WinkJudge exactly as the camera delivered them.
//
// Each recording carries the frames the reader marked, pressed just after a
// wink they meant. The marks are what makes this a test rather than a demo.
//
// The directory is not in the repository. A recording holds no picture, but it
// does hold a few hundred rows of measurements of somebody's face, and whether
// that gets published is theirs to decide rather than this file's. Drop CSVs
// saved from the Wink panel into tests/recordings/ and these run; with none
// there they skip.
const pageFile = path.join(__dirname, "..", "build", "podium.html");
test.skip(!fs.existsSync(pageFile), "build/podium.html is missing; run build.py --podium");

const recordings = path.join(__dirname, "recordings");

// The reader presses Mark after the wink, not during it, so a turn counts as
// having caught a mark if it lands in the window before one.
const BEFORE_MARK = 1800, AFTER_MARK = 200;

function read(file) {
  const lines = fs.readFileSync(path.join(recordings, file), "utf8").trim().split("\n");
  const head = lines[0].split(",");
  return lines.slice(1).map(line => {
    const cells = line.split(",");
    // A recording from an older build is missing whole columns -- the eye
    // separation arrived after the first ones were made -- and a missing
    // column must read as absent, not as a NaN the judge would compare
    // against and refuse.
    const raw = (name) => {
      const at = head.indexOf(name);
      return at < 0 ? undefined : cells[at];
    };
    const num = (name) => {
      const cell = raw(name);
      return cell === undefined || cell === "" ? undefined : Number(cell);
    };
    return {
      t: num("t"),
      mark: (raw("mark") ?? "") !== "",
      face: raw("face") === "1",
      left: num("left") ?? 0,
      right: num("right") ?? 0,
      sep: num("sep"),
      yaw: num("yaw") ?? 0, pitch: num("pitch") ?? 0, roll: num("roll") ?? 0,
      eyes: {
        left: { x: num("eyeLeftX"), y: num("eyeLeftY") },
        right: { x: num("eyeRightX"), y: num("eyeRightY") },
      },
      fps: num("fps") ?? 0,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._WinkJudge_);
});

async function replay(page, samples, limits = {}) {
  return page.evaluate(([samples, limits]) => {
    const judge = new window._WinkJudge_(limits);
    const turns = [];
    let learnt = 0, ready = 0;
    for (const sample of samples) {
      const verdict = judge.feed(sample);
      if (verdict.rest) learnt++;
      if (verdict.ready) ready++;
      if (verdict.turn) turns.push({ t: sample.t, turn: verdict.turn });
    }
    return { turns, learnt, ready, frames: samples.length };
  }, [samples, limits]);
}

function score(samples, turns) {
  const marks = samples.filter(s => s.mark).map(s => s.t);
  const caught = new Set();
  let stray = 0;
  for (const { t } of turns) {
    const hit = marks.find(m => m - t >= -AFTER_MARK && m - t <= BEFORE_MARK);
    if (hit === undefined) stray++;
    else caught.add(hit);
  }
  return { marks: marks.length, caught: caught.size, stray };
}

const files = fs.existsSync(recordings)
  ? fs.readdirSync(recordings).filter(name => name.endsWith(".csv")).sort()
  : [];

test.skip(!files.length, "tests/recordings holds no CSV to replay");

for (const file of files) {
  test(`${file} turns no page nobody asked for`, async ({ page }) => {
    // This is the assertion the whole design answers to. A page that turns
    // itself in the middle of a phrase is worse than a page that has to be
    // asked twice, so a false turn anywhere in a real recording is a failure
    // however many real winks were caught.
    const samples = read(file);
    const { turns } = await replay(page, samples);
    const out = score(samples, turns);
    const t0 = samples[0].t;
    const when = turns.map(({ t, turn }) => `${((t - t0) / 1000).toFixed(2)}s ${turn}`);

    expect(out.stray, `turns: ${when.join(", ") || "none"}`).toBe(0);
  });

  test(`${file} learns this face and reads winks from it`, async ({ page }) => {
    const samples = read(file);
    const { turns, learnt, frames } = await replay(page, samples);
    const out = score(samples, turns);
    const readable = samples.filter(s => s.sep === undefined || s.sep >= 110).length;

    if (readable < frames / 2) {
      // A recording of a face too far from the camera to read the lids at all.
      // Keeping it is the point: it is the evidence for the size floor, and a
      // change that started reading winks out of it would be reading noise.
      expect(out.caught, "nothing should be read from a face this small").toBe(0);
      return;
    }

    // The scale is learnt from blinking, which takes a few seconds of face;
    // after that it should hold for the rest of the recording.
    expect(learnt).toBeGreaterThan(frames / 2);
    // And the winks the reader meant should mostly arrive. "Mostly" on
    // purpose: these were made before the hold was set to half a second, so
    // the shorter ones are meant to be refused.
    expect(out.caught).toBeGreaterThan(0);
  });
}
