// End to end, through the real UI: launch the app from source with
// Chromium's fake camera and a spoken sentence as the mic, record a take,
// check the file, play it back, and (when a model is provided) check the
// transcript. `npm run test:e2e`; CI runs it under xvfb on Linux and
// directly on Windows and macOS.
//
//   FR_E2E_MODEL=/path/to/ggml-base.en-q5_1.bin  also test transcription
//
// Uses a throwaway library and data folder - never the user's own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const repo = path.join(import.meta.dirname, "..", "..");
const sentence = "Tell me about yourself. I have five years of experience building software.";

function has(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A real spoken sentence when espeak-ng is installed (so transcription has
// something to hear), otherwise a tone gated like speech - 1.2s on, 0.8s
// off - which still exercises the pause and talking-time measurements.
function writeMicInput(file) {
  if (has("espeak-ng")) {
    const raw = `${file}.raw.wav`;
    execFileSync("espeak-ng", ["-s", "150", "-w", raw, sentence]);
    // Silence either side, so the take starts and ends quiet.
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-af", "adelay=1000,apad=pad_dur=2", "-ar", "48000", "-ac", "1", file]);
    return "speech";
  }
  const rate = 48000;
  const samples = rate * 20;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const on = t >= 1 && (t - 1) % 2 < 1.2;
    const value = on ? 0.25 * (2 * ((t * 180) % 1) - 1) : 0;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return "tone";
}

// Which codecs an MP4 holds, from the sample-entry names in its boxes -
// needs no ffprobe, so the check runs on every OS's CI runner as-is.
function mp4Codecs(file) {
  const bytes = fs.readFileSync(file);
  return {
    video: bytes.includes("avc1") ? "h264" : bytes.includes("vp09") ? "vp9" : null,
    audio: bytes.includes("mp4a") ? "aac" : bytes.includes("Opus") ? "opus" : null,
  };
}

function readLibrary(libraryDir) {
  return JSON.parse(fs.readFileSync(path.join(libraryDir, "library.json"), "utf8"));
}

async function waitFor(check, { timeout = 30_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, interval));
  }
}

test("record, save, play back and transcribe a take", { timeout: 180_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fr-e2e-"));
  const videos = path.join(tmp, "Videos");
  const libraryDir = path.join(videos, "flight-recorder");
  const data = path.join(tmp, "data");
  // A fresh Chromium profile every run, as on a first install - a cached
  // file from an earlier run once hid a network request this test exists
  // to catch.
  const profile = path.join(tmp, "profile");
  const netlog = path.join(tmp, "netlog.json");
  const mic = path.join(tmp, "mic.wav");
  const micKind = writeMicInput(mic);
  const model = process.env.FR_E2E_MODEL;
  const transcribe = Boolean(model) && micKind === "speech";

  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  if (transcribe) fs.copyFileSync(model, path.join(data, "ggml-base.en-q5_1.bin"));
  // Questions left out, so the app seeds its first one as on a real first
  // launch. Speech pace on only when there's a model to use.
  fs.writeFileSync(path.join(libraryDir, "library.json"), JSON.stringify({ wpmEnabled: transcribe }));

  const env = {
    ...process.env,
    FLIGHT_RECORDER_VIDEOS_DIR: videos,
    FLIGHT_RECORDER_DATA_DIR: data,
    FLIGHT_RECORDER_USER_DATA_DIR: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Either would make the app relaunch itself, and Playwright would lose it.
  delete env.MANGOHUD;
  const args = [
    repo,
    ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${mic}`,
    `--log-net-log=${netlog}`,
  ];

  const app = await electron.launch({ args, env, cwd: repo });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("load");
    await page.locator("#question-list .question-item").first().click();
    await page.locator("#camera-toggle-btn").click();
    await page.waitForFunction(() => document.getElementById("preview").videoWidth > 0, null, { timeout: 20_000 });
    await page.waitForTimeout(1000);

    const supported = await page.evaluate(() => ({
      aac: MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.640028,mp4a.40.2"),
      opus: MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.640028,opus"),
    }));


    await page.locator("#record-btn").click();
    await page.waitForTimeout(6000);
    await page.locator("#record-btn").click();

    const attempt = await waitFor(() => {
      const attempts = readLibrary(libraryDir).attempts ?? [];
      return attempts.length > 0 && !attempts[0].transcribing ? attempts[0] : null;
    }, { timeout: 120_000 });

    // The file: one MP4 holding H.264 video and audio - AAC where the
    // platform can encode it, Opus on Linux, which can't.
    const file = path.join(libraryDir, ...attempt.videoRelativePath.split("/"));
    assert.ok(fs.statSync(file).size > 10_000, "recording is non-empty");
    assert.match(attempt.videoRelativePath, /\.mp4$/);
    assert.deepEqual(mp4Codecs(file), { video: "h264", audio: supported.aac ? "aac" : "opus" });
    // Linux Chromium has no AAC encoder; everywhere else should use AAC.
    if (process.platform !== "linux") assert.ok(supported.aac, "H.264 + AAC is supported");

    // The mic-level measurements ran on the take - provided the fake mic
    // delivered any sound at all. On GitHub's macOS runners it records
    // silence (no audio device), so the saved file's own level decides
    // whether there was anything to measure: sound in the file but no
    // talking time measured is an app bug; a silent file is the machine.
    const recordedLevel = await page.evaluate(async (videoPath) => {
      const { readFile } = await import("./js/platform.js");
      const bytes = await readFile(videoPath);
      const ctx = new OfflineAudioContext(1, 1, 16000);
      const audio = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const samples = audio.getChannelData(0);
      let sum = 0;
      for (const s of samples) sum += s * s;
      return Math.sqrt(sum / samples.length);
    }, file);
    if (recordedLevel > 0.001) {
      assert.ok(attempt.speakingRatio > 0.2, `talking time measured (${attempt.speakingRatio}, recording RMS ${recordedLevel})`);
    } else {
      console.warn(`The fake microphone recorded silence on this machine (RMS ${recordedLevel}); skipping the talking-time check.`);
    }

    if (transcribe) {
      assert.equal(attempt.transcriptError, null);
      assert.match(attempt.transcript, /experience/i);
      assert.ok(attempt.wpm > 0);
    }

    // Review streams the file from disk and can seek.
    await page.locator(".attempt-item").first().click();
    await page.waitForFunction(() => document.getElementById("preview").readyState >= 1, null, { timeout: 10_000 });
    const seek = await page.evaluate(async () => {
      const video = document.getElementById("preview");
      video.muted = true;
      video.currentTime = 2;
      await new Promise((r) => video.addEventListener("seeked", r, { once: true }));
      return { src: video.currentSrc.slice(0, 16), time: video.currentTime, error: video.error?.code ?? null };
    });
    assert.equal(seek.src, "media://library/");
    assert.equal(seek.error, null);
    assert.ok(seek.time >= 1.9);
  } finally {
    await app.close();
  }

  // The app promises two network uses: the model download (opt-in) and
  // update checks (which don't run from source). A take touches neither.
  const requests = [...fs.readFileSync(netlog, "utf8").matchAll(/"url":"((?:https?|wss?):\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(requests, [], "no network requests");
  fs.rmSync(tmp, { recursive: true, force: true });
});
