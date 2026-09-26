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
import fs from "node:fs";
import path from "node:path";

import { has, speak, writeWav, launchApp, readLibrary, waitFor } from "./helpers.js";

const sentence = "Tell me about yourself. I have five years of experience building software.";

// A real spoken sentence when espeak-ng is installed (so transcription has
// something to hear), otherwise a tone gated like speech - 1.2s on, 0.8s
// off - which still exercises the pause and talking-time measurements.
function writeMicInput(file, tmp) {
  const rate = 48000;
  if (has("espeak-ng") && has("ffmpeg")) {
    // Silence either side, so the take starts and ends quiet.
    const said = speak(sentence, tmp);
    writeWav(file, [...new Array(rate).fill(0), ...said, ...new Array(rate * 2).fill(0)], rate);
    return "speech";
  }
  const samples = Array.from({ length: rate * 20 }, (_, i) => {
    const t = i / rate;
    const on = t >= 1 && (t - 1) % 2 < 1.2;
    return on ? 0.25 * (2 * ((t * 180) % 1) - 1) : 0;
  });
  writeWav(file, samples, rate);
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

test("record, save, play back and transcribe a take", { timeout: 180_000 }, async () => {
  const micDir = fs.mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/fr-mic-`);
  const mic = path.join(micDir, "mic.wav");
  const micKind = writeMicInput(mic, micDir);
  const model = process.env.FR_E2E_MODEL;
  const transcribe = Boolean(model) && micKind === "speech";

  // Questions left out, so the app seeds its first one as on a real first
  // launch. Speech pace on only when there's a model to use.
  const { app, tmp, libraryDir, netlog } = await launchApp({
    mic,
    model: transcribe ? model : undefined,
    library: { wpmEnabled: transcribe },
  });
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
  fs.rmSync(micDir, { recursive: true, force: true });
});
