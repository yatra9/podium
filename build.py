#!/bin/env python3
import argparse
import base64
import gzip
import hashlib
from datetime import datetime, timezone
import shutil
import zlib
from io import StringIO
from io import BytesIO
import os
import pdb
import re
import socket
import sys
import subprocess


if len(sys.argv) == 1:
   args = argparse.Namespace(verbose=True, font=True, sample=True, podium=True, yin=True, extension=False, doc=False, pages=False, guide=True, cert=False, clean=False, cert_host='') ;
else:
  parser = argparse.ArgumentParser()
  parser.add_argument('-s','--sample', action='store_true', help='(re)build build/sample.js')
  parser.add_argument('-f','--font', action='store_true', help='(re)build build/font.js')
  parser.add_argument('-p','--podium', action='store_true', help='(re)build build/podium.html')
  parser.add_argument('-y','--yin', action='store_true', help='(re)build build/yin.js')
  parser.add_argument('-e','--extension', action='store_true', help='(re)build the personal Chrome extension')
  parser.add_argument('--doc', action='store_true', help='(re)build build/doc-assets/, the guidebook media recompressed for deployment')
  parser.add_argument('--pages', action='store_true', help='(re)build build/pages/, a self-contained deployment for a static host')
  parser.add_argument('-g','--guide', action='store_true', help='(re)build guidebook keyword index')
  parser.add_argument('--certificate', '--cert', action='store_true', dest='cert', help='(re)build certificate')
  parser.add_argument('--cert-host', dest='cert_host', default='', help='comma-separated extra SAN hosts (IPs and/or names) to add to the dev certificate')
  parser.add_argument('-c','--clean', action='store_true', help='clean build artifacts from build/')
  parser.add_argument('-v','--verbose', action='store_true')
  args = parser.parse_args()

if args.clean:
    #################################
    #      Clean build artifacts    #
    #################################
    import shutil

    if args.verbose: print('Cleaning build artifacts...')

    # Remove build directory contents
    if os.path.exists('build'):
        shutil.rmtree('build')
        if args.verbose: print('Removed build/')

    if args.verbose: print('Clean complete.')
    sys.exit(0)

os.makedirs('build', exist_ok=True)

def build_yin(args):
    print("Building YIN worklet...")

    # Step 1: Compile WASM using emcc
    yin_wasm_path = os.path.join('build', 'yin.wasm')
    if args.verbose: print("  1. Compiling yin-wasm.c to yin.wasm with emcc...")
    result = subprocess.run([
        'emcc', os.path.join('src', 'yin-wasm.c'),
        '-o', yin_wasm_path,
        '-s', 'WASM=1',
        '-s', 'STANDALONE_WASM',
        '-s', 'EXPORTED_FUNCTIONS=["_yinf0"]',
        '-Wl,--no-entry',
        '-O3'
    ], capture_output=True, text=True)
    if result.returncode != 0:
        print("     emcc compilation failed!", file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        sys.exit(1)
    if args.verbose: print("     emcc compilation successful.")

    # Step 2: Write build/yin-wasm.b64 (raw base64 text)
    b64_path = os.path.join('build', 'yin-wasm.b64')
    if args.verbose: print(f"  2. Writing {b64_path}...")
    with open(yin_wasm_path, 'rb') as f:
        wasm_b64 = base64.b64encode(f.read()).decode('ascii')
    with open(b64_path, 'w') as f:
        f.write(wasm_b64)

    # Step 3: Build build/yin-worklet.js via Packager (embeds b64 via 'as' verb)
    worklet_output_path = os.path.join('build', 'yin-worklet.js')
    if args.verbose: print(f"  3. Packaging src/yin-worklet.js -> {worklet_output_path}...")
    build(os.path.join('src', 'yin-worklet.js'), worklet_output_path)

    if args.verbose: print(f"-- {worklet_output_path} (re)built")


if args.font:
    #################################
    #      (re)build font.js        #
    #################################

    # Build the embedded font (build/BravuraText.otf) from pristine lib/BravuraText.otf.
    from build_font import build_bravura, build_noto_jp
    build_bravura()
    # And the Japanese text font, subset from pristine lib/NotoSansJP-Regular.otf.
    build_noto_jp()

    outFileName = 'build/font.js'

    with open(outFileName, 'wb') as outFile:
        outFile.write(b"""
  { window.fontData = {} ;

    // Bravura Text font (registered as "Bravura" for both CSS and PDF embedding)
    const bravuraBase64 = \"""")

        with open('build/BravuraText.otf','rb') as inFile:
            outFile.write(base64.b64encode(inFile.read()))

        outFile.write(b"""\";

    let fontFile = new FontFace("Bravura", "url(data:font/otf;charset=utf-8;base64," + bravuraBase64 + ")");
    document.fonts.add(fontFile);
    await fontFile.load();

    // Lazy loading: convert base64 to Uint8Array only when PDF-lib needs it
    window.fontData["Bravura"] = function() {
      if (!this._bytes) {
        const binary = atob(bravuraBase64);
        this._bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          this._bytes[i] = binary.charCodeAt(i);
        }
      }
      return this._bytes;
    }.bind({});

    // Vercetti font
    const vercettiBase64 = \"""")

        with open('lib/Vercetti-Regular.otf','rb') as inFile:
            outFile.write(base64.b64encode(inFile.read()))

        outFile.write(b"""\";

    let vercettiFont = new FontFace("Vercetti", "url(data:font/otf;charset=utf-8;base64," + vercettiBase64 + ")");
    document.fonts.add(vercettiFont);
    await vercettiFont.load();

    // Store Vercetti data for PDF-lib
    window.fontData["Vercetti"] = function() {
      if (!this._bytes) {
        const binary = atob(vercettiBase64);
        this._bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          this._bytes[i] = binary.charCodeAt(i);
        }
      }
      return this._bytes;
    }.bind({});

    // Patrick Hand font
    const patrickHandBase64 = \"""")

        with open('lib/PatrickHand-Regular.ttf','rb') as inFile:
            outFile.write(base64.b64encode(inFile.read()))

        outFile.write(b"""\";

    let patrickHandFont = new FontFace("Patrick Hand", "url(data:font/ttf;charset=utf-8;base64," + patrickHandBase64 + ")");
    document.fonts.add(patrickHandFont);
    await patrickHandFont.load();

    // Store Patrick Hand data for PDF-lib
    window.fontData["Patrick Hand"] = function() {
      if (!this._bytes) {
        const binary = atob(patrickHandBase64);
        this._bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          this._bytes[i] = binary.charCodeAt(i);
        }
      }
      return this._bytes;
    }.bind({});

    // Noto Sans JP, subset to Podium's Japanese glyph set (see build_font.py).
    // Registered for CSS as well as for PDF embedding, so what the canvas draws
    // and what gets written to the PDF are the same shapes.
    const notoSansJpBase64 = \"""")

        with open('build/NotoSansJP-subset.otf','rb') as inFile:
            outFile.write(base64.b64encode(inFile.read()))

        outFile.write(b"""\";

    let notoSansJpFont = new FontFace("Noto Sans JP", "url(data:font/otf;charset=utf-8;base64," + notoSansJpBase64 + ")");
    document.fonts.add(notoSansJpFont);
    await notoSansJpFont.load();

    window.fontData["Noto Sans JP"] = function() {
      if (!this._bytes) {
        const binary = atob(notoSansJpBase64);
        this._bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          this._bytes[i] = binary.charCodeAt(i);
        }
      }
      return this._bytes;
    }.bind({});
  }
  """)

    if args.verbose: print(f'-- {outFileName} (re)built')

if args.sample:
    #################################
    #        (re)build sample.js    #
    #################################

    if shutil.which('ffmpeg') == None:
         sys.exit("Fatal error: building samples requires ffmpeg executable in your path.") ;

    import glob

    # define the path to where SalamanderGrandPianoV3 wav files are located:
    root = 'lib/Salamander' ;
    # initial cleanup
    # Define the samples we will package as 
    # ASPN:midi number items.
    # The standard 88-key piano range is A0-C8, but
    # we currentlty only use typical harpsichord/fortepiano
    # range of f1-f6.  The Salamander samples include
    # A,C,Ds, and Fs within each octave: intervening pitches
    # must be generated programmatically.
    notes = {
     'F#1':'30',
     'A1' :'33',
     'C2' :'36',
     'D#2':'39',
     'F#2':'42',
     'A2' :'45',
     'C3' :'48',
     'D#3':'51',
     'F#3':'54',
     'A3' :'57',
     'C4' :'60',
     'D#4':'63',
     'F#4':'66',
     'A4' :'69',
     'C5' :'72',
     'D#5':'75',
     'F#5':'78',
     'A5' :'81',
     'C6' :'84',
     'D#6':'87',
    }

    # covert .wav sample files to mp3.
    # Duration will be 2.25s.
    for note in notes:
        ifname = root + '/' + note + 'v8.wav'
        ofname = notes[note] + '.mp3'
        try:
            os.remove(ofname)
        except OSError:
            pass
        if args.verbose: print(f"Converting {ifname} to {ofname}")
        subprocess.run(
            ['ffmpeg', '-y', '-i', ifname, '-acodec', 'libmp3lame', '-t', '2.25s',
             '-ac', '2', '-b:a', '128k', '-ar', '22050', ofname],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )

    #  package mp3 files in javascript module:
    outFileName = 'build/sample.js'
    with open(outFileName,'wb') as outFile:
        outFile.write(b"""/** Salamandar piano samples as base64 MP3 **/\n
// +skip
export {pianoSamples}
// -skip
""")
        outFile.write(b'let pianoSamples={\n') ;
        for fileName in sorted(glob.iglob('*.mp3')):
            varName = fileName.split('.')[0]
            with open(fileName,'rb') as inFile:
                if args.verbose: print(f'Converting {fileName} to base64 and adding to {outFileName}')
                data = base64.b64encode(inFile.read())
                outFile.write(bytes(varName,'utf-8'))
                outFile.write(b':atob("') ;
                outFile.write(data)
                outFile.write(b'"),\n')
        outFile.write(b'}\n');

    # clean up
    for note in notes:
      ofname = notes[note] + '.mp3'
      try:
        os.remove(ofname)
      except OSError:
        pass

# Define Packager class (used by both --podium and --ext builds)
import shutil

class Packager(object):

    inSkip = False
    inComment = False
    inString = False
    inTemplateLiteral = False

    def __init__(self, inFileName, inFileObj, outFileObj):
        if args.verbose: print(f'packaging {inFileName}') ;
        lineNumber = 0
        for line in inFileObj:
            lineNumber += 1
            # process skip directive
            if "// +skip" in line:
                self.inSkip = True
            elif "// -skip" in line:
                self.inSkip = False
            if self.inSkip:
                continue
            # process "<!--[" and "]-->": xml comments
            # surrounding square brackets. These lines
            # are simply stripped from the output..this
            # allows commenting out html for "unprocessed"
            # files, while uncommenting them in the
            # "processed" file.
            if "<!--[" in line:
              continue ;
            if "]-->" in line:
              continue ;
            # process "// #write directive:
            # Look for line like this: // #write blah blah blah
            # When found, write "blah blah blah" (or whatever) to
            # the output
            if "// #write " in line:
               outFileObj.write(line.replace("// #write ","")) ;
               continue ;
            # Process included file directive:
            # Look for lines like this: // #include build/score.js 
            #   or // #include build.score.js deflateAs
            # When found, include the given file in the output.
            if "// #include " in line: 
                includedFilePath = line.split()[2] ;
                if args.verbose: print("including ", includedFilePath) ;
                outFileObj.write(line.replace("#include","#inclusion", 1)) ;
                with open(includedFilePath, encoding='utf-8') as includedFileObj:
                    if "minified" in line:
                        Packager(includedFilePath, includedFileObj, outFileObj)
                    elif "deflateAs" in line:
                        stringName = line.split()[-1] ;
                        self.deflateAs(stringName, includedFilePath, outFileObj) ;
                    elif "b64gzip" in line:
                        self.b64gzip(includedFilePath, outFileObj)
                    elif "urlBlob" in line:
                        urlName = line.split()[-1] ;
                        outFileObj.write(f"\n\nfunction {urlName}_func() {{\n") ;
                        shutil.copyfileobj(includedFileObj, outFileObj)
                        outFileObj.write("}\n") ;
                        outFileObj.write(f'let {urlName} = window.URL.createObjectURL(new Blob(["(" + {urlName}_func.toString() + ")"], {{type: "text/javascript"}}));\n');
                    elif "as" in line.split()[3:]:
                        varName = line.split()[-1] ;
                        content = includedFileObj.read()
                        escaped = content.replace('\\', '\\\\').replace('`', '\\`').replace('$', '\\$')
                        outFileObj.write(f'{varName} = `{escaped}`;\n')
                    else:
                        shutil.copyfileobj(includedFileObj, outFileObj)
                continue 
            # The source code uses only double-quoted strings, "":
            # (single quoted strings, '', are only used within double-quoted strings)
            # In javascript, double-quoted strings must not span multiple lines.
            # Template literals (backticks) CAN span multiple lines and can contain
            # double-quoted strings (like SVG attributes), so we track them separately.
            if self.inString and not self.inTemplateLiteral:
                print(f"Error at {inFileName}:{lineNumber}, unterminated string |{line}|")
            charCount = len(line)
            i = 0
            outLine = ''
            while i < charCount:
                char = line[i]

                # Not in a comment - check for strings and template literals
                if not self.inComment:
                    # Check if we're entering/exiting a template literal
                    if char == '`' and (i == 0 or line[i-1] != '\\'):
                        self.inTemplateLiteral = not self.inTemplateLiteral
                        outLine += char
                        i += 1
                        continue

                    # If we're in a template literal, just copy characters
                    # (don't track double quotes inside template literals)
                    if self.inTemplateLiteral:
                        outLine += char
                        i += 1
                        continue

                    # Check if we're entering/exiting a double-quoted string
                    if char == '"' and (i == 0 or line[i-1] != '\\'):  # Check for escaped quotes
                        self.inString = not self.inString
                        outLine += char
                        i += 1
                        continue

                    # If we're in a string, just copy the character
                    if self.inString:
                        outLine += char
                        i += 1
                        continue

                # Check for comments
                if i < charCount - 1:
                    nextChar = line[i+1]
                    if char == '/':
                        if nextChar == '/':
                            # Found a comment - emit everything up to here
                            outLine = outLine.strip()
                            if len(outLine) > 0:
                                outFileObj.write(outLine)
                                outFileObj.write('\n')
                            outLine = ''  # Clear outLine so it doesn't get written again after the loop
                            # Skip rest of line
                            break
                        if nextChar == '*':
                            self.inComment = True
                            i += 2
                            continue
                    if self.inComment and char == '*' and nextChar == '/':
                        self.inComment = False
                        i += 2
                        continue

                if not self.inComment:
                    outLine += char
                i += 1
            outLine = outLine.strip() ;
            if len(outLine) > 0:
                outFileObj.write(outLine)
                outFileObj.write('\n')
 
    def deflateAs(self, stringName, includedFilePath, outFileObj):
        # constents of includedFilePath:
        # gzip-compressed > base64 encoded > written to outFileObj
        # as contents of string variable with given name
        outFileObj.write(f'let {stringName} = "') ;
        with open(includedFilePath, 'rb') as inFile:
            fileContents = inFile.read()
            fileContentsCompressed = gzip.compress(fileContents) # bytes object
            fileContentsB64 = base64.b64encode(fileContentsCompressed) # encoded bytes
            fileContentsUtf8 = fileContentsB64.decode('utf-8') 
            outFileObj.write(fileContentsUtf8) ;
        outFileObj.write('" ;\n') ;

# Helper function to build using Packager (used by both --podium and --ext builds)
def build(inFileName, outFileName):
    with open(inFileName, encoding='utf-8') as inFileObj:
        with open(outFileName, "w", encoding='utf-8', newline='\n') as outFileObj:
            Packager(inFileName, inFileObj, outFileObj)

if args.yin:
    build_yin(args)

# The page of the 1-file build is derived from the development page,
# src/pod.html, so that the two cannot drift apart (nor can the browser
# extension's page: ext/build.py derives it from src/pod.html the same way).
# Only what must differ is patched in: the license in full, the PWA links, the
# service worker, and the scripts, which are all included inline. Every patch
# must match exactly once: a change to pod.html that breaks one stops the build.
PODIUM_PAGE_INCLUDE = '      // #include src/main.js minified\n'

def podium_page_patches(canonical):
  # canonical is None for a deployment whose URL is not known at build time, such
  # as build/pages/: claiming another site as canonical would be wrong there.
  return [
    # the license, in full, follows the page's own license notice:
    ('<https:/\\/www.gnu.org/licenses/>.\n-->\n',
     '<https:/\\/www.gnu.org/licenses/>.\n-->\n\n<!--\n{LICENSE}-->\n'),
    ('    <title id="title">Podium</title>\n',
     (f'    <link rel="canonical" href="{canonical}">\n' if canonical else '') +
     '    <link rel="manifest" href="manifest.webmanifest" />\n'
     '    <link rel="apple-touch-icon" href="icon192.png">\n'
     '    <meta name="apple-mobile-web-app-capable" content="yes">\n'
     '    <meta name="apple-mobile-web-app-title" content="Podium">\n'
     '    <title id="title">Podium</title>\n'),
    # the libraries are included by main.js itself (see its #include's):
    ('    <script src="fabric.min.js"></script> \n', ''),
    ("    <script type=\"module\">import * as pdfjsLib from './pdf.min.mjs'; window.pdfjsLib = pdfjsLib;</script>\n", ''),
    ('    <script src="pdf-lib.min.js"></script> \n', ''),
    ('    <script src="fontkit.umd.min.js"></script> \n', ''),
    ('    <script src="main.js" type="module"></script> \n',
     '    <script>\n'
     '      // Register service worker for PWA functionality\n'
     "      if ('serviceWorker' in navigator) {\n"
     "        window.addEventListener('load', () => {\n"
     "          navigator.serviceWorker.register('sw.js')\n"
     '            .then(registration => {\n'
     "              console.log('Podium: Service Worker registered with scope:', registration.scope);\n"
     '            })\n'
     '            .catch(error => {\n'
     "              console.log('Podium: Service Worker registration failed:', error);\n"
     '            });\n'
     '        });\n'
     '      }\n'
     '    </script>\n'
     '    <script type="module">\n'
     + PODIUM_PAGE_INCLUDE +
     '    </script>\n'),
]

def build_podium_page(outFileName, canonical="https://studiop5.org/podium"):
    with open("src/pod.html", encoding='utf-8') as f:
        page = f.read()
    with open("LICENSE", encoding='utf-8') as f:
        license = f.read()
    for old, new in podium_page_patches(canonical):
        if page.count(old) != 1:
            sys.exit(f'Error: page patch target not found exactly once in src/pod.html: {old!r}')
        page = page.replace(old, new.replace('{LICENSE}', license))
    # Only main.js goes through the Packager. The page itself is written as is:
    # the Packager reads its input as javascript, and would strip, say, the
    # rest of any line of html text containing "//".
    head, tail = page.split(PODIUM_PAGE_INCLUDE)
    packaged = StringIO()
    packaged.write(head)
    Packager("src/pod.html", StringIO(PODIUM_PAGE_INCLUDE), packaged)
    packaged.write(tail)
    # Stamp the build so the Version panel can say which one is running. The
    # version alone cannot answer that, and it is the question every PWA update
    # raises: the service worker may still be answering from its cache. Matched
    # loosely because the Packager minifies the spacing away.
    stamped, count = re.subn(
        r'window\._podiumBuild_\s*=\s*"dev"',
        'window._podiumBuild_ = "%s"' % datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC'),
        packaged.getvalue(), count=1)
    if count != 1:
        sys.exit('Error: window._podiumBuild_ = "dev" not found in the packaged page.')
    with open(outFileName, "w", encoding='utf-8', newline='\n') as outFileObj:
        outFileObj.write(stamped)

if args.extension:
    # A packaged Podium page always references this worklet. Keep extension
    # development possible without Emscripten; a real --yin build replaces it.
    yin_worklet = os.path.join('build', 'yin-worklet.js')
    if not os.path.exists(yin_worklet):
        shutil.copyfile(os.path.join('src', 'yin-worklet-fallback.js'), yin_worklet)
        print('  NOTE: using fallback YIN worklet; pitch detection is unavailable.')
    # The extension page starts from the very same packaged page as the 1-file
    # build, so the two cannot drift apart (see build_podium_page above).
    build_podium_page("build/podium.html")
    extension_dir = os.path.join('build', 'extension')
    extension_app_dir = os.path.join(extension_dir, 'build')
    # Everything under extension_dir is generated below, so start from nothing:
    # the page's scripts are numbered, and a build that emits fewer of them than
    # the last one would otherwise leave stale scripts behind to be packaged.
    # Clearing the contents is what matters; on Windows the directory itself
    # may survive while a handle to it is open, which is harmless here.
    shutil.rmtree(extension_dir, ignore_errors=True)
    os.makedirs(extension_app_dir, exist_ok=True)
    shutil.copyfile('manifest.json', os.path.join(extension_dir, 'manifest.json'))
    shutil.copyfile('extension-background.js', os.path.join(extension_dir, 'extension-background.js'))
    for pdf_module in ('pdf.min.mjs', 'pdf.worker.min.mjs'):
        with open(os.path.join('lib', pdf_module), encoding='utf-8') as source_file:
            pdf_source = source_file.read()
        # Avoid even attempting eval-based PDF.js optimizations under MV3 CSP.
        pdf_source = pdf_source.replace('try{new Function("");return!0}catch{return!1}', 'return!1')
        with open(os.path.join(extension_app_dir, pdf_module), 'w', encoding='utf-8', newline='\n') as target_file:
            target_file.write(pdf_source)
    # Manifest V3 forbids inline JavaScript. Extract every packaged script to
    # a local file while retaining attributes such as type="module".
    with open(os.path.join('build', 'podium.html'), encoding='utf-8') as packaged:
        extension_html = packaged.read()
    script_index = [0]
    def extract_extension_script(match):
        script_source = match.group(2)
        if 'navigator.serviceWorker.register' in script_source:
            return ''
        # fontkit's legacy global-object fallback uses Function("return this"),
        # which Manifest V3 forbids. Modern Chrome always provides globalThis.
        script_source = script_source.replace('Function("return this")()', 'globalThis')
        if 'type="module"' in match.group(1):
            script_source = (
                'import * as extensionPdfjsLib from "./pdf.min.mjs";\n'
                'window.pdfjsLib = extensionPdfjsLib;\n'
                'window.pdfjsLib.GlobalWorkerOptions.workerPort = '
                'new Worker("./pdf.worker.min.mjs", { type: "module" });\n' +
                script_source
            )
        script_index[0] += 1
        filename = f'podium-script-{script_index[0]}.js'
        with open(os.path.join(extension_app_dir, filename), 'w', encoding='utf-8', newline='\n') as script_file:
            script_file.write(script_source)
        return f'<script{match.group(1)} src="{filename}"></script>'
    extension_html = re.sub(r'<script([^>]*)>(.*?)</script>', extract_extension_script,
                            extension_html, flags=re.DOTALL | re.IGNORECASE)
    # These PWA-only resources are deliberately absent from the extension.
    extension_html = re.sub(r'\s*<link rel="manifest"[^>]*>', '', extension_html)
    extension_html = re.sub(r'\s*<link rel="apple-touch-icon"[^>]*>', '', extension_html)
    with open(os.path.join(extension_app_dir, 'podium.html'), 'w', encoding='utf-8', newline='\n') as extension_page:
        extension_page.write(extension_html)
    if args.verbose: print('-- personal extension podium.html (re)built.')

if args.podium:
    # Build 1-file, all-included version of podium as "build/podium.html":
    build_podium_page("build/podium.html")
    if args.verbose: print('-- podium.html (re)built.')

    # Generate PWA icons from SVG
    if args.verbose: print('Generating PWA icons...')
    os.makedirs('build/icons', exist_ok=True)

    # Use the same SVG as the extension, but with solid background and 20% safe zone padding for maskable icons.
    # the piano_glyph is the stylized music symbol "p": 
    piano_glyph_path = "M274 274C243 274 221 264 203 248C189 236 186 228 182 228C177 228 180 235 171 252C164 264 149 273 123 273C64 273 32 231 1 174C-4 165 -6 160 -6 155C-6 148 -1 144 5 144C12 144 16 150 21 159C50 209 70 235 88 235C96 235 99 230 99 223C99 215 96 205 93 198L-30 -107C-33 -115 -35 -117 -45 -117H-76C-85 -117 -89 -121 -89 -130C-89 -138 -85 -142 -77 -142H116C125 -142 129 -138 129 -129C129 -121 125 -117 117 -117H77C71 -117 68 -117 68 -114C68 -113 69 -110 70 -107L115 5C117 10 119 17 124 17C129 17 132 7 148 -1C162 -8 175 -10 192 -10C288 -10 366 90 366 185C366 243 330 274 274 274ZM247 237C264 237 270 222 270 200C270 151 217 24 169 24C152 24 144 35 144 56C144 77 152 97 163 125L183 174C197 208 223 237 247 237Z"

    # PWA icon with maskable safe zone (80% size centered = 20% padding)
    podium_icon_svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="{size}" height="{size}">
  <rect width="24" height="24" fill="#2d3748"/>
  <g transform="translate(2.4, 2.4) scale(0.8)">
    <path fill="#aaaaaa" stroke="#fff" stroke-width=".6" stroke-linejoin="round"
      d="M4 23v-3h16v3h1.5h-19Z M7 20v-14h10v14 M7 12h-2l-3 -10 h20l-3 10h-2"/>
    <path fill="#000" transform="translate(9.8, 13.5) scale(0.015, -0.015)" d="''' + piano_glyph_path + '''"/>
  </g>
</svg>'''

    def imagemagick():
        # Windows ships its own convert.exe, which converts FAT volumes to NTFS,
        # so finding the name proves nothing: ask what it is. ImageMagick 7
        # prefers "magick" in any case.
        for command in ('magick', 'convert'):
            if not shutil.which(command): continue
            try:
                version = subprocess.run([command, '-version'], capture_output=True,
                                         text=True, timeout=10)
            except (OSError, subprocess.SubprocessError):
                continue
            if 'ImageMagick' in version.stdout: return command
        return None

    def write_icon_svgs():
        for size in (192, 512):
            with open(f'build/icons/icon{size}.svg', 'w', encoding='utf-8') as f:
                f.write(podium_icon_svg.format(size=size))

    def remove_icon_svgs():
        for size in (192, 512):
            os.remove(f'build/icons/icon{size}.svg')

    pwa_icons_generated = False
    icon_paths = [f'build/icons/icon{size}.png' for size in (192, 512)]
    try:
        # A cairosvg installed without its native library raises OSError, not
        # ImportError, and must fall through to a fallback rather than stop the
        # build: the wheel installs cleanly on Windows without the cairo DLL.
        import cairosvg
        for size in [192, 512]:
            svg_content = podium_icon_svg.format(size=size)
            cairosvg.svg2png(bytestring=svg_content.encode('utf-8'),
                           write_to=f'build/icons/icon{size}.png',
                           output_width=size,
                           output_height=size)
        pwa_icons_generated = True
        if args.verbose: print('  Generated PWA icons using cairosvg')
    except (ImportError, OSError):
        # Try ImageMagick as fallback
        magick = imagemagick()
        if magick:
            write_icon_svgs()
            for size in (192, 512):
                subprocess.run([magick, '-background', '#2d3748', f'build/icons/icon{size}.svg',
                                '-resize', f'{size}x{size}', '-depth', '8',
                                '-type', 'TrueColor', f'build/icons/icon{size}.png'],
                               capture_output=True)
            remove_icon_svgs()
            # Claiming success without looking is how this went unnoticed before.
            pwa_icons_generated = all(os.path.exists(path) for path in icon_paths)
            if args.verbose and pwa_icons_generated:
                print(f'  Generated PWA icons using ImageMagick ({magick})')

    if not pwa_icons_generated and shutil.which('node'):
        # Playwright is already in this repository's toolchain, and on Windows it
        # is usually the only one of the three that is actually present.
        write_icon_svgs()
        rendered = subprocess.run(['node', 'render-icons.js', 'build/icons', '192', '512'],
                                  capture_output=True, text=True)
        remove_icon_svgs()
        pwa_icons_generated = all(os.path.exists(path) for path in icon_paths)
        if args.verbose and pwa_icons_generated: print('  Generated PWA icons using Playwright')
        elif not pwa_icons_generated and rendered.stderr.strip():
            print(f'  NOTE: Playwright could not render the icons: {rendered.stderr.strip()}')

    if not pwa_icons_generated:
        print('  NOTE: PWA icons not generated. Install cairosvg or ImageMagick, '
              'or make node and Playwright available.')

GUIDEBOOK_EN = os.path.join('doc', 'Guidebook.html')
GUIDEBOOK_JA = os.path.join('doc', 'Guidebook.ja.html')
INDEX_BEGIN_MARK = '<!-- BEGIN KEYWORD INDEX -->'
INDEX_END_MARK = '<!-- END KEYWORD INDEX -->'

def guidebook_prose_digest(path=GUIDEBOOK_EN):
    """Digest the English guidebook with the generated keyword index left out.

    The translation tracks the prose. --guide rewrites the index in both files
    from the same data, so counting it would report every index rebuild as a
    translation that had fallen behind.
    """
    with open(path, encoding='utf-8') as f:
        text = f.read()
    begin, end = text.find(INDEX_BEGIN_MARK), text.find(INDEX_END_MARK)
    if begin != -1 and end != -1:
        text = text[:begin] + text[end + len(INDEX_END_MARK):]
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]

if args.doc:
    #################################
    #   Guidebook media for deploy  #
    #################################
    # doc/assets/ is 42 MB of capture-resolution screenshots and screen
    # recordings, which is why the guidebook has always been read from the web.
    # build_doc.py derives a deployable set (13.5 MB) from it; --pages copies
    # the result in. Encoding takes minutes, so it is its own flag and each
    # output is rebuilt only when its input or its recipe changes.
    from build_doc import build_doc_assets
    if args.verbose: print('Recompressing guidebook media...')
    build_doc_assets(verbose=args.verbose)

if args.pages:
    #################################
    #   Static-host deployment      #
    #################################
    # A self-contained directory to upload to a static host such as GitHub
    # Pages. Everything in it is referenced relatively, so it works from any
    # subdirectory and the directory can be renamed -- with one exception: each
    # OAuth provider's console must list podauth.html's exact URL, so moving the
    # directory means re-registering it there. Google Drive is unaffected, its
    # web path being authorised by JavaScript origin rather than by redirect URI.
    pages_dir = os.path.join('build', 'pages')
    shutil.rmtree(pages_dir, ignore_errors=True)
    os.makedirs(pages_dir, exist_ok=True)
    # The entry is index.html, so the URL is just the directory, which is what
    # the manifest's "./" start_url and scope resolve to.
    build_podium_page(os.path.join(pages_dir, 'index.html'), canonical=None)
    for name in ('manifest.webmanifest', 'podauth.html'):
        shutil.copyfile(os.path.join('src', name), os.path.join(pages_dir, name))

    # The guidebook, so App -> Guide does not have to leave the deployment.
    # src/panel.js probes for it with a HEAD request and uses the published copy
    # at studiop5.org only when it is absent, so copying it in is the whole
    # change: nothing in the app needs to know which deployment this is. The
    # text is left exactly as published, studiop5.org references included --
    # rewriting prose to match the host would need judgement this cannot apply.
    #
    # Only the Japanese translation is deployed. It is what this deployment's
    # readers want, the panel leads with whichever translation it finds, and
    # carrying both would double the 7.4 MB precache for a copy that is one tap
    # and one request away: the panel's language switch falls back to the
    # published English guidebook, which needs the network but nothing else.
    doc_dir = os.path.join('build', 'doc-assets')
    doc_images = sorted(name for name in os.listdir(doc_dir)
                        if name.endswith('.webp')) if os.path.isdir(doc_dir) else []
    doc_to_cache = []
    if not doc_images:
        print('  NOTE: build/doc-assets/ is empty; run build.py --doc to deploy the guidebook.')
    else:
        assets_dir = os.path.join(pages_dir, 'assets')
        os.makedirs(assets_dir, exist_ok=True)
        for name in sorted(os.listdir(doc_dir)):
            if name.startswith('.'): continue    # the recipe manifest
            shutil.copyfile(os.path.join(doc_dir, name), os.path.join(assets_dir, name))
        with open(GUIDEBOOK_JA, encoding='utf-8', newline='') as f:
            guidebook = f.read()
        # A translation that has fallen behind the prose it was made from is
        # still worth deploying -- most of it is still right -- so this reports
        # rather than refuses, and prints what to paste once it has caught up.
        prose_digest = guidebook_prose_digest()
        stamped = re.search(r'TRANSLATED-FROM: ([0-9a-f]{16})', guidebook)
        if not stamped:
            print(f'  NOTE: {GUIDEBOOK_JA} carries no TRANSLATED-FROM stamp.')
        elif stamped.group(1) != prose_digest:
            print(f'  NOTE: {GUIDEBOOK_JA} was translated from an older '
                  f'{GUIDEBOOK_EN}; deploying it anyway.\n'
                  f'        Re-stamp it with TRANSLATED-FROM: {prose_digest} '
                  f'once the translation has caught up.')
        # The deployed screenshots are WebP; the videos keep both codec container
        # and name, so only the images need redirecting.
        guidebook, rewritten = re.subn(r'(src="assets/[^"]+)\.jpg"', r'\1.webp"', guidebook)
        if rewritten != len(doc_images):
            sys.exit(f'Error: the guidebook names {rewritten} images, '
                     f'but build/doc-assets/ holds {len(doc_images)}.')
        with open(os.path.join(pages_dir, 'Guidebook.ja.html'), 'w',
                  encoding='utf-8', newline='') as f:
            f.write(guidebook)
        # Precache the guidebook and its images, so it reads offline. Not the
        # videos: 11.5 MB against 2.5 MB, already preload="none", and the worker
        # passes media straight through.
        doc_to_cache = ['./Guidebook.ja.html'] + [f'./assets/{name}' for name in doc_images]

    # The service worker serves the page from its cache, so a deployment whose
    # sw.js is byte-identical to the last one would go unnoticed: the browser
    # sees no new worker, never reinstalls, and keeps answering from the old
    # cache. Stamp the cache name with the digest of everything the worker
    # precaches, so a change to any of it changes the worker, which reinstalls
    # and (see its activate handler) drops every cache that is not the current
    # one. Taking the digest of the page alone would miss a changed guidebook.
    digest = hashlib.sha256()
    for relative in ['./index.html'] + doc_to_cache:
        with open(os.path.join(pages_dir, relative[2:]), 'rb') as f:
            digest.update(f.read())
    page_digest = digest.hexdigest()[:12]
    with open(os.path.join('src', 'sw.js'), encoding='utf-8') as f:
        worker = f.read()
    stamp = "const CACHE_NAME = 'podium-v2.3.0';"
    if worker.count(stamp) != 1:
        sys.exit(f'Error: cache name not found exactly once in src/sw.js: {stamp!r}')
    worker = worker.replace(stamp, f"const CACHE_NAME = 'podium-v2.3.0-{page_digest}';")
    doc_stamp = 'const docToCache = [];'
    if worker.count(doc_stamp) != 1:
        sys.exit(f'Error: precache list not found exactly once in src/sw.js: {doc_stamp!r}')
    if doc_to_cache:
        listed = ''.join(f"\n  '{url}'," for url in doc_to_cache)
        worker = worker.replace(doc_stamp, f'const docToCache = [{listed}\n];')
    with open(os.path.join(pages_dir, 'sw.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(worker)
    # The manifest names the icons as siblings, so that is where they must go.
    missing_icons = []
    for size in (192, 512):
        icon = os.path.join('build', 'icons', f'icon{size}.png')
        if os.path.exists(icon):
            shutil.copyfile(icon, os.path.join(pages_dir, f'icon{size}.png'))
        else:
            missing_icons.append(f'icon{size}.png')
    if missing_icons:
        print(f'  NOTE: {", ".join(missing_icons)} missing; run build.py --podium to generate them.')
    if args.verbose: print(f'-- {pages_dir} (re)built.')

if(args.cert):
    if shutil.which('openssl') == None:
         sys.exit("Fatal error: creating certificate requires openssl executable in your path.") ;
    import subprocess, re, socket
    # Build the SAN list entirely at runtime, so nothing host-specific is committed:
    #   - localhost / 127.0.0.1 (always)
    #   - this machine's short hostname and its <hostname>.local mDNS name
    #     (an iPad on the same network can resolve .local, and it's stable across DHCP)
    #   - every current LAN IPv4 address
    #   - anything passed via --cert-host (comma-separated IPs and/or names)
    dns_names = {"localhost"}
    ip_addrs  = {"127.0.0.1"}
    host = socket.gethostname().split('.')[0]
    if host: dns_names |= {host, host + ".local"}
    try:
        out = subprocess.run(['ip', '-4', '-o', 'addr', 'show'], capture_output=True, text=True).stdout
        ip_addrs |= set(re.findall(r'inet (\d+\.\d+\.\d+\.\d+)', out))
    except: pass
    for entry in filter(None, (h.strip() for h in args.cert_host.split(','))):
        (ip_addrs if re.fullmatch(r'\d+\.\d+\.\d+\.\d+', entry) else dns_names).add(entry)
    san = ",".join([f"DNS:{n}" for n in sorted(dns_names)] + [f"IP:{ip}" for ip in sorted(ip_addrs)])
    print(f"  Certificate SAN: {san}")

    # Persistent local development CA. Install devCA.pem on each test device ONCE
    # (iPad: get the file onto it, then Settings > General > VPN & Device Management
    # to install the profile, and Settings > General > About > Certificate Trust
    # Settings to enable full trust). The leaf below is signed by it, so you can
    # re-run --cert any time (new IP, new --cert-host) WITHOUT re-touching the device.
    if not (os.path.exists('devCA.pem') and os.path.exists('devCA-key.pem')):
        print("  Creating local dev CA -> devCA.pem  (install this on your test devices)")
        os.system('openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 '
                  '-keyout devCA-key.pem -out devCA.pem -subj "/CN=Podium Dev CA" '
                  '-addext "basicConstraints=critical,CA:true" '
                  '-addext "keyUsage=critical,keyCertSign,cRLSign"') ;

    # Leaf cert, signed by the CA. iOS Safari rejects TLS server certs valid for
    # more than 398 days, so keep it short.
    with open('cert.ext', 'w') as f:
        f.write(f"subjectAltName={san}\n"
                "basicConstraints=critical,CA:false\n"
                "keyUsage=critical,digitalSignature,keyEncipherment\n"
                "extendedKeyUsage=serverAuth\n")
    os.system('openssl req -newkey rsa:2048 -nodes -keyout key.pem -out cert.csr '
              '-subj "/CN=Podium Dev Server"') ;
    os.system('openssl x509 -req -in cert.csr -CA devCA.pem -CAkey devCA-key.pem '
              '-CAcreateserial -days 397 -sha256 -out cert.pem -extfile cert.ext') ;
    for tmp in ('cert.csr', 'cert.ext'):
        if os.path.exists(tmp): os.remove(tmp)
    print("  Wrote cert.pem + key.pem (leaf signed by devCA.pem).")

if args.guide:
    #####################################################
    #                                                   #
    #  (Re)build Guidebook keyword index                #
    #                                                   #
    #####################################################

    import re as _re

    GUIDEBOOK_PATH = 'doc/Guidebook.html'
    INDEX_BEGIN = '<!-- BEGIN KEYWORD INDEX -->'
    INDEX_END = '<!-- END KEYWORD INDEX -->'

    # Curated keywords: body-text terms not found in headings.
    # Maps keyword -> list of anchor IDs.
    CURATED_KEYWORDS = {
        "Annotations": ["chapter-6", "chapter-1"],
        "Aspect ratio": ["chapter-6-edit"],
        "Bookmarks": ["chapter-5-bookmarks"],
        "Bravura font": ["chapter-6-symbols"],
        "Browser extension": ["chapter-2"],
        "Browser tab naming": ["chapter-3"],
        "Cell auto-deactivation": ["chapter-3-auto-deactivation"],
        "Cell locking": ["chapter-3-cell-locking", "chapter-6"],
        "Cloud storage": ["chapter-4-open-save"],
        "Color chooser": ["chapter-6-pen-pencil", "chapter-7-add"],
        "Conducting patterns": ["chapter-9-metronome"],
        "Cross-instance sharing": ["chapter-7-export-import"],
        "CSS pixels": ["chapter-5-book", "chapter-5-horizontal"],
        "Dark theme": ["chapter-8-theme"],
        "Delcamp": ["chapter-2"],
        "Display quality": ["chapter-4-details"],
        "Drag and drop": ["chapter-4-open-save"],
        "Dropbox": ["chapter-4-open-save"],
        "E-reader": ["overture"],
        "Equal temperament": ["chapter-9-piano"],
        "Expand mode": ["chapter-4-details"],
        "Export": ["chapter-7-export-import"],
        "File System Access API": ["chapter-4-open-save"],
        "Firefox settings": ["firefox-settings"],
        "Fling gesture": ["chapter-3", "chapter-5-page-turning"],
        "Foot pedal": ["chapter-2-foot-pedal", "chapter-7-numbers"],
        "Full screen": ["chapter-8-screen", "chapter-3"],
        "Gestures": ["chapter-3"],
        "Google Drive": ["chapter-4-open-save"],
        "Grip": ["chapter-3"],
        "Group selection": ["chapter-6-edit"],
        "Images, importing": ["chapter-6-cut-copy-paste"],
        "IMSLP": ["chapter-2"],
        "Import": ["chapter-7-export-import"],
        "Inner ring": ["chapter-3"],
        "Installation": ["chapter-2"],
        "Keyboard shortcuts": ["chapter-7-numbers"],
        "Light theme": ["chapter-8-theme"],
        "Line drawing": ["chapter-6-pen-pencil"],
        "Live mode": ["chapter-9-review"],
        "Local storage": ["chapter-8-storage"],
        "Long press": ["chapter-3"],
        "Magnify": ["chapter-7-magnify"],
        "Manuscript paper": ["chapter-7-flatten", "chapter-6-rastrum"],
        "Merge": ["chapter-7-merge"],
        "Metadata": ["chapter-4-details"],
        "Microphone": ["chapter-9-review", "chapter-9-piano"],
        "Mouse controls": ["chapter-3"],
        "CPDL": ["chapter-2"],
        "Navigation": ["chapter-1", "chapter-5-book"],
        "Offline use": ["chapter-2"],
        "OneDrive": ["chapter-4-open-save"],
        "Opacity": ["chapter-6-pen-pencil", "chapter-7-add"],
        "Open source": ["overture"],
        "Outer ring": ["chapter-3"],
        "Page numbers": ["chapter-7-numbers", "chapter-5-book"],
        "Page ordering": ["chapter-5-table"],
        "Page range": ["chapter-4-print"],
        "Page sizing": ["chapter-4-details"],
        "Page Turning": ["chapter-5-page-turning"],
        "Pager": ["chapter-5-page-turning"],
        "Password-protected PDF": ["chapter-4-open-save"],
        "Paste buffer": ["chapter-7-export-import"],
        "PDF files": ["chapter-4-open-save", "overture"],
        "Pinch-zoom": ["chapter-3", "chapter-5-book"],
        "Pitch detector": ["chapter-9-piano"],
        "Playback": ["chapter-9-review"],
        "Practice scores": ["chapter-7-export-import"],
        "Precision sliders": ["chapter-6-edit"],
        "Print": ["chapter-4-print"],
        "Privacy": ["chapter-7-export-import", "chapter-8-storage"],
        "Progressive Web App (PWA)": ["chapter-2"],
        "Recent files": ["chapter-4-open-save", "chapter-8-storage"],
        "Recording": ["chapter-9-review"],
        "Reorder pages": ["chapter-5-table"],
        "Resize": ["chapter-3"],
        "Revert to saved": ["chapter-4-open-save"],
        "Roman numerals": ["chapter-7-numbers"],
        "Rotating rings": ["chapter-3"],
        "Salamander Grand Piano": ["chapter-9-piano"],
        "Scrubber": ["chapter-9-review"],
        "Shared buffer": ["chapter-7-export-import"],
        "Sliders": ["chapter-3"],
        "SMuFL": ["chapter-6-symbols"],
        "Snap scrolling": ["chapter-5-horizontal", "chapter-5-vertical"],
        "Spectrogram": ["chapter-9-review"],
        "Split times": ["chapter-9-stopwatch"],
        "Staff space": ["chapter-6-rastrum", "chapter-6-symbols"],
        "Staves": ["chapter-6-rastrum"],
        "Sustain mode": ["chapter-9-piano"],
        "Symbol library": ["chapter-6-symbols"],
        "Tablature": ["chapter-6-rastrum"],
        "Temperament": ["chapter-9-piano"],
        "Timbre": ["chapter-9-piano"],
        "Transform handles": ["chapter-6-edit"],
        "Tuner": ["chapter-9-piano"],
        "Undo history": ["chapter-6-undo", "chapter-7-undo"],
        "Waveform": ["chapter-9-review"],
        "YIN pitch detection": ["chapter-9-piano"],
        "Zoom": ["chapter-7-magnify", "chapter-3"],
    }

    with open(GUIDEBOOK_PATH, 'r', encoding='utf-8') as f:
        guide_html = f.read()

    # Extract headings in order of appearance -> (anchor_id, section_label, heading_text)
    headings = []
    current_chapter_label = 'Ch.1'
    current_section_label = 'Ch.1'

    pattern = (
        r'<section\s+id="([^"]+)"[^>]*>\s*<h2>(.+?)</h2>|'
        r'<h3\s+id="([^"]+)">(\d+\.\d+)\s+(?:.+?:\s+)?(.+?)</h3>|'
        r'<h4\s+id="([^"]+)">(.+?)</h4>'
    )

    for m in _re.finditer(pattern, guide_html):
        if m.group(1) is not None:
            # h2 / section
            aid, text = m.group(1), m.group(2)
            # Remove HTML tags to parse chapter name correctly
            clean_text = _re.sub(r'<[^>]+>', '', text).strip()
            if aid == 'overture':
                label = 'Overture'
            elif aid == 'chapter-10':
                label = 'Ch.10'
            else:
                ch = _re.match(r'Chapter (\d+)', clean_text)
                label = f'Ch.{ch.group(1)}' if ch else 'Ch.1'
            current_chapter_label = label
            current_section_label = label
            headings.append((aid, label, clean_text))
        elif m.group(3) is not None:
            # h3
            aid, label, text = m.group(3), m.group(4), m.group(5)
            # Keep raw text (with HTML/SVG) to preserve icons
            current_section_label = label
            headings.append((aid, label, text))
        elif m.group(6) is not None:
            # h4
            aid, text = m.group(6), m.group(7)
            headings.append((aid, current_section_label, text))

    section_labels = {h[0]: h[1] for h in headings}

    # Auto-extract index terms from headings
    heading_terms = {}
    for aid, label, text in headings:
        if text in ('Overture', 'Quick Start', 'About the Author'):
            continue
        if text.startswith('Chapter '):
            parts = text.split(': ', 1)
            if len(parts) == 2:
                heading_terms.setdefault(parts[1], set()).add(aid)
            continue
        if text.startswith('Recommended '):
            continue
        for sub in [t.strip() for t in text.split(',')]:
            if len(sub) >= 2:
                heading_terms.setdefault(sub, set()).add(aid)

    def strip_html(t):
        return _re.sub(r'<[^>]+>', '', t).strip()

    # Merge heading terms with curated keywords, normalizing by plain text lowercase
    entries = {}
    for term, anchors in heading_terms.items():
        norm_key = strip_html(term).lower()
        if norm_key in entries:
            entries[norm_key][1].update(anchors)
            if '<' in term:
                entries[norm_key][0] = term
        else:
            entries[norm_key] = [term, set(anchors)]

    for term, anchors in CURATED_KEYWORDS.items():
        norm_key = strip_html(term).lower()
        if norm_key in entries:
            entries[norm_key][1].update(anchors)
            if '<' in term:
                entries[norm_key][0] = term
        else:
            entries[norm_key] = [term, set(anchors)]

    # Reconstruct the final entries dictionary
    final_entries = {item[0]: item[1] for item in entries.values()}

    # Validate anchor references
    all_ids = set(_re.findall(r'id="([^"]+)"', guide_html))
    for term, anchors in final_entries.items():
        for anchor in anchors:
            if anchor not in all_ids:
                print(f'  WARNING: index keyword "{term}" references missing anchor #{anchor}', file=sys.stderr)

    # Generate index HTML
    sorted_terms = sorted(final_entries.keys(), key=lambda t: strip_html(t).lower())
    groups = {}
    for term in sorted_terms:
        first_letter = strip_html(term)[0].upper()
        groups.setdefault(first_letter, []).append(term)

    lines = [INDEX_BEGIN, '<nav id="keyword-index">', '    <style>',
        '        #keyword-index h2 { border-bottom: none; margin-top: 0; }',
        '        .idx-letter {',
        '            font-size: 1.3em; font-weight: bold; color: #2c3e50;',
        '            margin: 1.2em 0 0.3em; border-bottom: 1px solid #dee2e6;',
        '            padding-bottom: 0.2em;',
        '        }',
        '        .idx-letter:first-of-type { margin-top: 0.5em; }',
        '        #keyword-index dl { margin: 0; columns: 2; column-gap: 2em; }',
        '        #keyword-index dt { display: inline; font-weight: 500; color: #333; }',
        '        #keyword-index dd { display: inline; margin: 0; }',
        '        #keyword-index dd::after { content: ""; display: block; }',
        '        #keyword-index dd a { font-size: 0.9em; }',
        '        @media print { #keyword-index { page-break-before: always; } }',
        '        @media (max-width: 600px) { #keyword-index dl { columns: 1; } }',
        '    </style>', '    <h2>Index</h2>']

    for letter in sorted(groups.keys()):
        lines.append(f'    <div class="idx-letter">{letter}</div>')
        lines.append('    <dl>')
        for term in groups[letter]:
            sorted_anchors = sorted(final_entries[term], key=lambda a: section_labels.get(a, a))
            refs = ', '.join(f'<a href="#{a}">{section_labels.get(a, a)}</a>' for a in sorted_anchors)
            lines.append(f'        <dt>{term}</dt><dd> &mdash; {refs}</dd>')
        lines.append('    </dl>')

    lines.extend(['    <a href="#toc" class="back-to-toc">&uarr; Back to Table of Contents</a>',
                  '</nav>', INDEX_END])
    index_html = '\n'.join(lines)

    # Add Index entry to TOC if not present
    if '#keyword-index' not in guide_html[:guide_html.index('</nav>')]:
        toc_last = '<li><a href="#chapter-10">Chapter 10: About the Author</a></li>\n    </ul>\n</nav>'
        toc_new = ('<li><a href="#chapter-10">Chapter 10: About the Author</a></li>\n'
                   '        <li><a href="#keyword-index">Index</a></li>\n    </ul>\n</nav>')
        guide_html = guide_html.replace(toc_last, toc_new)

    # Insert or replace index (idempotent)
    if INDEX_BEGIN in guide_html:
        before = guide_html[:guide_html.index(INDEX_BEGIN)]
        after = guide_html[guide_html.index(INDEX_END) + len(INDEX_END):]
        guide_html = before + index_html + after
    else:
        guide_html = guide_html.replace('</body>', '\n' + index_html + '\n\n</body>')

    with open(GUIDEBOOK_PATH, 'w', encoding='utf-8') as f:
        f.write(guide_html)

    # The same index goes into the translation. It indexes English terms against
    # ids, and every id is shared, so one block serves both files -- and a term
    # looked up in the index is a term the app itself shows in English anyway.
    # Only the replacement branch applies here: a translation without the
    # markers has not been prepared for an index, and guessing where to put one
    # (its own TOC entry is translated) would be worse than saying so.
    if os.path.exists(GUIDEBOOK_JA):
        with open(GUIDEBOOK_JA, 'r', encoding='utf-8') as f:
            translated = f.read()
        if INDEX_BEGIN in translated and INDEX_END in translated:
            before = translated[:translated.index(INDEX_BEGIN)]
            after = translated[translated.index(INDEX_END) + len(INDEX_END):]
            with open(GUIDEBOOK_JA, 'w', encoding='utf-8') as f:
                f.write(before + index_html + after)
        else:
            print(f'  NOTE: {GUIDEBOOK_JA} has no keyword index markers; '
                  'its index was left alone.')

    if args.verbose: print(f'-- Guidebook index (re)built: {len(entries)} entries')

