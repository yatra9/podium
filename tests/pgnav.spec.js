const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

// Tapping a scrolling layout turns the page: the half of the visible frame the
// finger lands in decides the direction -- left/top goes back, right/bottom goes
// on. The staff-and-barline toast is for the reader who asks for a page that is
// not there, and it has to stay that rare: a tap that wanders a pixel or two
// before it lifts used to raise it, so page one answered a tap on its right
// half with "this is the beginning" while turning the page anyway.
const pageFile = path.join(__dirname, "..", "build", "podium.html");
test.skip(!fs.existsSync(pageFile), "build/podium.html is missing; run build.py --podium");

const GS = 618;

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.goto("/podium.html");
  await page.waitForFunction(() => !!window._menu_?.rings?.layout?.cells?.vertical);
  await page.evaluate(() => { window._menu_.rings.score.cells.new.stash.pgCount = 8; });
  await page.evaluate(() => window._menu_.notify("score/new/up"));
  await expect.poll(() => page.evaluate(() => !!window._score_), { timeout: 30_000 }).toBe(true);
});

// Open a layout at its first page and start counting the toasts, returning the
// visible frame so a caller can aim at one half of it.
async function openAt1(page, key) {
  return page.evaluate(async (key) => {
    const Layout = window._Layout_;
    await Layout.open(window._menu_.rings.layout.cells[key]);
    // The opening flight and the page move both have to land, or the frame has
    // no geometry yet to aim a finger at.
    await new Promise(done => setTimeout(done, _gs_ * 3));
    await Layout.activeLayout.pgGoTo(1);
    await new Promise(done => setTimeout(done, _gs_ * 2));
    window.__alerts = [];
    Layout.pgAlert = (which) => { window.__alerts.push(which); };
    const box = Layout.activeLayout.frame.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }, key);
}

// Trusted touch events: the layout's own gesture code is reached through the
// same path a finger takes, and CDP's are the real thing.
async function finger(page, from, moves, { hold = 20 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const at = (p) => [{ ...p, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from) });
  for (const m of moves) {
    await page.waitForTimeout(hold);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(m) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

// A point in the frame, given as fractions along the scrolling axis and across
// it. The menu is centred on the viewport and its rings reach a good way out,
// so these aim near the ends of the scrolling axis: aiming anywhere near the
// middle of the frame lands the finger on a ring cell instead.
function spot(box, axis, along, across) {
  let fx = axis == "x" ? along : across, fy = axis == "x" ? across : along;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

for (const [key, axis] of [["horizontal", "x"], ["vertical", "y"]]) {
  test(`a tap on the far side of a ${key} layout turns the page without complaining`, async ({ page }) => {
    const box = await openAt1(page, key);
    // Well into the far half of the scrolling axis -- the half that goes on --
    // and a couple of pixels of drift on the way up: a finger, not a mouse.
    const from = spot(box, axis, 0.9, 0.5);
    const drift = { ...from, [axis]: from[axis] + 2 };

    await finger(page, from, [drift], { hold: 15 });
    await page.waitForTimeout(GS * 2);

    expect(await page.evaluate(() => window.__alerts)).toEqual([]);
    // The sash has moved on. How far is the Snap setting's business -- a half
    // page leaves the page number alone -- so what is asserted is the direction.
    expect(await page.evaluate(() => _Layout_.activeLayout.sashStart)).toBeLessThan(0);
  });

  test(`dragging a ${key} layout off its first page still says so`, async ({ page }) => {
    const box = await openAt1(page, key);
    // A real drag back past page one: the sash is already at its limit, so it
    // cannot follow, and the reader deserves to be told why.
    const from = spot(box, axis, 0.05, 0.5);
    const moves = [1, 2, 3, 4].map((n) => ({ ...from, [axis]: from[axis] + n * 15 }));

    await finger(page, from, moves, { hold: 60 });
    await page.waitForTimeout(GS * 2);

    expect(await page.evaluate(() => window.__alerts)).toContain("start");
    expect(await page.evaluate(() => _Layout_.activeLayout.sashStart)).toBe(0);
  });
}
