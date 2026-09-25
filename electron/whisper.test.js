import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createWhisper, MODEL_FILENAME } from "./whisper.js";
import { createLibrary } from "./library.js";

// The fake helpers are shell scripts.
const skip = process.platform === "win32";

const good = Buffer.from("pretend this is a whisper model ".repeat(4096));
const goodModel = (url) => ({ url, sha256: crypto.createHash("sha256").update(good).digest("hex"), bytes: good.length });

let server;
let base;
let tmp;
let root;
let modelDir;
let library;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/model") {
      res.writeHead(200, { "content-length": good.length });
      res.end(good);
    } else if (req.url === "/wrong") {
      const wrong = Buffer.from(good);
      wrong[100] ^= 1;
      res.writeHead(200, { "content-length": wrong.length });
      res.end(wrong);
    } else if (req.url === "/truncated") {
      res.writeHead(200, { "content-length": good.length });
      res.write(good.subarray(0, 1000));
      setTimeout(() => res.destroy(), 20);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fr-whisper-"));
  root = path.join(tmp, "flight-recorder");
  modelDir = path.join(tmp, "appdata");
  await fs.mkdir(path.join(root, "case"), { recursive: true });
  library = createLibrary({ root });
});

async function fakeHelper(body) {
  const file = path.join(tmp, "fake-helper.sh");
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

async function withModel() {
  await fs.mkdir(modelDir, { recursive: true });
  await fs.writeFile(path.join(modelDir, MODEL_FILENAME), "model");
}

async function scratchPcm() {
  const pcm = path.join(root, "case", "a.mp4.pcm");
  await fs.writeFile(pcm, Buffer.alloc(64));
  return pcm;
}

const exists = (file) => fs.access(file).then(() => true, () => false);

test("downloads, verifies and reports progress", { skip }, async () => {
  const whisper = createWhisper({ modelDir, helperPath: "/nonexistent", library, model: goodModel(`${base}/model`) });
  assert.equal(await whisper.modelPresent(), false);
  const progress = [];
  await whisper.downloadModel((p) => progress.push(p));
  assert.equal(await whisper.modelPresent(), true);
  assert.deepEqual(progress.at(-1), { downloaded: good.length, total: good.length });
  assert.deepEqual(await fs.readdir(modelDir), [MODEL_FILENAME]);
});

test("a file that doesn't match the pinned hash is refused and cleaned up", { skip }, async () => {
  const whisper = createWhisper({ modelDir, helperPath: "/nonexistent", library, model: { ...goodModel(`${base}/wrong`) } });
  await assert.rejects(whisper.downloadModel(), /wasn't the expected file/);
  assert.equal(await whisper.modelPresent(), false);
  assert.deepEqual(await fs.readdir(modelDir), []);
});

test("a download cut short is refused and cleaned up", { skip }, async () => {
  const whisper = createWhisper({ modelDir, helperPath: "/nonexistent", library, model: goodModel(`${base}/truncated`) });
  await assert.rejects(whisper.downloadModel());
  assert.equal(await whisper.modelPresent(), false);
  assert.deepEqual(await fs.readdir(modelDir), []);
});

test("an HTTP error is reported", { skip }, async () => {
  const whisper = createWhisper({ modelDir, helperPath: "/nonexistent", library, model: goodModel(`${base}/missing`) });
  await assert.rejects(whisper.downloadModel(), /HTTP 404/);
});

test("transcribe returns the helper's result and removes the scratch audio", { skip }, async () => {
  await withModel();
  const helperPath = await fakeHelper(`echo "whisper log line" >&2
echo '{"ok":true,"segments":[],"audio_ms":100,"elapsed_ms":5,"threads":8,"system_info":"AVX2 = 1"}'`);
  const whisper = createWhisper({ modelDir, helperPath, library });
  const pcm = await scratchPcm();
  const result = await whisper.transcribe(pcm);
  assert.deepEqual(result, { segments: [], audio_ms: 100, elapsed_ms: 5, threads: 8, system_info: "AVX2 = 1" });
  assert.equal(await exists(pcm), false);
});

test("the helper's own error message comes through as written", { skip }, async () => {
  await withModel();
  const helperPath = await fakeHelper(`echo '{"ok":false,"error":"recording produced no decodable audio"}'; exit 1`);
  const whisper = createWhisper({ modelDir, helperPath, library });
  const pcm = await scratchPcm();
  await assert.rejects(whisper.transcribe(pcm), { message: "recording produced no decodable audio" });
  assert.equal(await exists(pcm), false);
});

test("a helper crash becomes a readable error, not a dead app", { skip }, async () => {
  await withModel();
  const helperPath = await fakeHelper("kill -ILL $$");
  const whisper = createWhisper({ modelDir, helperPath, library });
  const pcm = await scratchPcm();
  await assert.rejects(whisper.transcribe(pcm), /processor instruction this computer doesn't have/);
  assert.equal(await exists(pcm), false);
});

test("no model: refuses without running the helper, and never downloads", { skip }, async () => {
  const marker = path.join(tmp, "helper-ran");
  const helperPath = await fakeHelper(`touch "${marker}"`);
  const whisper = createWhisper({ modelDir, helperPath, library, model: goodModel(`${base}/model`) });
  const pcm = await scratchPcm();
  await assert.rejects(whisper.transcribe(pcm), /speech model isn't on this device/);
  assert.equal(await exists(marker), false);
  assert.equal(await whisper.modelPresent(), false);
  assert.equal(await exists(pcm), false);
});

test("audio outside the library is refused and left alone", { skip }, async () => {
  await withModel();
  const whisper = createWhisper({ modelDir, helperPath: await fakeHelper("exit 0"), library });
  const outside = path.join(tmp, "outside.pcm");
  await fs.writeFile(outside, "x");
  await assert.rejects(whisper.transcribe(outside), /outside the library/);
  assert.equal(await exists(outside), true);
});

test("a missing helper says so", { skip }, async () => {
  await withModel();
  const whisper = createWhisper({ modelDir, helperPath: path.join(tmp, "nope"), library });
  await assert.rejects(whisper.transcribe(await scratchPcm()), /missing from this installation/);
});
