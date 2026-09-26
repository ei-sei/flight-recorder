// Are the speech measurements right? Records an answer with pauses at known
// places, at a real headset mic's levels, through the real app, and checks
// every figure against what was actually said.
//
// It exists because they weren't: WPM counted the thinking time before the
// first word (an answer spoken at 125 wpm read as 100), and the pace spread
// counted pauses as slow speech (the same answer read 50-147, 90-116 and
// 72-120 on three runs). Needs espeak-ng, ffmpeg and a model
// (FR_E2E_MODEL); skipped otherwise - CI's Linux job has all three.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { has, speak, writeWav, launchApp, readLibrary, waitFor } from "./helpers.js";

const model = process.env.FR_E2E_MODEL;
const skip = !model || !has("espeak-ng") || !has("ffmpeg") ? "needs espeak-ng, ffmpeg and FR_E2E_MODEL" : false;

const SENTENCES = [
  "Tell me about yourself. I have spent five years building software for small teams.",
  "Most recently I led the move of our main product to a new platform.",
  "The hardest part was keeping every customer running while we switched.",
  "I learned that clear communication matters as much as the code itself.",
];
const WORDS = SENTENCES.join(" ").split(/\s+/).length; // 51
// Thinking time, then the gap after each sentence: a breath (not a pause),
// a pause, and a long pause that should show as "…" in the transcript.
const LEAD_IN_S = 5;
const GAPS_S = [0.7, 2.0, 4.0];
const TAIL_S = 3;
const RATE = 48000;

// Levels measured from a real USB headset recording: speech around -45 dBFS
// and room noise around -72 dBFS before the app's +18 dB mic gain.
function buildAnswer(tmp) {
  const speechRms = 10 ** (-45 / 20);
  const noise = 10 ** (-72 / 20);
  const track = new Array(Math.round(LEAD_IN_S * RATE)).fill(0);
  const sentenceSeconds = [];
  SENTENCES.forEach((text, i) => {
    const said = speak(text, tmp);
    const rms = Math.sqrt(said.reduce((sum, s) => sum + s * s, 0) / said.length);
    for (const s of said) track.push((s * speechRms) / rms);
    sentenceSeconds.push(said.length / RATE);
    for (let n = Math.round((GAPS_S[i] ?? TAIL_S) * RATE); n > 0; n--) track.push(0);
  });
  // Seeded, so every run hears the same room.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < track.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(random() || 1e-9));
    const a = 2 * Math.PI * random();
    track[i] += noise * r * Math.cos(a);
    if (i + 1 < track.length) track[i + 1] += noise * r * Math.sin(a);
  }
  const file = path.join(tmp, "answer.wav");
  writeWav(file, track, RATE);
  // How long the answer really took, first word to last, at a steady pace.
  const spoken = sentenceSeconds.reduce((a, b) => a + b, 0) + GAPS_S.reduce((a, b) => a + b, 0);
  return { file, trueWpm: WORDS / (spoken / 60), seconds: track.length / RATE };
}

test("speech measurements match an answer with known pauses", { skip, timeout: 300_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fr-accuracy-"));
  const answer = buildAnswer(tmp);
  const { app, libraryDir } = await launchApp({
    mic: answer.file,
    model,
    netlog: false,
    library: {
      questions: [{ id: "accuracy-0000-0000-0000-000000000001", category: "Behavioural", text: "Tell me about yourself.", createdAt: "2026-01-01T00:00:00Z", prepNotes: "" }],
      attempts: [],
      wpmEnabled: true,
      recordingSettings: { cameraEnabled: false, micGainDb: 18, quality: "480" },
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("load");
    await page.locator("#question-list .question-item").first().click();
    // The fake mic starts playing the answer when the camera turns on, so
    // recording a moment later catches the thinking time and the whole answer.
    await page.locator("#camera-toggle-btn").click();
    await page.waitForFunction(() => document.getElementById("preview").videoWidth > 0, null, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.locator("#record-btn").click();
    await page.waitForTimeout((answer.seconds - 2) * 1000);
    await page.locator("#record-btn").click();

    const attempt = await waitFor(() => {
      const a = readLibrary(libraryDir).attempts?.[0];
      return a && !a.transcribing ? a : null;
    }, { timeout: 180_000 });

    const report = JSON.stringify({ ...attempt, transcript: undefined }, null, 1);
    assert.equal(attempt.transcriptError, null, report);
    assert.equal(attempt.pauseCount, 2, `the 2s and 4s gaps are pauses, the 0.7s breath isn't\n${report}`);
    assert.ok(Math.abs(attempt.longestPauseMs - 4000) <= 500, `longest pause ${attempt.longestPauseMs}ms, really 4000ms`);
    assert.ok(attempt.responseDelayMs > 1500 && attempt.responseDelayMs < LEAD_IN_S * 1000, `response delay ${attempt.responseDelayMs}ms`);
    assert.ok(attempt.speakingRatio > 0.4 && attempt.speakingRatio < 0.7, `talking time ${attempt.speakingRatio}`);

    assert.equal(attempt.wpmMeasuredOver, "speech");
    assert.ok(Math.abs(attempt.wpm - answer.trueWpm) / answer.trueWpm <= 0.1, `wpm ${attempt.wpm.toFixed(0)}, really ${answer.trueWpm.toFixed(0)}`);
    // Spoken at one steady pace, so a pause counted as slow speech - the old
    // bug - shows up as a wide or low range.
    assert.ok(attempt.paceMinWpm > answer.trueWpm * 1.0 && attempt.paceMaxWpm < answer.trueWpm * 1.75,
      `pace ${attempt.paceMinWpm?.toFixed(0)}-${attempt.paceMaxWpm?.toFixed(0)} for an answer at a steady pace`);

    // One "…", for the 4s pause only, between the sentences either side of it.
    assert.equal(attempt.transcript.split("…").length - 1, 1, attempt.transcript);
    assert.match(attempt.transcript, /switched\.? … I learned/i);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
