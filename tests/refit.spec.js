const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

// Pinching and dragging a layout is remembered: the view survives a layout
// switch and a save, which is the point of it. These are the three ways back to
// the layout's Fit setting -- the Fit button already chosen, the layout cell
// already active, and a two-finger double-tap -- all of which end in refit().
//
// A score is needed for a real layout, so the layout is stubbed here and what
// is tested is the gesture plumbing: what counts as a two-finger tap, what one
// alone must not do, and refit()'s own contract against the real prototype.
const pageFile = path.join(__dirname, "..", "build", "podium.html");
test.skip(!fs.existsSync(pageFile), "build/podium.html is missing; run build.py --podium");

// A two-finger tap has to end within _gs_ (618ms) of the second finger landing,
// and the second tap has to start within _gs_ of the first ending.
const GS = 618;

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._menu_?.rings?.layout?.cells?.vertical);
});

// Stand a .pz element where a layout's would be and let Layout.activeLayout
// point at it, so the gesture code sees what it would see with a score open.
// refit() is counted rather than run: rebuilding is Layout's business, and the
// test below pins down its contract separately.
async function stubLayout(page) {
  return page.evaluate(() => {
    window.__refits = 0;
    const elm = document.createElement("div");
    elm.className = "pz";
    Object.assign(elm.style, {
      position: "absolute", left: 0, top: 0, width: "400px", height: "400px",
    });
    document.body.append(elm);
    const layout = {
      elm,
      cell: window._menu_.rings.layout.cells.vertical,
      cancelNav() {},
      constrain() {},
      refit() { window.__refits++; },
    };
    elm.owner = layout;
    window._Layout_.activeLayout = layout;
  });
}

// Trusted events: the pinch deliberately ignores untrusted pointerups, because
// mobile WebKit/Blink fire a synthetic one as the second finger joins, so a
// pinch cannot be ended from script. CDP's touch events are the real thing.
async function twoFinger(page, points, { hold = 20, spread = 0 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const touches = points.map((p, i) => ({ ...p, id: i + 1 }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touches });
  if (spread) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touches.map((t, i) => ({ ...t, x: t.x + (i ? spread : -spread) })),
    });
  }
  await page.waitForTimeout(hold);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [touches[0]] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

const onLayout = [{ x: 150, y: 200 }, { x: 250, y: 200 }];

test("two fingers tapped twice on the layout refit it", async ({ page }) => {
  await stubLayout(page);

  await twoFinger(page, onLayout);
  // One tap cannot do it: two fingers resting on the score and lifted again is
  // not a request to throw the reader's view away.
  expect(await page.evaluate(() => window.__refits)).toBe(0);

  await twoFinger(page, onLayout);
  expect(await page.evaluate(() => window.__refits)).toBe(1);

  // And the pair is consumed, so a third tap starts over rather than refitting
  // again on every tap from here on.
  await twoFinger(page, onLayout);
  expect(await page.evaluate(() => window.__refits)).toBe(1);
});

test("two taps too far apart are two taps", async ({ page }) => {
  await stubLayout(page);

  await twoFinger(page, onLayout);
  await page.waitForTimeout(GS + 150);
  await twoFinger(page, onLayout);

  expect(await page.evaluate(() => window.__refits)).toBe(0);
});

test("a pinch is not half of a double-tap", async ({ page }) => {
  await stubLayout(page);

  // Zooming and then lifting both fingers would otherwise arm the gesture, so
  // the next deliberate pinch-and-release would refit instead of zooming.
  await twoFinger(page, onLayout, { spread: 60 });
  await twoFinger(page, onLayout);

  expect(await page.evaluate(() => window.__refits)).toBe(0);
});

test("fingers that linger are not a tap", async ({ page }) => {
  await stubLayout(page);

  // Two fingers held on the score and then lifted -- a hand resting on a
  // tablet, not a gesture.
  await twoFinger(page, onLayout, { hold: GS + 150 });
  await twoFinger(page, onLayout);

  expect(await page.evaluate(() => window.__refits)).toBe(0);
});

test("the gesture answers for the layout alone", async ({ page }) => {
  await stubLayout(page);

  // On the background a pinch resizes everything, so a double-tap there would
  // promise to undo all of it; the menu and panels have no fit to return to.
  const offLayout = [{ x: 600, y: 600 }, { x: 700, y: 600 }];
  await twoFinger(page, offLayout);
  await twoFinger(page, offLayout);
  expect(await page.evaluate(() => window.__refits)).toBe(0);

  // Nor may a tap off the layout count as the first of a pair.
  await twoFinger(page, offLayout);
  await twoFinger(page, onLayout);
  expect(await page.evaluate(() => window.__refits)).toBe(0);
});

test("refit discards the remembered view and rebuilds without the flight", async ({ page }) => {
  // The real method, on a stub standing in for a built layout: forgetting the
  // pan-zoom is not enough, because the marker left behind would let the next
  // capturePz() store the fitted geometry as a view the reader had chosen --
  // and the reset would then survive as a pan-zoom of its own. The rebuild has
  // to be the quiet one, or the layout flies out of the menu cell again, which
  // is a long way round for a view that is already on screen.
  const after = await page.evaluate(async () => {
    const elm = document.createElement("div");
    elm.classList.add("pz-set");
    const layout = {
      elm,
      cell: { stash: { pz: { left: "10px", top: "20px", fontSize: "2em", w: 1, h: 1 } } },
      built: null,
      placed: false,
      build(animated) { this.built = animated; },
      place() { this.placed = true; },
    };
    await window._Layout_.prototype.refit.call(layout);
    return {
      pz: layout.cell.stash.pz, marked: elm.classList.contains("pz-set"),
      built: layout.built, placed: layout.placed,
    };
  });

  expect(after).toEqual({ pz: null, marked: false, built: false, placed: true });
});

test("placing a layout puts it at its fit, centred, at once", async ({ page }) => {
  // A quiet rebuild deliberately leaves the layout where it is -- that is what
  // makes it right after a cut or a paste -- so refit has to place it, and the
  // zoom a pinch left behind has to go with it.
  const placed = await page.evaluate(() => {
    const elm = document.createElement("div");
    Object.assign(elm.style, { position: "absolute", left: "17px", top: "23px", fontSize: "2.4em" });
    const child = document.createElement("div");
    Object.assign(child.style, { width: "200px", height: "100px" });
    elm.append(child);
    document.body.append(elm);
    const layout = { elm, centerLT: window._Layout_.prototype.centerLT };
    window._Layout_.prototype.place.call(layout);
    return {
      fontSize: elm.style.fontSize,
      left: elm.style.left, top: elm.style.top,
      middle: `${innerWidth / 2}px`,
    };
  });

  expect(placed.fontSize).toBe("1em");
  // centerLT centres the firstChild on the viewport, holding it a margin clear
  // of the top left; a 200x100 child in a window this size clears it.
  expect(placed.left).toBe(placed.middle);
  expect(placed.top).not.toBe("23px");
});

test("every layout snaps back to the state it was built in", async ({ page }) => {
  // The stubs above pin down the plumbing; this is the behaviour. A score is
  // needed for a real layout, and Score -> New makes an empty one, so all four
  // layouts can be built, pinched, and refitted for real. What must come back
  // is the state each was built in, with no transition left running: a layout
  // that flies out of the menu cell again has travelled a long way round for a
  // view that was already on screen.
  test.setTimeout(90_000);
  await page.evaluate(() => window._menu_.notify("score/new/up"));
  await expect.poll(() => page.evaluate(() => !!window._score_), { timeout: 30_000 }).toBe(true);

  for (const key of ["book", "horizontal", "vertical", "table"]) {
    const result = await page.evaluate(async (key) => {
      const Layout = window._Layout_;
      await Layout.open(window._menu_.rings.layout.cells[key]);
      const layout = Layout.activeLayout;
      const read = () => ({
        fontSize: layout.elm.style.fontSize,
        left: layout.elm.style.left,
        top: layout.elm.style.top,
        marked: layout.elm.classList.contains("pz-set"),
      });
      // The opening animation has to land before anything is measured.
      await new Promise(done => setTimeout(done, _gs_ * 2));
      const fitted = read();

      // Stand in for a pinch and a drag, as the gesture code would leave them.
      Object.assign(layout.elm.style, { fontSize: "2.3em", left: "40px", top: "40px" });
      layout.elm.classList.add("pz-set");

      await layout.refit();
      const after = read();
      // No transition may be running, or the snap is a flight after all.
      const transition = layout.elm.style.transition;
      // And nothing may be left for the next save or layout switch to restore.
      layout.capturePz();
      return { fitted, after, transition, pz: layout.cell.stash.pz };
    }, key);

    expect(result.after, key).toEqual(result.fitted);
    expect(result.transition, key).toBe("unset");
    expect(result.pz, key).toBe(null);
    expect(result.fitted.marked, key).toBe(false);
  }
});

test("re-tapping the layout already on screen refits instead of reopening", async ({ page }) => {
  // Reopening would save the pan-zoom in the destructor and restore it in the
  // rebuild, so the tap would cost a "Formatting" shade and change nothing.
  const calls = await page.evaluate(async () => {
    const cell = window._menu_.rings.layout.cells.vertical;
    const Layout = window._Layout_;
    let opened = 0, refits = 0;
    const open = Layout.open;
    Layout.open = () => { opened++; };
    Layout.activeLayout = { cell, refit() { refits++; } };
    // The cells are disabled until a score is open, and notify() honours that.
    cell.elm?.classList.remove("Menu__cell-disabled");
    window._menu_.notify("layout/vertical/up");
    await new Promise(done => setTimeout(done, 50));

    // A different layout still opens: only the one already on screen refits.
    Layout.activeLayout = { cell: window._menu_.rings.layout.cells.book, refit() { refits++; } };
    window._menu_.notify("layout/vertical/up");
    await new Promise(done => setTimeout(done, 50));
    Layout.open = open;
    return { opened, refits };
  });

  expect(calls).toEqual({ opened: 1, refits: 1 });
});
