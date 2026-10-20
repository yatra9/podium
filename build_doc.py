#!/usr/bin/env python3
"""Recompress the guidebook's media for deployment alongside Podium.

doc/assets/ is the pristine set: 62 screenshots as JPEG at capture resolution
(up to 2856px wide) and 16 silent screen recordings as VP9. Together they are
42 MB, which is why the guidebook has always been read from the web instead of
shipped with the app.

  pristine doc/assets/*.jpg   (13.5 MB)
    -> scale to 1280px wide, WebP q80        => 2.5 MB
  pristine doc/assets/*.webm  (28.7 MB)
    -> scale to 1280px wide, AV1 crf46       => 11.5 MB

The images are what the static-host deployment precaches, so the guidebook
reads offline; the videos are not, and are fetched from the network when
played (src/sw.js leaves media alone entirely). Recompressing them still pays
for itself in what a tap costs: the heaviest clip goes from 6.3 MB to 2.8 MB.

AV1 rather than H.265: at matched quality (SSIM 0.992 on the heaviest clip) AV1
is half the size, and Chrome decodes AV1 in software everywhere while its H.265
support exists only where the platform has a hardware decoder.

Nothing here is tracked: build.py --doc derives build/doc-assets/ from doc/,
and --pages copies the result into the deployment. Encoding all 78 files takes
minutes, so each output records the digest of its input and of the recipe that
produced it, and is rebuilt only when one of those changes.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

SRC_DIR = 'doc/assets'
OUT_DIR = 'build/doc-assets'
MANIFEST = '.recipes.json'   # inside OUT_DIR, so a cleaned build rebuilds all

IMAGE_WIDTH = 1280
IMAGE_QUALITY = 80
VIDEO_WIDTH = 1280
VIDEO_CRF = 46
VIDEO_PRESET = 6    # SVT-AV1: 6 is slower than the default and worth it here
FALLBACK_RATE = '30'   # only for clips whose own declared rate is unusable


def ffmpeg():
    """Find a working ffmpeg, preferring the one mise installs.

    `mise exec -- ffmpeg` cannot be used, which is this repository's rule for
    every other tool. The mise ffmpeg is a conda-style package, and putting its
    .mise-bins directory first on PATH shadows the C runtime for every process
    started afterwards with api-ms-win-crt-*.dll stubs -- including mise itself,
    which then fails to start at all. So locate the real executable instead and
    run it directly.
    """
    candidates = []
    try:
        where = subprocess.run(['mise', 'where', 'ffmpeg'], capture_output=True,
                               text=True, timeout=30)
        if where.returncode == 0 and where.stdout.strip():
            root = where.stdout.strip()
            for parts in (('Library', 'bin'), ('bin',), ()):
                candidates.append(os.path.join(root, *parts, 'ffmpeg'))
    except (OSError, subprocess.SubprocessError):
        pass
    candidates.append('ffmpeg')

    for candidate in candidates:
        resolved = shutil.which(candidate)
        if not resolved:
            continue
        try:
            version = subprocess.run([resolved, '-version'], capture_output=True,
                                     text=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            continue
        if 'ffmpeg version' in version.stdout:
            return resolved
    return None


def ffprobe(tool):
    """The ffprobe that goes with the ffmpeg we found."""
    sibling = os.path.join(os.path.dirname(tool), 'ffprobe')
    return shutil.which(sibling) or shutil.which('ffprobe')


def repair_rate(probe, source):
    """A frame rate to impose, or None to pass the clip's own timing through.

    These are screen recordings, and five of them declare 1000/1 or 0/0 -- a
    recorder's placeholder for "the timestamps are variable, read them". Passing
    that to SVT-AV1 fails the encode outright: it refuses any rate above 240
    fps. So those are pinned to a constant 30, which costs duplicated frames
    wherever the recorder captured nothing.

    Every other clip keeps its own timing. Imposing a constant rate on them
    costs 12% to 50% in size for no visible gain, because the duplicate frames
    the filter inserts are not free at this quality.
    """
    if not probe:
        return FALLBACK_RATE
    declared = subprocess.run(
        [probe, '-v', 'error', '-select_streams', 'v:0', '-show_entries',
         'stream=avg_frame_rate', '-of', 'csv=p=0', source],
        capture_output=True, text=True)
    try:
        num, _, den = declared.stdout.strip().partition('/')
        rate = int(num) / int(den)
    except (ValueError, ZeroDivisionError):
        rate = 0
    return None if 0 < rate <= 60 else FALLBACK_RATE


def recipe(kind, rate=None):
    """What the output depends on besides its input, so a settings change rebuilds."""
    if kind == 'image':
        return f'webp w{IMAGE_WIDTH} q{IMAGE_QUALITY}'
    return (f'av1 w{VIDEO_WIDTH} crf{VIDEO_CRF} preset{VIDEO_PRESET} '
            f'fps{rate or "source"}')


def encode_args(kind, source, target, rate=None):
    scale = IMAGE_WIDTH if kind == 'image' else VIDEO_WIDTH
    args = ['-nostdin', '-v', 'error', '-y', '-i', source]
    filters = f"scale='min({scale},iw)':-2:flags=lanczos"
    if kind == 'image':
        args += ['-vf', filters, '-quality', str(IMAGE_QUALITY)]
    else:
        args += ['-an',   # every clip is silent already; make that explicit
                 '-vf', f'fps={rate},{filters}' if rate else filters,
                 '-c:v', 'libsvtav1', '-crf', str(VIDEO_CRF),
                 '-preset', str(VIDEO_PRESET), '-pix_fmt', 'yuv420p']
    return args + [target]


def planned(src_dir=SRC_DIR):
    """Every pristine asset, as (kind, source name, output name)."""
    plan = []
    for name in sorted(os.listdir(src_dir)):
        stem, ext = os.path.splitext(name)
        if ext == '.jpg':
            plan.append(('image', name, stem + '.webp'))
        elif ext == '.webm':
            # AV1 lives in WebM too, so the guidebook's own references still fit.
            plan.append(('video', name, name))
        else:
            print(f'  NOTE: {src_dir}/{name} is neither .jpg nor .webm; not deployed.')
    return plan


def build_doc_assets(src_dir=SRC_DIR, out_dir=OUT_DIR, verbose=False):
    """Derive out_dir from src_dir. Returns the output names, or None if it cannot."""
    tool = ffmpeg()
    if not tool:
        print('  NOTE: ffmpeg not found; the guidebook will not be deployed.')
        return None

    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, MANIFEST)
    try:
        with open(manifest_path, encoding='utf-8') as f:
            done = json.load(f)
    except (OSError, ValueError):
        done = {}

    probe = ffprobe(tool)
    plan = planned(src_dir)
    outputs = [target for _, _, target in plan]
    built = skipped = 0
    for kind, name, target in plan:
        source = os.path.join(src_dir, name)
        rate = repair_rate(probe, source) if kind == 'video' else None
        with open(source, 'rb') as f:
            stamp = {'source': hashlib.sha256(f.read()).hexdigest()[:16],
                     'recipe': recipe(kind, rate)}
        target_path = os.path.join(out_dir, target)
        cached = done.get(target) or {}
        kept = cached.get('kept')
        if all(cached.get(k) == v for k, v in stamp.items()) and os.path.exists(target_path):
            skipped += 1
        else:
            if verbose: print(f'  encoding {name} -> {target}')
            result = subprocess.run([tool] + encode_args(kind, source, target_path, rate),
                                    capture_output=True, text=True)
            if result.returncode != 0 or not os.path.exists(target_path):
                # Leave the manifest entry unset, so the next run tries again
                # rather than deploying a file that was never written.
                done.pop(target, None)
                with open(manifest_path, 'w', encoding='utf-8', newline='\n') as f:
                    json.dump(done, f, indent=1, sort_keys=True)
                print(f'  NOTE: ffmpeg failed on {name}: '
                      f'{result.stderr.strip().splitlines()[-1:] or ""}')
                return None
            kept = 'encoded'
            built += 1
        # A clip whose timing had to be repaired can come out larger than it
        # went in: the duplicate frames are new content to encode, and two of
        # these recordings were already leaner than AV1 manages at this quality.
        # The pristine file is then both smaller and better, and the extension
        # is the same either way, so deploy that instead. Checked even when the
        # output was carried over, so a change of settings cannot leave an
        # inflated file behind.
        if kept != 'pristine' and os.path.getsize(target_path) >= os.path.getsize(source):
            shutil.copyfile(source, target_path)
            kept = 'pristine'
            if verbose: print(f'  kept pristine {name}: the re-encode was larger')
        done[target] = {**stamp, 'kept': kept}

    # A pristine asset that has been renamed or removed would otherwise be
    # deployed forever from a previous run.
    for stale in set(os.listdir(out_dir)) - set(outputs) - {MANIFEST}:
        os.remove(os.path.join(out_dir, stale))
        done.pop(stale, None)

    with open(manifest_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(done, f, indent=1, sort_keys=True)

    if verbose:
        total = sum(os.path.getsize(os.path.join(out_dir, name)) for name in outputs)
        pristine = sum(os.path.getsize(os.path.join(src_dir, name)) for _, name, _ in plan)
        print(f'  {built} encoded, {skipped} unchanged: '
              f'{pristine / 1048576:.1f} MB -> {total / 1048576:.1f} MB')
    return outputs


if __name__ == '__main__':
    sys.exit(0 if build_doc_assets(verbose=True) else 1)
