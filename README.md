# Podium

> This is a fork of [studiop5/podium](https://github.com/studiop5/podium), branched
> at v2.3.0, for use as a music stand on an Android tablet. What it adds and why —
> pCloud outside the browser extension, a static-host PWA deployment, Japanese text
> and guidebook, movable page-number bands, bookmark targeting, faster page
> jumps — is in [FORK-ja.md](FORK-ja.md) (Japanese).

**Podium is:**
- An e-reader for music scores.
- 100% browser-based, 100% open source, 100% free.
- No installation, no registration, no login, no file import. Just use it!
- Works in Chrome, Edge, Firefox, and Safari on desktop, tablet, and smartphone.
- Unique UI featuring a circular menu and multiple layouts.
- Alternative to generic PDF viewers, customized for the layout and annotation of scores in PDF format.
- Not a music library: works with PDF files stored locally or in the cloud.
- Uses PDF annotations and embedded document metadata to store user edits.

## Compatibility

**Runs on:**
- Laptops, Chromebooks, tablets, smartphones: anything with a modern browser.

**Input devices:**
- S-Pen, Apple Pencil, USI styli, fingers and thumbs.
- Mouse, track pad, computer keyboard, Bluetooth page turners.

## Practice Tools

- Metronome with animated conducting baton.
- On-screen piano keyboard with assisted tuning and pitch detection.
- Audio/video recorder with instant replay.
- Stopwatch and clock.

## Browser Extension

A Chrome/Edge browser extension is available for opening PDF scores directly from web pages (including IMSLP) into Podium via context menu or toolbar popup.

## Links

- **App**: https://studiop5.org/podium
- **Guidebook**: https://studiop5.org/Guidebook.html
- **Release Notes**: https://studiop5.org/releaseNotes.html
- **Privacy**: https://studiop5.org/privacy.html
- **Terms**: https://studiop5.org/terms.html

## Development

### Prerequisites

- [mise](https://mise.jdx.dev/)
- openssl (for SSL certificate generation)
- ffmpeg (optional, for piano sample processing)
- emcc (Emscripten compiler, for YIN pitch detector worklet)
- cairosvg or ImageMagick (optional, for PWA icon generation)

Install the pinned core toolchain and development dependencies without activating
mise in the shell:

```bash
mise install
mise exec -- python -m pip install -r requirements-dev.txt
mise exec -- npm install
mise exec -- npx playwright install chromium
```

Run project tools with `mise exec --`; this repository does not use
`mise activate`.

### Development Server

Start the HTTPS development server:

```bash
mise exec -- python serve.py
```

The server starts on port 9876 with a self-signed certificate. Generate the certificate first if needed:

```bash
mise exec -- python build.py --cert
```

Navigate to `https://localhost:9876/pod.html` to use the application.

### Build System

This project uses a custom Python-based build system.

### Personal Chrome extension

Build the self-contained application, then load `build/extension` as an
unpacked extension from `chrome://extensions`:

```bash
mise exec -- npm run build:extension
```

The personal build exposes pCloud only in the extension context. OAuth is the
recommended sign-in method and its access token is kept in
`chrome.storage.session`, so it is cleared when Chrome exits. Direct Login
remains available as a fallback; its optional remembered password uses the same
session-only storage and is never written to local or sync storage.

If `build/yin-worklet.js` has not already been built with Emscripten, this
command installs a no-op fallback worklet. pCloud Load/Save remains available,
but live pitch detection is disabled until `mise exec -- python build.py --yin`
is run with `emcc` available and the extension is rebuilt/reloaded.

#### Build Commands

| Command | Description |
|---------|-------------|
| `python3 build.py` | Full build (font, sample, yin, podium, guide) |
| `python3 build.py --podium` | Build single-file app (`build/podium.html`) |
| `python3 build.py --doc` | Recompress the guidebook's media for deployment (`build/doc-assets/`, requires ffmpeg) |
| `python3 build.py --pages` | Build a static-host deployment (`build/pages/`) |
| `python3 build.py --guide` | Build Guidebook keyword index |
| `python3 build.py --font` | Build font assets (embeds Bravura.otf as base64) |
| `python3 build.py --sample` | Build piano samples (requires ffmpeg) |
| `python3 build.py --yin` | Build pitch detection worklet (requires emcc) |
| `python3 build.py --cert` | Generate SSL certificate (requires openssl) |
| `python3 build.py --clean` | Clean build artifacts |

The build system creates a single-file distribution at `build/podium.html` that includes all dependencies, assets, and source code inline.

#### Static-host deployment

`--pages` writes `build/pages/`: the packaged page as `index.html`, plus
`manifest.webmanifest`, `sw.js`, `podauth.html` and the two PWA icons. Upload
the directory anywhere static — GitHub Pages, for instance — and Podium
installs as a PWA from it. Everything is referenced relatively, so it works from
any subdirectory and the directory may be renamed.

It also carries the guidebook, where `--doc` has been run first. The web app
publishes the guidebook beside the page, so `App → Guide` can reach it with a
relative URL; a deployment that does not carry it borrows the published copy
from studiop5.org instead, which the panel decides by probing for a local one.
The prose is deployed exactly as published, studiop5.org references included.

Only `doc/Guidebook.ja.html`, the Japanese translation, is deployed: it is what
this deployment's readers want, and carrying both would double the precache for
a copy one tap away. The panel leads with whichever translation it finds and
shows a language pill in its title bar; English falls back to the published
copy, so that one needs the network. UI names and the keyword index are left in
English, because that is what the app itself shows, and every `id` is shared
between the two files, so `--guide` writes one index into both and
cross-references work in either language. The translation carries a
`TRANSLATED-FROM:` digest of the English prose (the generated index excluded);
`--pages` reports a mismatch, deploys anyway, and prints the digest to paste in
once the translation has caught up.

`deploy-pages.sh` publishes the directory to this repository's `gh-pages`
branch:

```bash
mise exec -- python build.py --podium --pages
bash deploy-pages.sh
```

It assembles the commit with git plumbing, so neither the working tree nor the
current branch is touched — there is no `gh-pages` checkout, and the branch you
are working on stays checked out. `gh-pages` holds only the deployment and has
no relation to the source tree, which is why the commit is built by hand. The
remote branch is the parent, a deployment identical to the one already served is
a no-op, and the message records the source commit (marked `+dirty` when the
build may not match it). GitHub Pages then builds it, which takes a few minutes
and occasionally stalls; `gh api repos/<owner>/podium/pages/builds/latest --jq
.status` reports it and `gh api -X POST repos/<owner>/podium/pages/builds` prods
it.

`--doc` derives `build/doc-assets/` from `doc/assets/`, which is 42 MB of
capture-resolution screenshots and screen recordings: images become WebP at
1280px wide (13.5 MB → 2.5 MB) and clips become AV1 at 1280px wide (28.7 MB →
11.5 MB). The service worker precaches the guidebook and its images, so it reads
offline; the videos are fetched when played, which is also why `sw.js` leaves
media requests to the browser rather than intercepting them — media arrives as
Range requests, and the Cache API cannot store the 206 responses that answer
them. Encoding all 78 files takes minutes, so each output records the digest of
its input and of the recipe that made it, and is rebuilt only when one changes.

`mise exec -- ffmpeg` cannot be used for this: the mise ffmpeg is a conda-style
package whose bin directory shadows the C runtime for every process started
after it is put on PATH — including mise itself. `build_doc.py` locates the real
executable and runs it directly.

The one exception is OAuth. Each provider's console must list `podauth.html`'s
exact URL as a redirect URI, so moving the directory means re-registering it
there, and a deployment under a different origin needs its own client IDs.
Google Drive is unaffected: its web path uses the GIS token client, which is
authorised by JavaScript origin rather than by redirect URI. pCloud is
unaffected too, because outside the extension it uses password login, which
registers nothing.

The icons need cairosvg, ImageMagick, or node with Playwright — whichever is
present. Note that `convert` on Windows is Windows' own FAT-to-NTFS converter,
not ImageMagick, and the cairosvg wheel installs there without the cairo library
it needs; the Playwright fallback exists for that case.

## License

[GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0-standalone.html)
