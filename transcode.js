// Video transcoding — shrinks the oversized masters we serve to the reel feeds.
//
// Why: source clips are 1080p ~3.3 Mbps H.264 (a typical 18s clip is 7.3 MB).
// That is a full-HD master being streamed to a phone-sized vertical feed, and
// it is the reason FluidPlayer throws its timeout on slow connections. Re-encode
// to 480p keeps the feed watchable at roughly 1/7th the bytes.
//
// Originals are NEVER overwritten. Compressed files are written to a separate
// key prefix and only the DB row is repointed, so a bad encode can be rolled
// back by restoring video_url. Transcoding is lossy and one-way; without the
// masters there is no way back.
const { execFile } = require("child_process");
const { promises: fs } = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ffmpegPath = require("ffmpeg-static");

// ffmpeg-static ships the binary without a reliable exec bit when the install
// is interrupted or the package is restored from a cache that drops modes
// (which some CI/deploy images do) — the symptom is EACCES on first spawn.
// Setting it once at startup is cheap and turns a hard deploy failure into a
// non-event. Best-effort: on a read-only filesystem the chmod fails and we let
// the spawn error surface normally.
// Checked first, because chmod'ing then spawning the same file immediately can
// race and fail with ETXTBSY — skipping the write when the bit is already there
// avoids that entirely on every run after the first.
try {
  const fsSync = require("fs");
  fsSync.accessSync(ffmpegPath, fsSync.constants.X_OK);
} catch (e) {
  try {
    require("fs").chmodSync(ffmpegPath, 0o755);
  } catch (e2) {
    console.warn("transcode: could not chmod ffmpeg binary —", e2.message);
  }
}

// Compressed objects live under this prefix. Presence of it in a video_url is
// also how the batch decides a row is already done, so it must stay stable.
const PREFIX = "c480/";

// Option A settings (chosen 2026-07-26 over a 455 KB / 200 kbps variant):
// 480p CRF 30 lands ~1.1 MB for an 18s clip, a ~7x reduction, and holds up
// under the heavy motion this content is full of. The 200 kbps variant was 16x
// smaller but visibly smeared once anything moved.
const HEIGHT = 480;
const CRF = 30;
const PRESET = "veryfast";
const AUDIO_BITRATE = "64k";

// Below this, re-encoding buys little and risks making a file bigger.
const MIN_BYTES = 1_500_000;

const TIMEOUT_MS = 5 * 60 * 1000;

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${path.basename(bin)}: ${(stderr || err.message).slice(-400)}`));
      resolve(stdout);
    });
  });
}

// Encode a buffer to 480p H.264. Returns the compressed buffer, or null when
// the result is not actually smaller (rare, but possible on already-tiny or
// oddly-encoded inputs — keeping the original is the right call there).
async function encodeBuffer(buf) {
  const tmp = os.tmpdir();
  const tag = crypto.randomBytes(8).toString("hex");
  const inPath = path.join(tmp, `tc_${tag}_in.mp4`);
  const outPath = path.join(tmp, `tc_${tag}_out.mp4`);

  try {
    await fs.writeFile(inPath, buf);
    await run(ffmpegPath, [
      "-y", "-v", "error",
      "-i", inPath,
      // -2 keeps width even (H.264 requires it) while preserving aspect ratio,
      // so this works for both landscape and vertical sources.
      "-vf", `scale=-2:${HEIGHT}`,
      "-c:v", "libx264",
      "-preset", PRESET,
      "-crf", String(CRF),
      "-profile:v", "main",
      // faststart moves the moov atom to the front so playback can begin before
      // the whole file arrives. Without it a progressive download still has to
      // finish before the first frame — which would undo the point of this.
      "-movflags", "+faststart",
      "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "1",
      outPath,
    ], TIMEOUT_MS);

    const out = await fs.readFile(outPath);
    if (!out.length || out.length >= buf.length) return null;
    return out;
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

function isTranscoded(url) {
  return typeof url === "string" && url.includes(`/${PREFIX}`);
}

function compressedKeyFor(url) {
  const clean = url.split("?")[0];
  const base = decodeURIComponent(clean.substring(clean.lastIndexOf("/") + 1));
  return PREFIX + base;
}

module.exports = {
  PREFIX,
  HEIGHT,
  CRF,
  MIN_BYTES,
  encodeBuffer,
  isTranscoded,
  compressedKeyFor,
};
