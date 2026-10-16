# Podium

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
| `python3 build.py --guide` | Build Guidebook keyword index |
| `python3 build.py --font` | Build font assets (embeds Bravura.otf as base64) |
| `python3 build.py --sample` | Build piano samples (requires ffmpeg) |
| `python3 build.py --yin` | Build pitch detection worklet (requires emcc) |
| `python3 build.py --cert` | Generate SSL certificate (requires openssl) |
| `python3 build.py --clean` | Clean build artifacts |

The build system creates a single-file distribution at `build/podium.html` that includes all dependencies, assets, and source code inline.

## License

[GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0-standalone.html)
