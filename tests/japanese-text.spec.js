const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

// The bundled fonts live in build/font.js, which only the packaged page carries,
// so these run against build/podium.html and skip when it has not been built.
const pageFile = path.join(__dirname, "..", "build", "podium.html");
test.skip(!fs.existsSync(pageFile), "build/podium.html is missing; run build.py --podium");

test.beforeEach(async ({ page }) => {
  await page.goto("/podium.html");
  await page.waitForFunction(
    () => window._resolveTextFont_ && window.fontData?.["Noto Sans JP"] && window.PDFLib && window.fontkit,
    null, { timeout: 60_000 });
});

test("a standard font still cannot encode Japanese", async ({ page }) => {
  // The reason the fallback exists. If pdf-lib ever stopped throwing here, the
  // switching below would be pointless work rather than a fix.
  const thrown = await page.evaluate(async () => {
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont("Times-Roman");
    try {
      doc.addPage([200, 200]).drawText("日本語", { font, x: 10, y: 100, size: 12 });
      await doc.save();
      return "no error";
    } catch (error) { return error.message; }
  });

  expect(thrown).toMatch(/WinAnsi cannot encode/);
});

test("text a standard font can carry keeps the font it asked for", async ({ page }) => {
  // Switching on any non-ASCII character would drag "café" into a different
  // typeface for no reason, so the request wins wherever it can.
  const resolved = await page.evaluate(() => [
    window._resolveTextFont_("Hello", "Times-Roman"),
    window._resolveTextFont_("café — €99 ™", "Helvetica-Bold"),
    window._resolveTextFont_("", "Courier"),
  ]);

  expect(resolved).toEqual([
    { pdfFontName: "Times-Roman", missing: [] },
    { pdfFontName: "Helvetica-Bold", missing: [] },
    { pdfFontName: "Courier", missing: [] },
  ]);
});

test("Japanese text switches to the bundled Japanese font", async ({ page }) => {
  const resolved = await page.evaluate(() => [
    window._resolveTextFont_("日本語", "Times-Roman"),
    window._resolveTextFont_("ドルチェ", "Patrick Hand"),
    // Mixed text has to go to the fallback whole: one text object, one font.
    window._resolveTextFont_("rit. だんだん遅く", "Helvetica"),
  ]);

  expect(resolved).toEqual([
    { pdfFontName: "Noto Sans JP", missing: [] },
    { pdfFontName: "Noto Sans JP", missing: [] },
    { pdfFontName: "Noto Sans JP", missing: [] },
  ]);
});

test("the fallback's gap against WinAnsi is exactly the seven known characters", async ({ page }) => {
  // The pristine font is a Japanese language subset, so it is not a superset of
  // WinAnsi. Pinning the gap means a change of font, or of the subset, shows up
  // here rather than as text quietly going missing from someone's score.
  const unsupported = await page.evaluate(() => {
    const ranges = [
      [0x20, 0x7e], [0xa0, 0xff], [0x152, 0x153], [0x160, 0x161], [0x178, 0x178],
      [0x17d, 0x17e], [0x192, 0x192], [0x2c6, 0x2c6], [0x2dc, 0x2dc],
      [0x2013, 0x2014], [0x2018, 0x201a], [0x201c, 0x201e], [0x2020, 0x2022],
      [0x2026, 0x2026], [0x2030, 0x2030], [0x2039, 0x203a], [0x20ac, 0x20ac],
      [0x2122, 0x2122],
    ];
    const missing = [];
    for (const [lo, hi] of ranges)
      for (let cp = lo; cp <= hi; cp++)
        if (!window._fontCanShow_("Noto Sans JP", cp)) missing.push(String.fromCodePoint(cp));
    return missing;
  });

  expect(unsupported).toEqual(["Š", "š", "Ÿ", "Ž", "ž", "ˆ", "˜"]);
});

test("a standard font is abandoned on any gap, because it throws rather than omits", async ({ page }) => {
  // "Š日" is the awkward case: the standard font can show Š but not 日, and the
  // fallback the reverse, so neither is strictly better. The standard font
  // still has to go -- keeping it would abort the save outright, where the
  // fallback loses one character and says so.
  const resolved = await page.evaluate(() => {
    const out = window._resolveTextFont_("Š日", "Times-Roman");
    return { ...out, missing: out.missing.map(cp => String.fromCodePoint(cp)) };
  });

  expect(resolved).toEqual({ pdfFontName: "Noto Sans JP", missing: ["Š"] });
});

test("a custom font is kept unless the fallback is strictly better", async ({ page }) => {
  const resolved = await page.evaluate(() => {
    // Patrick Hand has Š but no kanji; the fallback is the other way round.
    const worse = window._resolveTextFont_("Š", "Patrick Hand");
    const better = window._resolveTextFont_("日", "Patrick Hand");
    return {
      worse: { font: worse.pdfFontName, missing: worse.missing.length },
      better: { font: better.pdfFontName, missing: better.missing.length },
    };
  });

  // Switching for Š would trade a character that works for one that does not.
  expect(resolved.worse).toEqual({ font: "Patrick Hand", missing: 0 });
  expect(resolved.better).toEqual({ font: "Noto Sans JP", missing: 0 });
});

test("kana, JIS kanji of both levels, Greek and Cyrillic are all covered", async ({ page }) => {
  const covered = await page.evaluate(() => {
    const show = text => [...text].every(c => window._fontCanShow_("Noto Sans JP", c.codePointAt(0)));
    return {
      hiragana: show("あいうえおぁんゝ"),
      katakana: show("アイウエオヴー"),
      punctuation: show("、。「」・〜％？！…"),
      level1Kanji: show("日本語楽譜演奏速度強弱記号"),
      // Level 2 is where the characters of personal and place names live, and
      // the text written on a score is often somebody's name.
      level2Kanji: show("齟齬薔薇彌凛"),
      greek: show("αβγΩ"),
      cyrillic: show("абвЯ"),
      fullwidth: show("ＡＢｚ１２３"),
    };
  });

  expect(covered).toEqual({
    hiragana: true, katakana: true, punctuation: true, level1Kanji: true,
    level2Kanji: true, greek: true, cyrillic: true, fullwidth: true,
  });
});

test("a character outside the subset is reported rather than dropped", async ({ page }) => {
  // Both levels of JIS X 0208 are in the subset, but JIS X 0208 is not all of
  // Japanese: ゔ is outside it altogether, and U+20BB7 is outside the BMP. What
  // matters is that they are named, because a custom font does not throw -- it
  // substitutes glyph 0, and the text would just go missing.
  const resolved = await page.evaluate(() => {
    const out = window._resolveTextFont_("齟齬のないゔ\u{20BB7}", "Times-Roman");
    return { ...out, missing: out.missing.map(cp => String.fromCodePoint(cp)) };
  });

  expect(resolved.pdfFontName).toBe("Noto Sans JP");
  // The characters of the same string that the subset does have, 齟齬 among
  // them, must not be reported.
  expect(resolved.missing).toEqual(["ゔ", "\u{20BB7}"]);
});

test("the Japanese font is embedded as a subset, not whole", async ({ page }) => {
  // Without subset: true the font's every glyph lands in every saved score. The
  // Japanese subset is 1.4 MB, so this is the difference between a save of a
  // few kilobytes and one of well over a megabyte.
  const sizes = await page.evaluate(async () => {
    const out = {};
    for (const subset of [false, true]) {
      const doc = await PDFLib.PDFDocument.create();
      doc.registerFontkit(window.fontkit);
      const font = await doc.embedFont(window.fontData["Noto Sans JP"](), { subset });
      doc.addPage([200, 200]).drawText("日本語", { font, x: 10, y: 100, size: 12 });
      out[subset ? "subset" : "whole"] = (await doc.save()).length;
    }
    return out;
  });

  expect(sizes.subset).toBeLessThan(20_000);
  expect(sizes.whole).toBeGreaterThan(300_000);
});
