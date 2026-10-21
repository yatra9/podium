const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

// The page-number bands cost 45px of whichever dimension they sit on, and the
// fit is only ever short of one of them, so which pair of edges they take and
// whether they take anything at all is the reader's: "L-R" runs a tall band
// down each side, "T-B" a wide one across the top and the foot, and "Over"
// draws them on the pages, where they cost nothing.
const pageFile = path.join(__dirname, "..", "build", "podium.html");
test.skip(!fs.existsSync(pageFile), "build/podium.html is missing; run build.py --podium");

// A landscape window and the default A4 pages: every layout's fit is then
// settled by the height, so a band across the ends costs page size and a band
// down the sides is free. (Portrait trades the two round -- the point of the
// setting -- but one orientation is enough to pin the arithmetic down.)
test.use({ viewport: { width: 1280, height: 720 }, hasTouch: true });

const GS = 618;

const LAYOUTS = ["book", "horizontal", "vertical"];

test.beforeEach(async ({ page }) => {
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._menu_?.rings?.layout?.cells?.vertical);
  await page.evaluate(() => { window._menu_.rings.score.cells.new.stash.pages = 4; });
  await page.evaluate(() => window._menu_.notify("score/new/up"));
  await expect.poll(() => page.evaluate(() => !!window._score_), { timeout: 30_000 }).toBe(true);
});

// Open @key with the given Numbers settings and report the page size the fit
// arrived at, plus where the two bands ended up. @axis is "Off", "L-R" or
// "T-B"; "Off" leaves the band key out altogether, as a score saved by a
// Podium that never had one does, so the default edges are exercised too.
async function build(page, key, axis, place = "Inset") {
  return page.evaluate(async ([key, axis, place]) => {
    const Layout = window._Layout_;
    const cell = window._menu_.rings.layout.cells[key];
    Object.assign(cell.stash, { pnShow: axis == "Off" ? "Off" : "On", pz: null });
    if (axis == "Off") delete cell.stash.pnBand;
    else cell.stash.pnBand = { axis, place };
    await Layout.open(cell);
    await new Promise(done => setTimeout(done, _gs_ * 3));
    const layout = Layout.activeLayout, g = cell.geo;
    // Book keeps its page size loose in the geometry; the scrolls keep theirs in
    // a props-swapped object, so width means height in a vertical layout.
    const pg = g.pg
      ? { width: Math.round(g.pg.width), height: Math.round(g.pg.height) }
      : { width: Math.round(g.pgWidth), height: Math.round(g.pgHeight) };
    const band = (pager) => {
      const box = pager.elm.getBoundingClientRect();
      return {
        at: pager.position,
        in: pager.elm.parentElement.dataset.tag,
        thick: Math.round(Math.min(box.width, box.height)),
      };
    };
    return { pg, first: band(layout.pagerLeft), last: band(layout.pagerRight) };
  }, [key, axis, place]);
}

for (const key of LAYOUTS) {
  test(`${key} takes the band off the dimension the reader chooses`, async ({ page }) => {
    const off = await build(page, key, "Off");
    const sides = await build(page, key, "L-R");
    const ends = await build(page, key, "T-B");

    // The height is what this window is short of, so the band across the ends
    // comes out of the page and the band down the sides comes out of the room
    // to either side of it, which there is plenty of.
    expect(ends.pg.height, key).toBeLessThan(off.pg.height);
    expect(sides.pg, key).toEqual(off.pg);
    // Both bands are a band: the choice is where they go, not how big they are.
    expect([sides.first.thick, sides.last.thick], key).toEqual([45, 45]);
    expect([ends.first.thick, ends.last.thick], key).toEqual([45, 45]);
    expect([sides.first.at, sides.last.at], key).toEqual(["left", "right"]);
    expect([ends.first.at, ends.last.at], key).toEqual(["top", "bottom"]);
  });

  test(`${key} gives the pages the whole window when the bands lie on them`, async ({ page }) => {
    const off = await build(page, key, "Off");

    for (const axis of ["L-R", "T-B"]) {
      const over = await build(page, key, axis, "Over");
      // Nothing is reserved, so the fit lands exactly where it does with the
      // numbers turned off -- that is the whole point of drawing them on the
      // page, which has an engraved margin of its own to spare.
      expect(over.pg, `${key} ${axis}`).toEqual(off.pg);
      // And they have to be over the pages to be out of the way of the fit: in
      // a scroll that means the frame, the pages' own window, because a roll
      // would clip a full-width band down to Layout.margin.
      if (key != "book")
        expect([over.first.in, over.last.in], `${key} ${axis}`).toEqual(["frame", "frame"]);
    }
  });

  test(`${key} reserves nothing for bands it is not showing`, async ({ page }) => {
    // A hidden band is still a live scrubber, so it stays on the edges it would
    // have used -- parked across the pages it would answer a finger that meant
    // to turn the page -- and it must give the fit everything back.
    const off = await build(page, key, "Off");
    const over = await build(page, key, key == "vertical" ? "T-B" : "L-R", "Over");
    expect(off.pg, key).toEqual(over.pg);
    expect([off.first.thick, off.last.thick], key).not.toEqual([45, 45]);
  });

  test(`${key} reads a score saved before the edges could be chosen`, async ({ page }) => {
    // Layout settings travel inside the score file, and Numbers has always been
    // On or Off, so scores with no band key at all keep turning up -- including
    // from a Podium that has never heard of one. They open on the edges that
    // layout used at the time, which is where whoever saved them expects to
    // find the numbers.
    const on = await page.evaluate(async (key) => {
      const Layout = window._Layout_;
      const cell = window._menu_.rings.layout.cells[key];
      Object.assign(cell.stash, { pnShow: "On", pz: null });
      delete cell.stash.pnBand;
      await Layout.open(cell);
      await new Promise(done => setTimeout(done, _gs_ * 3));
      const layout = Layout.activeLayout;
      const band = (pager) => {
        const box = pager.elm.getBoundingClientRect();
        return { at: pager.position, thick: Math.round(Math.min(box.width, box.height)) };
      };
      return { first: band(layout.pagerLeft), last: band(layout.pagerRight),
               settled: JSON.parse(JSON.stringify(cell.stash.pnBand)) };
    }, key);
    const legacy = key == "vertical" ? ["top", "bottom"] : ["left", "right"];
    expect([on.first.at, on.last.at], key).toEqual(legacy);
    expect([on.first.thick, on.last.thick], key).toEqual([45, 45]);
    // And the stash is settled on the way through, so the panel has something
    // to show and the next save carries it.
    expect(on.settled, key).toEqual({ axis: key == "vertical" ? "T-B" : "L-R", place: "Inset" });
  });
}

for (const axis of ["L-R", "T-B"]) {
  test(`a band over the pages still answers the finger, ${axis} in Book`, async ({ page }) => {
    // Book's spine carries a z-index, so bands drawn over the pages sat under
    // them: a finger on a band turned the page it was lying on instead of
    // scrubbing to the page it was pointing at. The scrolls never showed it --
    // their bands have always been given a z-index of their own.
    await page.evaluate(() => { window._menu_.rings.score.cells.new.stash.pages = 8; });
    await page.evaluate(() => window._menu_.notify("score/new/up"));
    await expect.poll(() => page.evaluate(() => !!window._score_), { timeout: 30_000 }).toBe(true);

    const band = await page.evaluate(async (axis) => {
      const Layout = window._Layout_;
      const cell = window._menu_.rings.layout.cells.book;
      Object.assign(cell.stash, { pnShow: "On", pnBand: { axis, place: "Over" }, pz: null });
      await Layout.open(cell);
      await new Promise(done => setTimeout(done, _gs_ * 3));
      await Layout.activeLayout.pgGoTo(1);
      await new Promise(done => setTimeout(done, _gs_ * 2));
      const box = Layout.activeLayout.pagerLeft.elm.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }, axis);

    // Three quarters along the band, which in an eight page score is page six
    // or thereabouts; a page turn from page one could only reach page two.
    const at = axis == "L-R"
      ? { x: band.x + band.width / 2, y: band.y + band.height * 0.75 }
      : { x: band.x + band.width * 0.75, y: band.y + band.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    const touch = [{ ...at, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch });
    await page.waitForTimeout(30);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(GS * 3);
    await cdp.detach();

    expect(await page.evaluate(() => _score_.numbers.pn), axis).toBeGreaterThan(3);
  });
}

test("the Table layout numbers each page in its corner, with no edges to choose", async ({ page }) => {
  // There is no band to place, so the panel keeps the plain On/Off -- and the
  // corner numbers still have to answer to it.
  const shown = await page.evaluate(async () => {
    const Layout = window._Layout_;
    const cell = window._menu_.rings.layout.cells.table;
    const count = async (pnShow) => {
      cell.stash.pnShow = pnShow;
      await Layout.open(cell);
      await new Promise(done => setTimeout(done, _gs_ * 3));
      return document.getElementsByClassName("TableLayout__pn").length;
    };
    return { on: await count("On"), off: await count("Off") };
  });

  expect(shown.on).toBeGreaterThan(0);
  expect(shown.off).toBe(0);
});

test("the place row is dead while the numbers are off", async ({ page }) => {
  // Beside the pages or over them is not a question that arises when there are
  // no numbers, and a button that does nothing should not look as if it would.
  const state = await page.evaluate(async () => {
    const cell = window._menu_.rings.layout.cells.book;
    const panel = window._panels_.BookPanel.get(cell);
    const read = (pnShow) => {
      cell.stash.pnShow = pnShow;
      panel.syncPn();
      return Object.values(panel.pnPlaceGroups.book.elms)
        .map(elm => elm.classList.contains("ButtonGroup__button-disabled"));
    };
    return { off: read("Off"), on: read("On") };
  });

  expect(state.off).toEqual([true, true]);
  expect(state.on).toEqual([false, false]);
});

test("the panel shows the edges a score arrived with", async ({ page }) => {
  // The rows are two views of one stash key, so a stash the panel has not seen
  // written -- out of a score file, say -- has to leave a button lit in each
  // row. It once left the whole row blank, there being no button to match the
  // value the stash held.
  const lit = await page.evaluate(async () => {
    const cell = window._menu_.rings.layout.cells.vertical;
    const panel = window._panels_.VerticalPanel.get(cell);
    const active = (group) => Object.entries(group.elms)
      .filter(([, elm]) => elm.classList.contains("ButtonGroup__button-active"))
      .map(([tag]) => tag);
    const read = (stash) => {
      Object.assign(cell.stash, stash);
      panel.syncPn();
      return { band: active(panel.pnBandGroups.vertical), place: active(panel.pnPlaceGroups.vertical) };
    };
    const legacy = (() => { delete cell.stash.pnBand; return read({ pnShow: "On" }); })();
    return {
      legacy,
      chosen: read({ pnShow: "On", pnBand: { axis: "L-R", place: "Over" } }),
      off: read({ pnShow: "Off" }),
    };
  });

  // Vertical's numbers have always run across the ends, so that is what a score
  // with no band key of its own means.
  expect(lit.legacy).toEqual({ band: ["T-B"], place: ["Inset"] });
  expect(lit.chosen).toEqual({ band: ["L-R"], place: ["Over"] });
  expect(lit.off.band).toEqual(["Off"]);
});
