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
test.use({ viewport: { width: 1280, height: 720 } });

const LAYOUTS = ["book", "horizontal", "vertical"];

test.beforeEach(async ({ page }) => {
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._menu_?.rings?.layout?.cells?.vertical);
  await page.evaluate(() => { window._menu_.rings.score.cells.new.stash.pgCount = 4; });
  await page.evaluate(() => window._menu_.notify("score/new/up"));
  await expect.poll(() => page.evaluate(() => !!window._score_), { timeout: 30_000 }).toBe(true);
});

// Open @key with the given Numbers settings and report the page size the fit
// arrived at, plus where the two bands ended up.
async function build(page, key, pnShow, pnPlace = "Inset") {
  return page.evaluate(async ([key, pnShow, pnPlace]) => {
    const Layout = window._Layout_;
    const cell = window._menu_.rings.layout.cells[key];
    Object.assign(cell.stash, { pnShow, pnPlace, pz: null });
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
  }, [key, pnShow, pnPlace]);
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
    // Layout settings travel inside the score file, so "On" keeps turning up:
    // it meant the edges that layout used at the time, which is where a reader
    // who saved that score expects to find the numbers.
    const on = await build(page, key, "On");
    const legacy = key == "vertical" ? ["top", "bottom"] : ["left", "right"];
    expect([on.first.at, on.last.at], key).toEqual(legacy);
    expect([on.first.thick, on.last.thick], key).toEqual([45, 45]);
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
      panel.syncPnPlace();
      return Object.values(panel.pnPlaceGroups.book.elms)
        .map(elm => elm.classList.contains("ButtonGroup__button-disabled"));
    };
    return { off: read("Off"), sides: read("L-R") };
  });

  expect(state.off).toEqual([true, true]);
  expect(state.sides).toEqual([false, false]);
});
