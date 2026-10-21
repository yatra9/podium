const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

// A page-number band is a scrubber a pixel or two per page wide in a long
// score, so nothing on it can be aimed at by position alone. Bookmarks
// therefore have two exact targets: the cursor, which stands for the page being
// read, and a tab, which stands for the page it marks.
const pageFile = path.join(__dirname, "..", "build", "podium.html");
test.skip(!fs.existsSync(pageFile), "build/podium.html is missing; run build.py --podium");

test.use({ viewport: { width: 1280, height: 720 }, hasTouch: true });

const GS = 618;
const LONG = GS * 1.5; // comfortably past the long-press threshold
const PAGES = 120; // enough that a page is worth a few pixels of band, no more

test.beforeEach(async ({ page }) => {
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._menu_?.rings?.layout?.cells?.vertical);
});

// Build a fresh @pgCount page score. Scores are made from the score ring's
// "new" cell, as numbers.spec.js does.
async function newScore(page, pgCount) {
  await page.evaluate((pgCount) => {
    window._menu_.rings.score.cells.new.stash.pages = pgCount;
  }, pgCount);
  await page.evaluate(() => window._menu_.notify("score/new/up"));
  await expect.poll(() => page.evaluate(() => !!window._score_), { timeout: 60_000 }).toBe(true);
}

// Open Horizontal with its bands down the sides, so the band runs the height of
// the window, and settle on @pn. Bookmarks for @marks are planted first, as a
// score arriving with bookmarks of its own does.
async function open(page, pn, marks = []) {
  await page.evaluate(async ([pn, marks]) => {
    const Layout = window._Layout_;
    const cell = window._menu_.rings.layout.cells.horizontal;
    Object.assign(cell.stash, { pnShow: "On", pnBand: { axis: "L-R", place: "Inset" }, pz: null });
    for (const mark of marks) _score_.pgs[mark - 1].bookmark = "#ff0000";
    await Layout.open(cell);
    await new Promise(done => setTimeout(done, _gs_ * 3));
    await Layout.activeLayout.pgGoTo(pn);
    await new Promise(done => setTimeout(done, _gs_ * 2));
  }, [pn, marks]);
}

// Where everything is, and what is bookmarked. The band is a left-hand one, so
// its long axis is y throughout.
function read(page) {
  return page.evaluate(() => {
    const pager = window._Layout_.activeLayout.pagerLeft;
    const rect = (elm) => {
      const b = elm.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    return {
      pn: _score_.numbers.pn,
      marks: _score_.pgs.map((pg, i) => (pg.bookmark ? i + 1 : 0)).filter(Boolean),
      band: rect(pager.elm),
      cursor: rect(pager.cursor),
      tabs: [...pager.elm.children]
        .filter(elm => elm.dataset.tag == "bookmark")
        .map(elm => ({ pn: elm.pn, ...rect(elm) })),
    };
  });
}

// One finger, down at @at for @ms, up again. Playwright's own tap cannot be
// held, so the touch is driven through CDP as the other gesture specs do.
async function press(page, at, ms) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...at, id: 1 }] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(GS * 3); // let any page turn land
}

const mid = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

test("a long press by the cursor bookmarks the page being read, not the one under the finger", async ({ page }) => {
  await newScore(page, PAGES);
  await open(page, 60);
  const before = await read(page);

  // 40px off the cursor: inside the zone, but several pages' worth of band away,
  // which is the error the reader was fighting.
  await press(page, { x: mid(before.band).x, y: mid(before.cursor).y + 40 }, LONG);

  const after = await read(page);
  expect(after.marks).toEqual([before.pn]);
  // And a bookmark press is not a page turn: the press is given back.
  expect(after.pn).toBe(before.pn);
});

test("a long press away from the cursor is still just a tap", async ({ page }) => {
  await newScore(page, PAGES);
  await open(page, 60);
  const before = await read(page);

  // A finger that meant to tap a distant page and lingered. Bookmarking
  // something it never asked about would be unexplainable to a reader who has
  // never heard of bookmarks.
  await press(page, { x: mid(before.band).x, y: before.band.y + before.band.height * 0.9 }, LONG);

  const after = await read(page);
  expect(after.marks).toEqual([]);
  expect(after.pn).toBeGreaterThan(before.pn + 20);
});

test("a tab is drawn where a finger has to land to reach its page", async ({ page }) => {
  await newScore(page, PAGES);
  await open(page, 90, [90]);
  const here = await read(page);
  const tab = here.tabs[0];

  // The cursor is a square that travels between the ends, so a page's share of
  // the band is not its share of the band's length. Drawn the naive way the tab
  // sat half a cursor -- a dozen pages -- from the page it marks.
  const travel = here.band.height - here.cursor.height;
  expect(Math.abs(mid(tab).y - mid(here.cursor).y)).toBeLessThanOrEqual(travel / PAGES + 2);
  // It also has to be big enough to see and to hit: its own page is 5px of this
  // band, and a page of a real score far less.
  expect(tab.height).toBeGreaterThanOrEqual(10);
});

test("tapping a tab goes to the page it marks", async ({ page }) => {
  await newScore(page, PAGES);
  await open(page, 10, [100]);
  const before = await read(page);

  // Aim at the tab, inside the band: tabs are drawn overhanging its inner edge
  // and the roll they sit in clips the overhang away.
  const tab = before.tabs[0];
  await press(page, { x: before.band.x + before.band.width * 0.8, y: mid(tab).y }, 60);

  const after = await read(page);
  expect(after.pn).toBe(100);
  expect(after.marks).toEqual([100]);
});

test("holding a tab clears it and leaves the reader where they were", async ({ page }) => {
  await newScore(page, PAGES);
  await open(page, 10, [100]);
  const before = await read(page);

  await press(page, { x: before.band.x + before.band.width * 0.8, y: mid(before.tabs[0]).y }, LONG);

  const after = await read(page);
  expect(after.marks).toEqual([]);
  expect(after.tabs).toEqual([]);
  // The point of clearing a bookmark in place is not having to travel to it.
  expect(after.pn).toBe(before.pn);
});

test("a hidden band scrubs but does not bookmark", async ({ page }) => {
  await newScore(page, PAGES);
  await page.evaluate(async () => {
    const Layout = window._Layout_;
    const cell = window._menu_.rings.layout.cells.horizontal;
    Object.assign(cell.stash, { pnShow: "Off", pnBand: { axis: "L-R", place: "Inset" }, pz: null });
    await Layout.open(cell);
    await new Promise(done => setTimeout(done, _gs_ * 3));
    await Layout.activeLayout.pgGoTo(10);
    await new Promise(done => setTimeout(done, _gs_ * 2));
  });
  const before = await read(page);

  // With the numbers off there is no cursor and no tab to be seen, so a press
  // that lingers has nothing to have been aiming at -- and a bookmark nobody
  // can see is the worst kind.
  await press(page, mid(before.band), LONG);

  const after = await read(page);
  expect(after.marks).toEqual([]);
  // Vacuity guard: the press did reach the band, which still scrubs.
  expect(after.pn).not.toBe(before.pn);
});

test("the Table layout announces a bookmark once it has made it", async ({ page }) => {
  await newScore(page, 8);
  const seen = await page.evaluate(async () => {
    const Layout = window._Layout_;
    const cell = window._menu_.rings.layout.cells.table;
    Object.assign(cell.stash, { pnShow: "On", pz: null });
    await Layout.open(cell);
    await new Promise(done => setTimeout(done, _gs_ * 3));
    // The event used to be dispatched on the way in, before the long press that
    // makes the bookmark had even been timed, so every listener was told about
    // the state before the change and never about the change.
    window.__bk = [];
    _body_.addEventListener("BOOKMARK", () =>
      window.__bk.push(_score_.pgs.filter(pg => pg.bookmark).length));
    // Any page's number will do, so long as the finger can actually reach it:
    // the menu ring is centred on the window and sits over some of the table.
    for (const pn of document.getElementsByClassName("TableLayout__pn")) {
      const box = pn.getBoundingClientRect();
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      if (document.elementFromPoint(at.x, at.y)?.closest(".TableLayout__pg")) return at;
    }
    return null;
  });

  await press(page, seen, LONG);

  expect(await page.evaluate(() => window.__bk)).toEqual([1]);
});
