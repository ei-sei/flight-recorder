import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { verifyUpdateInfo } from "./update-manifest.js";

// update-manifest.json lists version 9.9.9 with one file, and is signed by
// the throwaway test key (see minisign.test.js).
const fixtures = path.join(import.meta.dirname, "test-fixtures");
const publicKey = fs.readFileSync(path.join(fixtures, "test-key.pub"), "utf8");
const base = "https://example.invalid/releases/v9.9.9/";
const served = {
  [`${base}update-manifest.json`]: fs.readFileSync(path.join(fixtures, "update-manifest.json")),
  [`${base}update-manifest.json.sig`]: fs.readFileSync(path.join(fixtures, "update-manifest.json.sig")),
};
const fetchImpl = async (url) => {
  if (!served[url]) throw new Error(`404 ${url}`);
  return served[url];
};
const options = { publicKey, base, fetchImpl };
const genuine = { version: "9.9.9", files: [{ url: "flight-recorder-9.9.9.AppImage", sha512: "abc" }] };

test("an update matching the signed manifest passes", async () => {
  await verifyUpdateInfo(genuine, options);
});

test("a file hash that differs from the signed manifest is refused", async () => {
  const swapped = { ...genuine, files: [{ ...genuine.files[0], sha512: "evil" }] };
  await assert.rejects(verifyUpdateInfo(swapped, options), /doesn't match the release's signed manifest/);
});

test("a file the manifest doesn't list is refused", async () => {
  const extra = { ...genuine, files: [...genuine.files, { url: "payload.exe", sha512: "x" }] };
  await assert.rejects(verifyUpdateInfo(extra, options), /payload\.exe/);
});

test("a different version is refused", async () => {
  await assert.rejects(verifyUpdateInfo({ ...genuine, version: "9.9.10" }, options), /different version/);
});

test("an update listing nothing is refused", async () => {
  await assert.rejects(verifyUpdateInfo({ version: "9.9.9", files: [] }, options), /lists no files/);
});

test("a manifest signed by another key is refused", async () => {
  await assert.rejects(
    verifyUpdateInfo(genuine, { ...options, publicKey: "RWQ7ZTtlMl8Aq8gSomA72oSj54y+bnXqRTQP8bdU823WejVdmues2pfP" }),
    /different key/
  );
});

test("a missing signature is refused", async () => {
  await assert.rejects(verifyUpdateInfo(genuine, { ...options, base: "https://example.invalid/other/" }), /404/);
});
