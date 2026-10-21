export { WinkJudge, WINK_LIMITS, winkPose };
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

import { clamp } from "./common.js";
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

// The numbers a wink is measured against. Every one of them is a guess until
// it has been measured on a player with an instrument at their lips, which is
// what the Wink panel's recording is for; treat these as a starting point to
// argue with, not a result.
const WINK_LIMITS = {
  // An eye counts as shut at `closed` and as open under `open`. The gap
  // between them is deliberate: a face that reads 0.5 on both eyes is doing
  // something that is neither, and the safe answer to that is nothing.
  closed: 0.7,
  open: 0.3,
  // A blink is 50-150ms, so nothing at all happens before `showMs` and the
  // page does not turn before `fireMs`. The gauge fills across that gap, so
  // widening it makes the gesture both safer and slower to perform.
  showMs: 100,
  fireMs: 400,
  // After a turn, how long before another wink is looked at. Covers the page
  // animation and stops a long-held eye from walking through the score.
  cooldownMs: 800,
  // How long both eyes must have been open before a wink is believed. A wink
  // that begins in the recovery of a blink is more likely to be the blink.
  restMs: 400,
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
  // Below this many frames a second the held times are too coarse to measure a
  // tenth of a second against, so the gesture is refused rather than guessed.
  fpsMin: 7,
};

// Which eye asks for which direction. Either side may be null, which switches
// that direction off: a player who can only wink one eye still gets the page
// forward, and forward is the one that matters.
const WINK_SIDES = { left: "prev", right: "next" };

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
    ready      track, and both eyes are resting open: wink now and it will count
    why        when not ready, which of the above failed, as a stable key
    state      "idle" | "arming" | "charging" | "cooldown"
    direction  "next" | "prev" | null -- the direction being charged
    progress   0..1 across the gauge, 0 unless charging
    turn       "next" | "prev" | null -- turn the page, this frame only

  State, and why there are only four:

    idle       nothing is being asked for
    arming     one eye is shut, but not yet long enough to show anything
    charging   the gauge is up and filling
    cooldown   a page has just turned and winks are not being read

  There is no "fired" state because firing is an event, not a condition: the
  frame that reaches fireMs reports a turn and goes straight to cooldown.
**/
class WinkJudge {
  constructor(limits = {}, sides = {}) {
    this.limits = { ...WINK_LIMITS, ...limits };
    this.sides = { ...WINK_SIDES, ...sides };
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
    this.heldFrom = 0;    // when the eye now shut was first seen shut
    this.restFrom = null; // when both eyes were first seen resting open
    this.firedAt = -Infinity;
    // Whether a settled rest has been seen that no gesture has spent yet. A
    // wink only counts when it starts from one, which is what keeps the second
    // half of a blink from being read as the start of a wink, and -- because
    // taking up a gesture spends it -- also what stops the eye that just
    // turned a page from turning the next one without being opened first.
    this.rested = false;
  }

  // Which eye the player is holding shut, as the player's own left or right,
  // or null for neither (both open) and for both (a blink).
  side(sample) {
    let { closed, open } = this.limits;
    let left = sample.left ?? 0, right = sample.right ?? 0;
    if (left >= closed && right < open) return "left";
    if (right >= closed && left < open) return "right";
    return null;
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
    if (Math.abs(sample.yaw ?? 0) > L.yawMax) return (this.trackWhy = "turned"), false;
    if (Math.abs(sample.pitch ?? 0) > L.pitchMax) return (this.trackWhy = "tilted"), false;
    if (Math.abs(sample.roll ?? 0) > L.rollMax) return (this.trackWhy = "rolled"), false;
    return true;
  }

  // Both eyes resting open, and for long enough to have settled. Maintains
  // restFrom, which is the clock behind restMs.
  judgeRest(sample) {
    let { open, restMs } = this.limits;
    let left = sample.left ?? 0, right = sample.right ?? 0;
    if (left >= open || right >= open) {
      this.restFrom = null;
      // Say which it is, because "both eyes shut" and "one eye shut" mean very
      // different things to a player trying to aim a camera.
      this.restWhy = left >= open && right >= open ? "eyes-shut" : "eye-shut";
      return false;
    }
    if (this.restFrom == null) this.restFrom = sample.t;
    if (sample.t - this.restFrom < restMs) return (this.restWhy = "settling"), false;
    return true;
  }

  feed(sample) {
    let L = this.limits, t = sample.t;

    this.track = this.judgeTrack(sample);
    let rest = this.track && this.judgeRest(sample);
    // A face that is not being followed says nothing about the eyes behind it,
    // so the rest clock starts again from the frame the face comes back on:
    // the eye could have been shut the whole time it was away.
    if (!this.track) {
      this.restFrom = null;
      this.rested = false;
    }
    if (rest) this.rested = true;
    this.ready = this.track && rest;
    // The most fundamental complaint wins: being told the eyes are shut is no
    // use to a player whose face is not in the frame at all.
    this.why = !this.track ? this.trackWhy : rest ? "ready" : this.restWhy;

    let side = this.track ? this.side(sample) : null;
    let direction = side ? this.sides[side] ?? null : null;

    // Cooldown runs on its own clock and ignores everything else, so that a
    // page in flight is never asked to turn again.
    if (t - this.firedAt < L.cooldownMs) {
      this.state = "cooldown";
      this.direction = null;
      this.progress = 0;
      return this.verdict(null);
    }

    // A gesture may only begin from a settled rest. Mid-gesture the eye is
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

window._WinkJudge_ = WinkJudge;
window._winkPose_ = winkPose;
window._WINK_LIMITS_ = WINK_LIMITS;
