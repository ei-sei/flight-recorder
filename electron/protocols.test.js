import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseRange, createMediaHandler, createAppHandler, mediaUrlFor, isAppUrl } from "./protocols.js";
import { createLibrary } from "./library.js";

test("parseRange", () => {
  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=20-10", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRange("items=0-1", 100), "unsatisfiable");
});

test("isAppUrl only accepts the app origin", () => {
  assert.equal(isAppUrl("app://flight-recorder/index.html"), true);
  assert.equal(isAppUrl("app://flight-recorder"), true);
  assert.equal(isAppUrl("app://flight-recorder.evil/index.html"), false);
  assert.equal(isAppUrl("https://example.com/"), false);
  assert.equal(isAppUrl(undefined), false);
});

let tmp;
let root;
let video;
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fr-protocols-"));
  root = path.join(tmp, "flight-recorder");
  await fs.mkdir(path.join(root, "case"), { recursive: true });
  video = path.join(root, "case", "a b#1.mp4");
  await fs.writeFile(video, bytes);
  await fs.writeFile(path.join(tmp, "outside.mp4"), bytes);
  await fs.mkdir(path.join(tmp, "ui"));
  await fs.writeFile(path.join(tmp, "ui", "index.html"), "<p>hi</p>");
  await fs.writeFile(path.join(tmp, "secret.txt"), "no");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test("media: whole file, then ranges, from an awkward file name", async () => {
  const handle = createMediaHandler(createLibrary({ root }));
  const whole = await handle(new Request(mediaUrlFor(video)));
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);

  const part = await handle(new Request(mediaUrlFor(video), { headers: { range: "bytes=100-199" } }));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 100-199/1000");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));

  const bad = await handle(new Request(mediaUrlFor(video), { headers: { range: "bytes=5000-" } }));
  assert.equal(bad.status, 416);
});

test("media: refuses files outside the library and unknown hosts", async () => {
  const handle = createMediaHandler(createLibrary({ root }));
  assert.equal((await handle(new Request(mediaUrlFor(path.join(tmp, "outside.mp4"))))).status, 403);
  assert.equal((await handle(new Request(mediaUrlFor(path.join(root, "..", "outside.mp4"))))).status, 403);
  assert.equal((await handle(new Request(`media://other/${encodeURIComponent(video)}`))).status, 404);
  assert.equal((await handle(new Request(mediaUrlFor(path.join(root, "missing.mp4"))))).status, 404);
});

test("app: serves the UI with the CSP, and nothing outside it", async () => {
  const handle = createAppHandler(path.join(tmp, "ui"));
  const index = await handle(new Request("app://flight-recorder/"));
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.match(index.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(await index.text(), "<p>hi</p>");
  // The URL parser resolves some of these before the handler sees them (so
  // they 404 inside the UI folder) and the handler refuses the rest - either
  // way the file outside is never served.
  for (const escape of ["%2e%2e/secret.txt", "..%2Fsecret.txt", "%2E%2E%2Fsecret.txt", "a/../../secret.txt"]) {
    const response = await handle(new Request(`app://flight-recorder/${escape}`));
    assert.ok([403, 404].includes(response.status), `${escape} -> ${response.status}`);
    assert.notEqual(await response.text(), "no");
  }
  assert.equal((await handle(new Request("app://elsewhere/index.html"))).status, 404);
  assert.equal((await handle(new Request("app://flight-recorder/nope.js"))).status, 404);
});
