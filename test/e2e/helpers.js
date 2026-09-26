// Shared by the end-to-end tests: launching the app from source against a
// throwaway library, and building microphone input for it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

export const repo = path.join(import.meta.dirname, "..", "..");
export const MODEL_FILE = "ggml-base.en-q5_1.bin";

// ffmpeg is the odd one out: it takes -version, and fails on --version.
export function has(command) {
  try {
    execFileSync(command, [command === "ffmpeg" ? "-version" : "--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// 16-bit mono PCM WAV, the form Chromium's fake microphone reads.
export function writeWav(file, samples, rate = 48000) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2));
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
}

// espeak-ng saying `text`, as 48kHz float samples trimmed to the speech
// itself, so the test decides exactly where the silences are.
export function speak(text, tmp) {
  const raw = path.join(tmp, `speak-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  execFileSync("espeak-ng", ["-s", "150", "-w", raw, text]);
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", raw, "-ar", "48000", "-ac", "1", "-f", "s16le", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const samples = Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
  const first = samples.findIndex((s) => Math.abs(s) > 0.01);
  const last = samples.length - [...samples].reverse().findIndex((s) => Math.abs(s) > 0.01);
  return samples.slice(first, last);
}

export function readLibrary(libraryDir) {
  return JSON.parse(fs.readFileSync(path.join(libraryDir, "library.json"), "utf8"));
}

export async function waitFor(check, { timeout = 30_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Launches the app from source on a fresh profile and a throwaway library
// seeded with `library` (library.json contents), with the fake camera and
// `mic` (a WAV path) as the microphone. `model` (a path) enables speech
// pace. Resolves to { app, tmp, libraryDir, netlog }.
export async function launchApp({ library = {}, mic, model, netlog = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fr-e2e-"));
  const videos = path.join(tmp, "Videos");
  const libraryDir = path.join(videos, "flight-recorder");
  const data = path.join(tmp, "data");
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  if (model) fs.copyFileSync(model, path.join(data, MODEL_FILE));
  fs.writeFileSync(path.join(libraryDir, "library.json"), JSON.stringify(library));

  const env = {
    ...process.env,
    FLIGHT_RECORDER_VIDEOS_DIR: videos,
    FLIGHT_RECORDER_DATA_DIR: data,
    // A fresh Chromium profile every run, as on a first install - a cached
    // file from an earlier run once hid a network request a test exists to
    // catch.
    FLIGHT_RECORDER_USER_DATA_DIR: path.join(tmp, "profile"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Either would make the app relaunch itself, and Playwright would lose it.
  delete env.MANGOHUD;
  const netlogFile = path.join(tmp, "netlog.json");
  const args = [
    repo,
    ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    ...(mic ? [`--use-file-for-fake-audio-capture=${mic}`] : []),
    ...(netlog ? [`--log-net-log=${netlogFile}`] : []),
  ];
  const app = await electron.launch({ args, env, cwd: repo });
  return { app, tmp, libraryDir, netlog: netlogFile };
}
