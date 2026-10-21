// Rasterises the PWA icons build.py writes as SVG.
//
// build.py prefers cairosvg and then ImageMagick, but neither is usually
// present on Windows: cairosvg's wheel installs without the cairo DLL it needs,
// and the "convert" on PATH is Windows' own FAT-to-NTFS converter. Playwright is
// already part of this repository's toolchain, so it can stand in.
//
// Usage: node render-icons.js <directory> <size>...
// Reads <directory>/icon<size>.svg and writes <directory>/icon<size>.png.

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("@playwright/test");

async function main() {
  const [directory, ...sizes] = process.argv.slice(2);
  if (!directory || !sizes.length) {
    console.error("Usage: node render-icons.js <directory> <size>...");
    process.exit(2);
  }

  const browser = await chromium.launch();
  try {
    for (const size of sizes) {
      const pixels = Number(size);
      if (!Number.isInteger(pixels) || pixels < 1) throw new Error(`Bad size: ${size}`);
      const page = await browser.newPage({ viewport: { width: pixels, height: pixels } });
      // The SVG carries its own width, height and opaque background, so the
      // viewport-sized shot is the icon exactly.
      await page.goto(pathToFileURL(path.join(directory, `icon${size}.svg`)).href);
      await page.screenshot({ path: path.join(directory, `icon${size}.png`) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
