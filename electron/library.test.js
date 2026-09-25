import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLibrary } from "./library.js";

let tmp;
let root;
let outside;
let lib;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fr-library-"));
  root = path.join(tmp, "Videos", "flight-recorder");
  outside = path.join(tmp, "elsewhere");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "private");
  lib = createLibrary({ root, legacyStoreFile: path.join(tmp, "appdata", "flight-recorder.json") });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test("reads and writes inside the library", async () => {
  const file = path.join(root, "behavioural", "a.mp4");
  await lib.mkdir(path.dirname(file), { recursive: true });
  await lib.writeFile(file, new Uint8Array([1, 2, 3]));
  assert.deepEqual([...(await lib.readFile(file))], [1, 2, 3]);
  assert.equal(await lib.exists(file), true);
  await lib.remove(file);
  assert.equal(await lib.exists(file), false);
});

test("the library folder itself is allowed, including removing it", async () => {
  assert.equal(await lib.exists(root), true);
  await lib.remove(root, { recursive: true });
  assert.equal(await lib.exists(root), false);
  // And recreated from nothing, as Reset data then does.
  await lib.mkdir(root, { recursive: true });
  assert.equal(await lib.exists(root), true);
});

test("rejects .. escapes", async () => {
  const escape = path.join(root, "..", "..", "elsewhere", "secret.txt");
  await assert.rejects(lib.readFile(escape), /outside the library/);
  await assert.rejects(lib.writeFile(escape, new Uint8Array([0])), /outside the library/);
  await assert.rejects(lib.remove(path.join(root, "..")), /outside the library/);
  assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "private");
});

test("rejects absolute paths outside, and a sibling folder sharing the prefix", async () => {
  await assert.rejects(lib.readFile(path.join(outside, "secret.txt")), /outside the library/);
  const sibling = `${root}-evil`;
  await fs.mkdir(sibling);
  await assert.rejects(lib.writeFile(path.join(sibling, "x"), new Uint8Array([0])), /outside the library/);
  await assert.rejects(lib.exists(path.join(outside, "secret.txt")), /outside the library/);
});

test("rejects relative and empty paths", async () => {
  await assert.rejects(lib.readFile("library.json"), /outside the library/);
  await assert.rejects(lib.readFile(""), /invalid path/);
});

test("rejects a symlink inside the library that points out of it", async () => {
  const link = path.join(root, "link");
  await fs.symlink(outside, link);
  await assert.rejects(lib.readFile(path.join(link, "secret.txt")), /outside the library/);
  // Not-yet-existing files under the link are resolved through it too.
  await assert.rejects(lib.writeFile(path.join(link, "new.txt"), new Uint8Array([0])), /outside the library/);
});

test("follows a library folder that is itself a symlink", async () => {
  const realLib = path.join(tmp, "other-drive", "flight-recorder");
  await fs.mkdir(realLib, { recursive: true });
  const linkedRoot = path.join(tmp, "Linked", "flight-recorder");
  await fs.mkdir(path.dirname(linkedRoot), { recursive: true });
  await fs.symlink(realLib, linkedRoot);
  const linked = createLibrary({ root: linkedRoot });
  await linked.writeFile(path.join(linkedRoot, "a.txt"), new TextEncoder().encode("ok"));
  assert.equal(await fs.readFile(path.join(realLib, "a.txt"), "utf8"), "ok");
});

test("size adds up files and skips symlinks", async () => {
  await fs.mkdir(path.join(root, "case"), { recursive: true });
  await fs.writeFile(path.join(root, "case", "a.mp4"), Buffer.alloc(1000));
  await fs.writeFile(path.join(root, "library.json"), Buffer.alloc(24));
  await fs.symlink(outside, path.join(root, "link"));
  assert.equal(await lib.size(), 1024);
});

test("store text: missing file reads as null, writes are atomic and create the folder", async () => {
  const store = path.join(root, "library.json");
  assert.equal(await lib.readText(store), null);
  await lib.remove(root, { recursive: true });
  await lib.writeTextAtomic(store, '{\n  "a": 1\n}');
  assert.equal(await lib.readText(store), '{\n  "a": 1\n}');
  const leftovers = (await fs.readdir(root)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("concurrent store writes land in order", async () => {
  const store = path.join(root, "library.json");
  await Promise.all(Array.from({ length: 20 }, (_, i) => lib.writeTextAtomic(store, String(i))));
  assert.equal(await lib.readText(store), "19");
});

test("the legacy store is readable by its bare name, and only that name", async () => {
  assert.equal(await lib.readText("flight-recorder.json"), null);
  await fs.mkdir(path.join(tmp, "appdata"), { recursive: true });
  await fs.writeFile(path.join(tmp, "appdata", "flight-recorder.json"), '{"questions":[]}');
  assert.equal(await lib.readText("flight-recorder.json"), '{"questions":[]}');
  await assert.rejects(lib.writeTextAtomic("flight-recorder.json", "{}"), /outside the library/);
});
