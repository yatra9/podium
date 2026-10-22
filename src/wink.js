export { WinkJudge, WinkScale, WinkWatch, WinkLog, WinkHud, WinkTurner, WINK_LIMITS, winkPose };
// +skip

/**
  Copyright 2025 Glendon Diener

  This file is part of Podium.

  Podium is free software: you can redistribute it and/or modify it
  under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  Podium is distributed in the hope that it will be useful, but
  WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
  Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public
  License along with Podium. If not, see
  <https://www.gnu.org/licenses/>.
**/

import { clamp, css, dataIndex, helm, Schedule } from "./common.js";
// -skip

/**
  Winking at the page to turn it.

  A player with an instrument in both hands has no hand to spare for the page,
  and a foot pedal is one more thing to carry to the gig. A camera that is
  already pointed at the player's face can do it instead: hold one eye shut for
  a moment and the page turns.

  The hard part is not seeing the eye shut, it is being sure the player meant
  it. A page that turns itself in the middle of a phrase is worse than a page
  that has to be asked twice, so everything here is built to throw a doubtful
  wink away:

    * A blink closes both eyes, so only one eye closed counts at all.
    * A blink is over in about a tenth of a second, so a wink has to be held.
    * Holding it shows a gauge filling, so the player can see the turn coming
      and open the eye to call it off.
    * Nothing counts unless the face was being followed properly to begin with.

  This file is the arithmetic of that, and nothing else: no camera, no model, no
  document. WinkJudge is fed one plain object per video frame and says what
  state the gesture is in and whether the page should turn. That keeps it
  testable without a face in front of a lens -- see tests/wink.spec.js, which
  plays frames at it the way a blink or a wink or a turned head would arrive.

  The camera, the landmark model and the panel that shows all of this live in
  WinkWatch and WinkPanel below.
**/

// The numbers a wink is measured against.
//
// The eye scores themselves are not among them, and that is the point. Two
// recordings settled it: the model's eyeBlink readings sat around 0.45 whatever
// the eyes did, never came near zero, and moved between sessions. An absolute
// threshold tuned on one machine means nothing on the next. So a wink is read
// from where each eye sits *relative to this player's own resting level,
// measured over the last few seconds* -- see WinkScale -- and from the
// difference between the two eyes rather than from either one alone.
//
// What is left here is timing and geometry, which do carry across.
const WINK_LIMITS = {
  // How far apart the two normalised eyes must be for a wink to begin. This is
  // the measurement that does the real work: across 41 seconds of recording
  // and more than a dozen blinks, not one blink put the eyes this far apart,
  // while every deliberate wink did. A blink closes both eyes together, so it
  // cancels out of a difference between them.
  start: 0.2,
  // Having begun, the gesture survives while the difference stays above
  // `start * hold`. A wink is not steady -- the open eye drifts up as the face
  // squints with it -- and a gesture that dropped out on one ragged frame
  // would be unusable.
  hold: 0.5,
  // The eye that is closing must get at least this far from its own resting
  // level. Without it, a difference made entirely by the *other* eye opening
  // wider than usual would read as a wink.
  shut: 0.35,
  // A blink is 50-150ms, so nothing at all happens before `showMs` and the
  // page does not turn before `fireMs`. The gauge fills across that gap, so
  // widening it makes the gesture both safer and slower to perform.
  //
  // 500ms is deliberately longer than the 300ms that caught the most winks in
  // the recordings. A page that turns itself mid-phrase is the one failure
  // worth paying to avoid, and what it costs is only that a wink has to be
  // held on purpose -- which a player can learn -- rather than any loss of
  // safety: no blink in those recordings produced a difference at all.
  showMs: 100,
  fireMs: 500,
  // After a turn, how long before another wink is looked at. Covers the page
  // animation and stops a long-held eye from walking through the score.
  cooldownMs: 800,
  // How long both eyes must have been seen resting near their own open level
  // before a wink is believed, and how near "resting" has to be. Being
  // relative, this still works for a player whose eyes never read as fully
  // open at all.
  restMs: 400,
  restOpen: 0.3,
  // The windows the resting and closed levels are learnt over.
  //
  // Rest is a low percentile of the last `restSec` seconds rather than the
  // minimum, so that one wide-eyed frame cannot define it. Closed is the
  // highest reading in the last `peakSec`, which blinks supply for free
  // several times a minute -- nobody is asked to calibrate anything. The long
  // window holds a blink or two and is still short enough to follow the light
  // changing or the player shifting in their seat.
  restSec: 6,
  restQuantile: 0.2,
  peakSec: 30,
  // Until the gap between rest and closed is at least this wide, nothing has
  // been seen that could have been a blink, so the scale means nothing. The
  // judge refuses to read a wink until then and says it is still learning.
  minSpan: 0.15,
  // How far the head may be turned, in degrees, and still be read. A flute is
  // played with the head turned away, which is exactly the case this bounds:
  // past some angle one eye is simply not being seen any more, and the
  // left-right difference a wink is read from stops meaning anything.
  yawMax: 32,
  pitchMax: 28,
  rollMax: 24,
  // An eye landmark this far outside the frame is not being seen. In fractions
  // of the frame, so it is independent of the capture size.
  margin: 0.02,
  // How many pixels apart the eyes must be before the lids can be read at all.
  //
  // This is the one that decides whether the whole gesture is possible, and it
  // is in pixels rather than in fractions of the frame on purpose: the model
  // crops the face out of the captured image and resizes that crop to its own
  // input, so what it has to work with is the number of pixels across the
  // face, not the share of the frame the face takes up.
  //
  // Measured, not guessed: a recording at 69 px between the eye centres gave
  // eyeBlink scores that sat around 0.45 whatever the eyes did, eyeWide that
  // never left zero, and five deliberate winks that no threshold in a grid of
  // 144 could pick out. The lid aperture is only a few pixels at that size.
  // 110 is above that and below nothing yet proven to work, so it is a floor
  // to argue with once there is a recording that does work.
  sepMin: 110,
  // Below this many frames a second the held times are too coarse to measure a
  // tenth of a second against, so the gesture is refused rather than guessed.
  fpsMin: 7,
  // A gap between frames longer than this abandons the gesture in progress.
  // Held time is measured from the clock, not counted in frames, so without
  // this a stall -- a backgrounded tab, a big page being rendered, the model
  // losing its GPU context for a moment -- would hand back a held time that
  // had run on through it, and fire a turn nobody completed. Must stay well
  // above the frame interval at fpsMin, or ordinary slowness would read as a
  // stall.
  gapMs: 250,
};

// Which eye asks for which direction. Either side may be null, which switches
// that direction off: a player who can only wink one eye still gets the page
// forward, and forward is the one that matters.
const WINK_SIDES = { left: "prev", right: "next" };

/**
class WinkScale

  What this player's eyes read when they are open, and when they are shut.

  The model's eye scores measure nothing absolute. Across two recordings of one
  person they sat around 0.45 at rest, ranged 0.19 to 0.84, and moved between
  the two sessions; across people, cameras and seating distances there is no
  reason to expect even that much consistency. Tuning a threshold against one
  recording is tuning against that afternoon.

  So the scale is learnt from the player as they sit there, and everything
  above it works in normalised units: 0 is where this eye sits when open, 1 is
  as shut as it has lately been seen to get.

  Nobody is asked to calibrate. Blinking does it -- an involuntary blink every
  few seconds supplies the top of the range, and the stretches between them
  supply the bottom. Until a blink has been seen, feed() says so by answering
  null, and the judge refuses to read a wink rather than guess at one.
**/
class WinkScale {
  constructor(limits) {
    this.limits = limits;
    this.reset();
  }

  reset() {
    this.frames = [];  // { t, left, right }, back as far as peakSec
    this.rest = null;  // where each eye sits when open, in the model's units
    this.peak = null;  // the shuttest each has lately been seen
  }

  // One frame of raw scores in, normalised scores out -- or null while the
  // scale is still being learnt, which is also what it answers when it has
  // just been reset.
  feed(t, left, right) {
    let L = this.limits;
    // A clock that went backwards means a different session, not a frame out
    // of order: start again rather than mix the two.
    if (this.frames.length && t < this.frames.at(-1).t) this.frames = [];
    this.frames.push({ t, left, right });
    while (this.frames.length && t - this.frames[0].t > L.peakSec * 1000)
      this.frames.shift();

    let recent = this.frames.filter(frame => t - frame.t <= L.restSec * 1000);
    // Under a second of face at fifteen frames a second: too little to say
    // where anything rests.
    if (recent.length < 10) return (this.rest = this.peak = null);

    // A low percentile rather than the minimum: eyes are open most of the
    // time, so the bottom of the recent spread is where open is, and a single
    // wide-eyed frame must not be allowed to move it.
    let at = (values, part) => {
      let sorted = values.sort((a, b) => a - b);
      return sorted[clamp(Math.round(part * (sorted.length - 1)), 0, sorted.length - 1)];
    };
    let rest = {
      left: at(recent.map(frame => frame.left), L.restQuantile),
      right: at(recent.map(frame => frame.right), L.restQuantile),
    };
    let peak = { left: -Infinity, right: -Infinity };
    for (let frame of this.frames) {
      if (frame.left > peak.left) peak.left = frame.left;
      if (frame.right > peak.right) peak.right = frame.right;
    }

    // No blink seen yet on one eye or the other, so there is no range to
    // measure a wink against.
    if (peak.left - rest.left < L.minSpan || peak.right - rest.right < L.minSpan)
      return (this.rest = this.peak = null);

    this.rest = rest;
    this.peak = peak;
    return {
      left: clamp((left - rest.left) / (peak.left - rest.left), 0, 1),
      right: clamp((right - rest.right) / (peak.right - rest.right), 0, 1),
    };
  }
}

/**
class WinkJudge

  The gesture, as a state machine over video frames.

  Fed one sample per frame through feed(), it answers with a verdict: what it
  can see, whether a wink would be read if one were made, how far a wink in
  progress has charged, and whether the page should turn now. The caller turns
  the page -- the judge never touches the document, so a test can drive it and
  a recording can replay it.

  A sample is a plain object, all of it optional except the clock:

    t      performance.now() when the frame was taken
    face   whether a face was found in the frame at all
    left   how shut the player's left eye is, 0..1
    right  how shut the player's right eye is, 0..1
    yaw    head rotation in degrees: + is the player's left
    pitch  head rotation in degrees: + is chin up
    roll   head rotation in degrees: + is the player's right ear down
    eyes   { left: {x, y}, right: {x, y} } eye centres in frame fractions
    fps    frames a second the model is managing

  The verdict:

    track      the face is being followed well enough to read a wink from
    ready      track, scale learnt, both eyes resting: wink now and it counts
    why        when not ready, which of the above failed, as a stable key
    state      "idle" | "arming" | "charging" | "cooldown"
    direction  "next" | "prev" | null -- the direction being charged
    progress   0..1 across the gauge, 0 unless charging
    turn       "next" | "prev" | null -- turn the page, this frame only
    norm       { left, right } the eyes against this player's own range, 0..1
    rest       { left, right } where that range starts, in the model's units
    peak       { left, right } and where it ends -- both null while learning
    gap        norm.left - norm.right, the number a wink is actually read from

  State, and why there are only four:

    idle       nothing is being asked for
    arming     a wink has begun, but not yet long enough to show anything
    charging   the gauge is up and filling
    cooldown   a page has just turned and winks are not being read

  There is no "fired" state because firing is an event, not a condition: the
  frame that reaches fireMs reports a turn and goes straight to cooldown.
**/
class WinkJudge {
  constructor(limits = {}, sides = {}) {
    this.limits = { ...WINK_LIMITS, ...limits };
    this.sides = { ...WINK_SIDES, ...sides };
    this.scale = new WinkScale(this.limits);
    this.reset();
  }

  // Forget the gesture in progress, but not the limits. Called when the camera
  // stops, when the panel changes a limit out from under a charge, and by the
  // constructor.
  reset() {
    this.state = "idle";
    this.direction = null;
    this.progress = 0;
    this.track = false;
    this.ready = false;
    this.why = "no-face";
    this.trackWhy = "no-face";
    this.restWhy = "settling";
    this.norm = { left: 0, right: 0 };
    this.gap = 0;
    this.heldFrom = 0;    // when the wink now in progress began
    this.restFrom = null; // when both eyes were first seen resting open
    this.lastT = null;    // the previous frame's clock, to notice a stall
    this.firedAt = -Infinity;
    // Whether a settled rest has been seen that no gesture has spent yet. A
    // wink only counts when it starts from one, and taking a gesture up spends
    // it, which is what stops the eye that just turned a page from turning the
    // next one without being opened first.
    //
    // A blink does not spend it. It used to, on the theory that a wink
    // beginning in a blink's recovery was probably the blink -- but the
    // recordings showed that "blink, then keep one eye shut" is simply how
    // this player winks, three times out of six, and the difference between
    // the eyes tells the two apart anyway.
    this.rested = false;
  }

  // Take up new limits or a new mapping of eyes to directions, and drop any
  // gesture in progress: a charge measured against the old numbers means
  // nothing against the new ones, and the reader moving a slider is not asking
  // for a page to be turned. The learnt scale survives -- it is a measurement
  // of the player, not a setting, and throwing it away would blind the judge
  // for several seconds every time a slider moved.
  tune(limits = {}, sides = {}) {
    this.limits = { ...WINK_LIMITS, ...limits };
    this.sides = { ...WINK_SIDES, ...sides };
    this.scale.limits = this.limits;
    this.reset();
  }

  // Forget the player as well as the gesture: a new camera, or a new face in
  // front of it, is a new scale.
  forget() {
    this.scale.reset();
    this.reset();
  }

  // Is the face being followed well enough to read a wink from it? This asks
  // nothing about the eyes being open, because one of them is shut for the
  // whole of a wink: it is the condition that has to hold *during* the gesture,
  // where ready is the condition that has to hold *before* it.
  //
  // Sets this.trackWhy to the first thing that failed, so the panel can say
  // which.
  judgeTrack(sample) {
    let L = this.limits;
    if (!sample.face) return (this.trackWhy = "no-face"), false;
    if ((sample.fps ?? Infinity) < L.fpsMin) return (this.trackWhy = "slow"), false;
    // An eye off the edge of the frame is not being seen, whatever the mesh
    // says about it: the model fits a whole face even where half of it is
    // missing, so the landmark still arrives, just made up.
    let m = L.margin, out = (eye) =>
      eye && (eye.x < -m || eye.x > 1 + m || eye.y < -m || eye.y > 1 + m);
    if (out(sample.eyes?.left)) return (this.trackWhy = "eye-left-out"), false;
    if (out(sample.eyes?.right)) return (this.trackWhy = "eye-right-out"), false;
    // A face too small to resolve the lids gives eye scores that drift about
    // the middle of the range and never answer. Refusing it is the only
    // honest reading: there is nothing to tell a wink from a blink with.
    // Samples from before this was measured carry no separation at all, and
    // are taken at their word.
    if (sample.sep != null && sample.sep < L.sepMin)
      return (this.trackWhy = "far"), false;
    if (Math.abs(sample.yaw ?? 0) > L.yawMax) return (this.trackWhy = "turned"), false;
    if (Math.abs(sample.pitch ?? 0) > L.pitchMax) return (this.trackWhy = "tilted"), false;
    if (Math.abs(sample.roll ?? 0) > L.rollMax) return (this.trackWhy = "rolled"), false;
    return true;
  }

  // Both eyes resting near their own open level, and for long enough to have
  // settled. Maintains restFrom, which is the clock behind restMs.
  judgeRest(t) {
    let { restOpen, restMs } = this.limits;
    if (this.norm.left >= restOpen || this.norm.right >= restOpen) {
      this.restFrom = null;
      // Say which it is, because "both eyes shut" and "one eye shut" mean very
      // different things to a player trying to aim a camera.
      this.restWhy = this.norm.left >= restOpen && this.norm.right >= restOpen
        ? "eyes-shut" : "eye-shut";
      return false;
    }
    if (this.restFrom == null) this.restFrom = t;
    if (t - this.restFrom < restMs) return (this.restWhy = "settling"), false;
    return true;
  }

  // Which eye is closing, as the player's own left or right, and how far it has
  // got -- read from the difference between the two eyes rather than from
  // either one's level, because the difference is what a blink cancels out of.
  // Null when neither is far enough ahead of the other to mean anything.
  lean() {
    let { start, shut } = this.limits;
    let gap = this.gap, side = gap > 0 ? "left" : "right";
    let closing = gap > 0 ? this.norm.left : this.norm.right;
    // Beginning asks for the full difference and for the closing eye to have
    // actually moved; holding asks only that the difference has not collapsed
    // and still leans the same way. A wink is ragged in the middle, and a
    // gesture that fell out on one bad frame would be unusable.
    let bar = this.direction ? start * this.limits.hold : start;
    if (Math.abs(gap) < bar) return null;
    if (!this.direction && closing < shut) return null;
    return side;
  }

  feed(sample) {
    let L = this.limits, t = sample.t;

    // Nothing is known about the eyes across a stall, so a gesture cannot be
    // held through one: the clock ran on, but the evidence did not. The
    // cooldown is deliberately left alone -- a page that has just turned has
    // just turned, however long the stall was.
    let stalled = this.lastT != null && t - this.lastT > L.gapMs;
    this.lastT = t;
    if (stalled) {
      this.direction = null;
      this.heldFrom = t;
      this.restFrom = null;
      this.rested = false;
      this.progress = 0;
      this.state = "idle";
    }

    this.track = this.judgeTrack(sample);
    // The scale is fed every frame a face is in, including through a wink: a
    // wink's own peak is a perfectly good reading of how shut that eye gets.
    let norm = this.track
      ? this.scale.feed(t, sample.left ?? 0, sample.right ?? 0)
      : null;
    this.norm = norm ?? { left: 0, right: 0 };
    this.gap = this.norm.left - this.norm.right;
    // Still learning this player's range: there is nothing to read a wink
    // against, and guessing is worse than waiting.
    let learning = this.track && !norm;

    let rest = this.track && !learning && this.judgeRest(t);
    // A face that is not being followed says nothing about the eyes behind it,
    // so the rest clock starts again from the frame the face comes back on:
    // the eye could have been shut the whole time it was away.
    if (!this.track || learning) {
      this.restFrom = null;
      this.rested = false;
    }
    if (rest) this.rested = true;
    this.ready = this.track && rest;
    // The most fundamental complaint wins: being told the eyes are shut is no
    // use to a player whose face is not in the frame at all.
    this.why = !this.track ? this.trackWhy
      : learning ? "learning"
      : rest ? "ready" : this.restWhy;

    let side = this.track && !learning ? this.lean() : null;
    let direction = side ? this.sides[side] ?? null : null;

    // Cooldown runs on its own clock and ignores everything else, so that a
    // page in flight is never asked to turn again.
    if (t - this.firedAt < L.cooldownMs) {
      this.state = "cooldown";
      this.direction = null;
      this.progress = 0;
      // Not ready, whatever the eyes are doing: a wink made now is thrown
      // away, and a ring that went green to say otherwise would be inviting
      // the player to make one.
      this.ready = false;
      this.why = "cooling";
      return this.verdict(null);
    }

    // A gesture may only begin from a settled rest. Mid-gesture one eye is
    // shut and there is no rest to be had, so this asks for one only on the
    // frame a gesture starts -- which is also what stops the eye that just
    // turned a page from turning the next one without being opened first.
    let starting = direction != this.direction;
    if (!direction || (starting && !this.rested)) {
      this.state = "idle";
      this.direction = null;
      this.progress = 0;
      return this.verdict(null);
    }

    // A different eye means a different gesture: start it over rather than
    // carry the charge across, or glancing from one to the other would fill the
    // gauge between them. Taking the gesture up spends the rest it started
    // from, so the next one has to wait for a rest of its own.
    if (starting) {
      this.direction = direction;
      this.heldFrom = t;
      this.rested = false;
    }

    // Whatever the panel's sliders are set to, the gauge needs somewhere to
    // fill across, and fireMs no later than showMs would divide by zero.
    let showMs = Math.min(L.showMs, L.fireMs);
    let span = Math.max(1, L.fireMs - showMs);
    let heldMs = t - this.heldFrom;

    if (heldMs < showMs) {
      this.state = "arming";
      this.progress = 0;
      return this.verdict(null);
    }

    this.state = "charging";
    this.progress = clamp((heldMs - showMs) / span, 0, 1);

    if (heldMs < L.fireMs) return this.verdict(null);

    // Full. Turn the page. The spent rest is what asks for the eye to be
    // opened before another page is given up.
    this.firedAt = t;
    this.state = "cooldown";
    this.progress = 1;
    // The cooldown starts on this frame, not the next one, so it says so from
    // here: every frame in that state gives the same reason.
    this.why = "cooling";
    let turn = this.direction;
    this.direction = null;
    return this.verdict(turn);
  }

  verdict(turn) {
    return {
      track: this.track,
      ready: this.ready,
      why: this.why,
      state: this.state,
      direction: this.direction,
      progress: this.progress,
      turn,
      norm: this.norm,
      gap: this.gap,
      rest: this.scale.rest,
      peak: this.scale.peak,
    };
  }
}

// Head rotation in degrees from one of MediaPipe's facial transformation
// matrixes, which arrive as 16 numbers in column-major order. Only the
// rotation part is wanted, and only to bound how far the head may be turned,
// so this is the plain ZYX Euler decomposition and not anything cleverer.
//
// Signs are from the player's point of view: yaw + is turning to their own
// left, pitch + is chin up, roll + is their right ear down.
function winkPose(matrix) {
  let m = matrix?.data ?? matrix;
  if (!m || m.length < 16) return { yaw: 0, pitch: 0, roll: 0 };
  // Column-major, so m[col * 4 + row].
  let r00 = m[0], r10 = m[1], r20 = m[2];
  let r21 = m[6], r22 = m[10];
  let deg = 180 / Math.PI;
  let hypot = Math.hypot(r00, r10);
  // Looking straight up or down the camera axis leaves yaw and roll
  // indistinguishable; pin roll to zero rather than let it jump about.
  if (hypot < 1e-6) return {
    yaw: -Math.atan2(r20, hypot) * deg,
    pitch: Math.atan2(-r21, r22) * deg,
    roll: 0,
  };
  return {
    yaw: -Math.atan2(r20, hypot) * deg,
    pitch: Math.atan2(r21, r22) * deg,
    roll: Math.atan2(r10, r00) * deg,
  };
}

/**
class WinkWatch

  The camera and the landmark model, turned into a stream of samples for a
  WinkJudge.

  The model and its WebAssembly runtime are 17 MB, which is more than the rest
  of Podium put together, so none of it is loaded until the reader asks for it:
  start() fetches it and the service worker keeps it afterwards. That is also
  why loading reports its progress -- the first start() on a slow connection is
  a long wait, and a feature that looks like it has hung is a feature nobody
  turns on twice.

  Everything it sees stays on the device. There is no MediaPipe service behind
  this: the model runs here, and the frames are not kept at all unless the
  reader asks for a recording, which keeps numbers about a face and never a
  picture of one.
**/

// Where the model and runtime live, relative to whichever page this is: the
// packaged page, the static-host deployment, and src/ served directly all
// resolve this to the same files. Built against document.baseURI rather than
// against this module's own URL, because in the packaged build there is no
// module -- this file has been concatenated into the page.
const winkAsset = (name) => new URL("mediapipe/" + name, document.baseURI).href;

// The landmarks each eye's centre is averaged from: the outer and inner
// corners and the middle of each lid. MediaPipe's left and right are the
// player's own, so they pair with eyeBlinkLeft and eyeBlinkRight -- which the
// Wink panel's preview exists to confirm, because having them the wrong way
// round would read as the model being wrong rather than this being wrong.
const WINK_EYES = {
  left: [362, 263, 386, 374],
  right: [33, 133, 159, 145],
};

class WinkWatch {
  // How often the model is asked for a face. Detection is synchronous and the
  // score is being drawn over, so this is deliberately well short of the
  // camera's own rate: a tenth of a second of held eye still spans a frame or
  // two, and the gauge is drawn from a clock rather than from frames.
  static fps = 15;

  constructor({ limits, sides, onFrame, onStatus } = {}) {
    this.judge = new WinkJudge(limits, sides);
    this.onFrame = onFrame ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.log = null;         // a WinkLog, while the panel is recording
    this.video = null;
    this.stream = null;
    this.marker = null;
    this.shapeNames = null;  // the model's blendshape labels, in its order
    this.shapes = null;      // their scores this frame
    this.blink = { left: -1, right: -1 }; // where the two eye scores sit
    this.rate = 0;           // frames a second the model is managing
    this.status = "off";
    this.detail = "";
    // start() is a long sequence of awaits and the panel can be closed part
    // way through any of them, so every step checks it is still the current
    // one before going on.
    this.run = 0;
    this.frame = 0;
    this.lastAt = 0;
    this.lastStamp = 0;
    this.lastFrameTime = -1;
  }

  get running() { return !!this.marker && !!this.stream; }

  say(status, detail = "") {
    this.status = status;
    this.detail = detail;
    this.onStatus(status, detail);
  }

  // The model, with the two outputs a wink is read from: the eye scores, and
  // the head rotation that says whether they can be believed.
  markerOptions(delegate) {
    return {
      baseOptions: { modelAssetPath: winkAsset("face_landmarker.task"), delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    };
  }

  async start({ deviceId } = {}) {
    this.stop();
    let run = ++this.run;
    let mine = () => run == this.run;
    try {
      // Only the SIMD runtime is vendored: the fallback is another 13 MB for
      // browsers from before 2021, and the loader would ask for it by name and
      // get a 404, which reads as a broken install rather than an old browser.
      this.say("loading", "Checking this browser");
      let { FaceLandmarker, FilesetResolver } =
        await import(/* webpackIgnore: true */ winkAsset("vision_bundle.mjs"));
      if (!mine()) return false;
      let simd = await FilesetResolver.isSimdSupported();
      if (!mine()) return false;
      if (!simd) {
        this.say("unsupported",
          "This browser cannot run the face model: it has no WebAssembly SIMD.");
        return false;
      }

      this.say("loading", "Fetching the face model");
      let fileset = await FilesetResolver.forVisionTasks(winkAsset("wasm"));
      if (!mine()) return false;
      let marker = await FaceLandmarker
        .createFromOptions(fileset, this.markerOptions("GPU"))
        .catch((error) => {
          // No usable WebGL -- another tab holding the context, a headless
          // browser, a locked-down device. The model runs on the CPU too, more
          // slowly, and the judge refuses the gesture by itself if what comes
          // out is too slow to time a tenth of a second against.
          console.warn("Wink: the GPU delegate failed, falling back to the CPU:", error);
          return FaceLandmarker.createFromOptions(fileset, this.markerOptions("CPU"));
        });
      if (!mine()) { marker.close(); return false; }

      this.say("loading", "Opening the camera");
      let stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
          // A tablet on a music stand is half a metre or more from the
          // player's face, and a front camera is wide: the face lands small
          // in the frame whatever is asked for. The model crops the face and
          // resizes that crop to its own input, so the only way to give it
          // more to work with at that distance is to capture more pixels.
          // 640x480 measurably was not enough -- see sepMin.
          width: { ideal: 1280 }, height: { ideal: 720 },
        },
      });
      // Everything this attempt made, let go of. Not stop(): by the time a
      // cancelled attempt gets here the fields may belong to a newer one, and
      // stop() would put out its camera and cancel it in turn.
      let abandon = () => {
        marker.close();
        stream.getTracks().forEach(track => track.stop());
      };
      if (!mine()) { abandon(); return false; }

      let video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      if (!mine()) { video.srcObject = null; abandon(); return false; }

      // Nothing is published until every await has landed, so a cancelled
      // attempt never has anything of the turner's to tidy up.
      this.marker = marker;
      this.stream = stream;
      this.video = video;
      // A new camera, or whoever is in front of it now, is a new scale: the
      // learnt range belongs to the last session, not this one.
      this.judge.forget();
      // Not the target rate: the first detection compiles shaders and can take
      // a second or more, and claiming a rate before one has been measured
      // would let the judge time a gesture against a model that is not yet
      // keeping up. Zero reads as "too slow", which is true until it is not.
      this.rate = 0;
      this.lastAt = 0;
      this.lastStamp = 0;
      this.lastFrameTime = -1;
      this.say("on");
      this.schedule(run);
      return true;
    } catch (error) {
      if (!mine()) return false;
      this.stop();
      console.error("Wink: could not start:", error);
      this.say("failed", this.explain(error));
      return false;
    }
  }

  // What went wrong, in terms of something the reader can go and change.
  explain(error) {
    let name = error?.name;
    if (name == "NotAllowedError")
      return "Permission to use the camera was denied or dismissed.";
    if (name == "NotReadableError")
      return "The camera is unavailable -- it is in use by another app, or the "
        + "system video stack was reset. <strong>Reloading Podium usually fixes "
        + "this.</strong>";
    if (name == "NotFoundError") return "No camera was found on this device.";
    if (name == "OverconstrainedError") return "No camera matches what was asked for.";
    // A missing model arrives as a failed dynamic import, or as a 404 that
    // became a WebAssembly compile error, neither of which says anything a
    // reader could act on.
    if (/fetch|import|Failed to load|magic word|WebAssembly|404/i.test(String(error?.message)))
      return "The face model could not be loaded. In your own build, run "
        + "<code>fetch-wink-assets.sh</code> and build again.";
    return `${name ?? "Error"}: ${error?.message ?? error}`;
  }

  stop() {
    this.run++;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.removeAttribute("src");
      this.video.load();
      this.video = null;
    }
    // The camera light going out is the only assurance a player has that this
    // is off, so the tracks are stopped before anything else can fail.
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.marker?.close();
    this.marker = null;
    this.judge.forget();
    if (this.status != "off") this.say("off");
  }

  schedule(run) {
    // requestVideoFrameCallback fires once per camera frame, which is a better
    // clock than the compositor's; without it the animation frame is close
    // enough at these rates.
    if (this.video?.requestVideoFrameCallback)
      this.video.requestVideoFrameCallback(() => this.tick(run));
    else this.frame = requestAnimationFrame(() => this.tick(run));
  }

  tick(run) {
    if (run != this.run || !this.running) return;
    this.schedule(run);

    let video = this.video;
    if (video.readyState < 2) return;
    // Pace the model well under the camera's rate, and never hand it the same
    // frame twice: a repeated frame is a repeated score, which would let a
    // stalled camera fill the gauge on an eye that has since been opened.
    let now = performance.now();
    if (now - this.lastAt < 1000 / WinkWatch.fps - 1) return;
    if (video.currentTime == this.lastFrameTime) return;
    this.lastFrameTime = video.currentTime;
    if (this.lastAt) {
      // Smoothed, because one late frame is not a slow model, and the judge
      // refuses the gesture outright below its floor.
      let rate = 1000 / Math.max(1, now - this.lastAt);
      this.rate = this.rate ? this.rate * 0.8 + rate * 0.2 : rate;
    }
    this.lastAt = now;

    let result;
    try {
      // The model insists its timestamps increase, and two frames inside one
      // millisecond are possible on a fast machine.
      let stamp = Math.max(now, this.lastStamp + 1);
      this.lastStamp = stamp;
      result = this.marker.detectForVideo(video, stamp);
    } catch (error) {
      // A detection that throws is usually a lost WebGL context, and it will
      // throw on every frame from here on: stop rather than spin.
      console.error("Wink: detection failed:", error);
      this.stop();
      this.say("failed", "The face model stopped responding. Turn Wink on again to restart it.");
      return;
    }

    let sample = this.read(result, now);
    let verdict = this.judge.feed(sample);
    this.log?.add(sample, verdict, this.shapes, this.shapeNames);
    this.onFrame(sample, verdict);
  }

  // One frame of the model's output as a judge sample, with the full set of
  // blendshape scores left in this.shapes for the recording.
  read(result, t) {
    let marks = result.faceLandmarks?.[0];
    let categories = result.faceBlendshapes?.[0]?.categories;
    if (!marks || !categories) {
      this.shapes?.fill(0);
      return { t, face: false, left: 0, right: 0, fps: this.rate };
    }

    if (!this.shapeNames || this.shapeNames.length != categories.length) {
      this.shapeNames = categories.map(category => category.categoryName);
      this.shapes = new Float32Array(categories.length);
      this.blink = {
        left: this.shapeNames.indexOf("eyeBlinkLeft"),
        right: this.shapeNames.indexOf("eyeBlinkRight"),
      };
    }
    for (let i = 0; i < categories.length; i++) this.shapes[i] = categories[i].score;

    let centre = (which) => {
      let marked = WINK_EYES[which].map(i => marks[i]).filter(Boolean);
      if (!marked.length) return undefined;
      return {
        x: marked.reduce((sum, mark) => sum + mark.x, 0) / marked.length,
        y: marked.reduce((sum, mark) => sum + mark.y, 0) / marked.length,
      };
    };

    // How many pixels apart the eye centres are: the measure of how much of
    // the face the model actually had to look at. Landmarks are fractions of
    // the frame, so this needs the captured size to mean anything.
    let eyes = { left: centre("left"), right: centre("right") };
    let sep = eyes.left && eyes.right
      ? Math.hypot((eyes.left.x - eyes.right.x) * (this.video.videoWidth || 0),
                   (eyes.left.y - eyes.right.y) * (this.video.videoHeight || 0))
      : undefined;

    return {
      t,
      face: true,
      left: this.blink.left < 0 ? 0 : this.shapes[this.blink.left],
      right: this.blink.right < 0 ? 0 : this.shapes[this.blink.right],
      eyes,
      sep,
      ...winkPose(result.facialTransformationMatrixes?.[0]),
      fps: this.rate,
    };
  }
}

/**
class WinkLog

  A recording of what the model saw, for working out what the limits should be.

  Everything in WINK_LIMITS is a guess until somebody has sat behind a flute
  with a tablet on a stand and measured it, and the awkward part is that the
  interesting moments are the ones nobody can reproduce on demand: the page
  that turned itself in bar 40, the wink that went unread three times running.
  So this keeps the last stretch of everything -- all 52 blendshape scores, the
  head rotation, where the eyes were, and what the judge made of it -- in a
  ring buffer, and the reader saves it after the fact.

  The frames themselves are never kept. A row of numbers about a face is not a
  picture of one, and there is no reason for this to be able to produce one.
**/
class WinkLog {
  // Twenty minutes at 15 frames a second, which is a movement rather than a
  // moment, and about 25 MB of CSV once written out.
  constructor(rows = 18000) {
    this.limit = rows;
    this.rows = [];
    this.names = null;
    this.mark = "";   // stamped onto the next row, then cleared
    this.marked = 0;  // how many rows the reader has stamped
    this.dropped = 0; // rows the ring buffer has thrown away
  }

  // Say that the wink just made was deliberate, so the recording can be read
  // without guessing which of these was meant to count. This is what turns a
  // recording into training data later on.
  label(what) {
    this.mark = what;
    this.marked++;
  }

  add(sample, verdict, shapes, names) {
    if (names && !this.names) this.names = [...names];
    this.rows.push({
      t: Math.round(sample.t),
      mark: this.mark,
      face: sample.face ? 1 : 0,
      left: sample.left, right: sample.right,
      yaw: sample.yaw ?? 0, pitch: sample.pitch ?? 0, roll: sample.roll ?? 0,
      eyeLeftX: sample.eyes?.left?.x ?? "", eyeLeftY: sample.eyes?.left?.y ?? "",
      eyeRightX: sample.eyes?.right?.x ?? "", eyeRightY: sample.eyes?.right?.y ?? "",
      sep: sample.sep ?? "",
      fps: sample.fps ?? 0,
      normLeft: verdict.norm?.left ?? "", normRight: verdict.norm?.right ?? "",
      gap: verdict.gap ?? "",
      restLeft: verdict.rest?.left ?? "", restRight: verdict.rest?.right ?? "",
      peakLeft: verdict.peak?.left ?? "", peakRight: verdict.peak?.right ?? "",
      track: verdict.track ? 1 : 0,
      ready: verdict.ready ? 1 : 0,
      why: verdict.why,
      state: verdict.state,
      direction: verdict.direction ?? "",
      progress: verdict.progress,
      turn: verdict.turn ?? "",
      shapes: shapes ? Float32Array.from(shapes) : null,
    });
    this.mark = "";
    if (this.rows.length > this.limit) {
      this.rows.shift();
      this.dropped++;
    }
  }

  get seconds() {
    if (this.rows.length < 2) return 0;
    return (this.rows.at(-1).t - this.rows[0].t) / 1000;
  }

  // The whole recording as CSV: one row per frame, with the judge's reading of
  // it beside the numbers it was read from, so a spreadsheet can plot either.
  toCsv() {
    let plain = ["t", "mark", "face", "left", "right", "yaw", "pitch", "roll",
      "eyeLeftX", "eyeLeftY", "eyeRightX", "eyeRightY", "sep", "fps",
      "normLeft", "normRight", "gap", "restLeft", "restRight", "peakLeft", "peakRight",
      "track", "ready", "why", "state", "direction", "progress", "turn"];
    let round = (value) => typeof value == "number" ? +value.toFixed(5) : value;
    let out = [[...plain, ...(this.names ?? [])].join(",")];
    for (let row of this.rows) {
      let cells = plain.map(key => round(row[key]));
      if (this.names) for (let i = 0; i < this.names.length; i++)
        cells.push(row.shapes ? +row.shapes[i].toFixed(5) : "");
      out.push(cells.join(","));
    }
    return out.join("\n") + "\n";
  }
}

/**
class WinkHud

  The small ring in the corner of the screen that says what the camera makes of
  the player.

  Two jobs in one mark, because a player reading music has no attention to
  spare for two:

  The ring's colour answers "is it watching me?" -- grey for no face found,
  amber for a face it cannot read a wink from (and the panel says which of the
  reasons it is), green for ready. Without this the only way to find out
  whether the camera is aimed well enough is to wink and see, which during a
  rest is an experiment nobody has time for. A steady green fades back after a
  few seconds so it stops asking to be looked at, and comes back the instant
  anything changes.

  The inside fills as a wink is held, from the moment one is noticed to the
  moment the page would turn. That is what makes the gesture something aimed
  rather than something risked: the player can watch it coming and open the eye
  to call it off.
**/
class WinkHud {
  // How long a green ring stays bright before it fades back.
  static settleMs = 2500;

  static css = css("WinkHud", `
    .WinkHud {
      position: fixed;
      width: 1.6em;
      height: 1.6em;
      border-radius: 50%;
      /* Over the pages, under every panel: panels count up from _zTop_, and
         this must never join that argument. */
      z-index: 299;
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      color: #fff;
      background: rgba(0, 0, 0, .38);
      box-shadow: 0 0 0 2px var(--winkRing), 0 1px 6px rgba(0, 0, 0, .35);
      transition: opacity ${_gs_ / 2}ms, box-shadow ${_gs_ / 3}ms, transform ${_gsgs_}ms;
      --winkRing: #8c8c8c;
      --winkDeg: 0deg;
    }
    .WinkHud-shown { display: flex; }
    .WinkHud-lost { --winkRing: #8c8c8c; }
    .WinkHud-held { --winkRing: #d79a2b; }
    .WinkHud-ready { --winkRing: #46bb63; }
    /* A ring that has had nothing to say for a while stops saying it loudly. */
    .WinkHud-faded { opacity: .28; }
    .WinkHud-turned { transform: scale(1.3); }
    .WinkHud__gauge {
      position: absolute;
      inset: 2px;
      border-radius: 50%;
      opacity: 0;
      background: conic-gradient(#49a9f0 0 var(--winkDeg), transparent var(--winkDeg));
    }
    .WinkHud-charging .WinkHud__gauge, .WinkHud-turned .WinkHud__gauge { opacity: 1; }
    .WinkHud__mark {
      position: relative;
      width: .62em;
      height: .62em;
      opacity: 0;
      transition: opacity ${_gsgs_}ms;
    }
    .WinkHud-charging .WinkHud__mark, .WinkHud-turned .WinkHud__mark { opacity: 1; }
    /* One chevron, turned round for the other direction. */
    .WinkHud-prev .WinkHud__mark { transform: scaleX(-1); }
    .WinkHud-at-bottomRight { right: .8em; bottom: .8em; }
    .WinkHud-at-bottomLeft { left: .8em; bottom: .8em; }
    .WinkHud-at-bottom { left: 50%; bottom: .8em; margin-left: -.8em; }
    .WinkHud-at-topRight { right: .8em; top: .8em; }
  `);

  // Where the ring may sit, as the reader chooses it. Low and to one side by
  // default: a score is read from the top down, so the bottom corners are the
  // part of the screen a player's eyes are least often on.
  static places = {
    "Low Right": "bottomRight",
    "Low Left": "bottomLeft",
    "Low Centre": "bottom",
    "High Right": "topRight",
  };

  elm = helm(`
    <div class="WinkHud WinkHud-at-bottomRight">
      <div data-tag="gauge" class="WinkHud__gauge"></div>
      <svg data-tag="mark" class="WinkHud__mark" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 3l10 9-10 9" fill="none" stroke="currentColor"
              stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>`);

  constructor() {
    Object.assign(this, dataIndex("tag", this.elm));
    // The menu's font size is the app's scale. Through window, and optional,
    // for the same reason as WinkTurner's stash.
    let scale = window._menu_?.elm?.style?.fontSize;
    if (scale) this.elm.style.fontSize = scale;
    _body_.append(this.elm);
    this.said = "";
    this.saidAt = 0;
    this.flash = new Schedule();
  }

  place(where) {
    // An unrecognised setting -- a stash from a Podium that offered different
    // corners -- still has to land somewhere.
    let at = WinkHud.places[where] ?? "bottomRight";
    for (let name of Object.values(WinkHud.places))
      this.elm.classList.toggle(`WinkHud-at-${name}`, name == at);
  }

  draw(verdict) {
    let classes = this.elm.classList;
    classes.add("WinkHud-shown");
    classes.toggle("WinkHud-lost", !verdict.track);
    classes.toggle("WinkHud-held", verdict.track && !verdict.ready);
    classes.toggle("WinkHud-ready", verdict.ready);
    classes.toggle("WinkHud-charging", verdict.state == "charging");
    if (verdict.direction) classes.toggle("WinkHud-prev", verdict.direction == "prev");
    this.elm.style.setProperty("--winkDeg", `${Math.round(verdict.progress * 360)}deg`);

    // Fade a ring that has been saying the same thing for a while, and bring
    // it straight back when it changes: what the player needs to notice is the
    // change, not the state.
    let said = `${verdict.track}${verdict.ready}${verdict.state}${verdict.why}`;
    let now = performance.now();
    if (said != this.said) {
      this.said = said;
      this.saidAt = now;
    }
    classes.toggle("WinkHud-faded",
      verdict.ready && verdict.state == "idle" && now - this.saidAt > WinkHud.settleMs);
  }

  // A page has turned. The gauge is full, so hold it there for a moment rather
  // than letting it vanish on the same frame the page moves: the point is to
  // connect the two.
  turned() {
    this.elm.classList.add("WinkHud-turned");
    this.elm.classList.remove("WinkHud-faded");
    this.elm.style.setProperty("--winkDeg", "360deg");
    this.flash.run(_gsgs_ * 2, () => this.elm.classList.remove("WinkHud-turned"));
  }

  hide() {
    this.flash.cancel();
    this.elm.classList.remove("WinkHud-shown", "WinkHud-turned", "WinkHud-charging");
    this.said = "";
  }

  destructor() {
    this.flash.cancel();
    this.elm.remove();
  }
}

/**
class WinkTurner

  The one wink page-turner, and the only thing in here that touches the score.

  There is one camera and one score, so there is one of these, reached as
  WinkTurner.it. It outlives the Wink panel on purpose: the panel is where the
  camera gets aimed and the limits get set, and the whole point is to close it
  and go and play with the ring still watching. Closing the panel must not put
  the camera out, and opening it again must not start a second one.

  It owns the camera (WinkWatch), the ring in the corner (WinkHud) and the
  recording (WinkLog), keeps its settings in the Wink menu cell's stash so they
  are saved with everything else, and turns the page through the same _turnPage_
  that a pedal and an arrow key go through -- so a wink obeys the score's own
  Numbers settings about moving by bookmark, exactly as a pedal does.
**/
let theTurner = null;

class WinkTurner {
  static get it() { return theTurner ??= new WinkTurner(); }

  constructor() {
    this.watch = new WinkWatch({
      onFrame: (sample, verdict) => this.frame(sample, verdict),
      onStatus: (status, detail) => this.tell("status", status, detail),
    });
    this.hud = null;
    this.log = null;
    this.recording = false;
    // Winks this watch has acted on, for the panel to show. Not pages moved:
    // the layout takes the ask from here and may decline it, there being no
    // page past the last one.
    this.asks = 0;
    this.watchers = new Set();
  }

  // Reached through window: _menu_ is assigned by main.js at startup, and a
  // bare name would throw a ReferenceError rather than read as absent if
  // anything asked for a wink before the menu was built.
  get stash() { return window._menu_?.rings?.more?.cells?.wink?.stash ?? {}; }
  get running() { return this.watch.running; }
  get status() { return this.watch.status; }
  get detail() { return this.watch.detail; }

  // The stash as the judge wants it. Anything the stash has no answer for is
  // left to WINK_LIMITS, so a settings file saved by an older Podium that
  // never had one of these keys still gets a working default.
  limits() {
    let limits = {};
    for (let key of ["start", "shut", "showMs", "fireMs", "cooldownMs",
                     "restMs", "yawMax", "pitchMax", "rollMax", "sepMin"])
      if (typeof this.stash[key] == "number") limits[key] = this.stash[key];
    return limits;
  }

  sides() {
    let on = this.stash.sides == "Left On" ? "left" : "right";
    let back = on == "left" ? "right" : "left";
    return { [on]: "next", [back]: this.stash.back == "Back On" ? "prev" : null };
  }

  // Take the settings up, including in the middle of watching: the panel's
  // sliders are meant to be moved while the camera is running and the scores
  // are there to be read against.
  tune() {
    this.watch.judge.tune(this.limits(), this.sides());
    this.hud?.place(this.stash.place);
  }

  async on() {
    this.hud ??= new WinkHud();
    this.tune();
    let started = await this.watch.start({ deviceId: this.stash.device || undefined });
    if (!started) this.hud.hide();
    return started;
  }

  off() {
    this.watch.stop();
    this.hud?.hide();
  }

  // Start keeping what the model sees, or stop keeping it. Stopping does not
  // throw the recording away -- the reader has still to save it, and the
  // interesting part is usually whatever just went wrong.
  record(on) {
    this.recording = on;
    if (on) this.log ??= new WinkLog();
    this.watch.log = on ? this.log : null;
    this.tell("record", on);
  }

  forget() {
    this.watch.log = null;
    this.log = null;
    this.recording = false;
    this.tell("record", false);
  }

  // Save the recording as CSV. Nothing the camera saw is in here but numbers:
  // the scores, the angles and what the judge made of them.
  save() {
    if (!this.log?.rows.length) return false;
    let stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let url = URL.createObjectURL(new Blob([this.log.toCsv()], { type: "text/csv" }));
    let link = document.createElement("a");
    link.download = `podium-wink-${stamp}.csv`;
    link.href = url;
    link.target = "_self";
    link.rel = "noopener";
    link.style.display = "none";
    _body_.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    return true;
  }

  frame(sample, verdict) {
    this.hud?.draw(verdict);
    if (verdict.turn) {
      this.hud?.turned();
      // "Hold" fills the gauge and leaves the page alone, so the gesture can
      // be tried against a real score without losing your place in it.
      // Reached through window, not as a bare name: this runs from a video
      // frame callback, and a ReferenceError there would be swallowed as a
      // console line in a build where main.js had not set it.
      if (this.stash.turn != "Hold" && window._turnPage_?.(verdict.turn)) this.asks++;
    }
    this.tell("frame", sample, verdict);
  }

  // The panel watches this while it is open, and stops watching when it
  // closes; the camera carries on either way.
  listen(watcher) {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  tell(what, ...args) {
    for (let watcher of [...this.watchers]) {
      try { watcher(what, ...args); }
      catch (error) { console.error("Wink: a watcher threw:", error); }
    }
  }
}

window._WinkJudge_ = WinkJudge;
window._WinkHud_ = WinkHud;
window._WinkTurner_ = WinkTurner;
window._WinkWatch_ = WinkWatch;
window._WinkLog_ = WinkLog;
window._winkPose_ = winkPose;
window._WINK_LIMITS_ = WINK_LIMITS;
