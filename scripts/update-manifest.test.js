import { test } from "node:test";
import assert from "node:assert/strict";

import { readUpdateYml, buildManifest } from "./update-manifest.js";

const linux = `version: 2.0.0
files:
  - url: flight-recorder-2.0.0.AppImage
    sha512: aaa==
    size: 1
    blockMapSize: 2
  - url: flight-recorder_2.0.0_amd64.deb
    sha512: bbb==
    size: 3
path: flight-recorder-2.0.0.AppImage
sha512: aaa==
releaseDate: '2026-09-25T17:18:44.140Z'
`;
const mac = `version: 2.0.0
files:
  - url: flight-recorder-2.0.0-arm64-mac.zip
    sha512: ccc==
    size: 4
  - url: flight-recorder-2.0.0-mac.zip
    sha512: ddd==
    size: 5
path: flight-recorder-2.0.0-mac.zip
sha512: ddd==
`;

test("reads files and hashes, ignoring the legacy top-level path/sha512", () => {
  assert.deepEqual(readUpdateYml(linux), {
    version: "2.0.0",
    files: [
      { url: "flight-recorder-2.0.0.AppImage", sha512: "aaa==" },
      { url: "flight-recorder_2.0.0_amd64.deb", sha512: "bbb==" },
    ],
  });
});

test("merges every platform's file into one manifest", () => {
  const manifest = buildManifest([linux, mac]);
  assert.equal(manifest.version, "2.0.0");
  assert.deepEqual(manifest.files.map((f) => f.url), [
    "flight-recorder-2.0.0.AppImage",
    "flight-recorder_2.0.0_amd64.deb",
    "flight-recorder-2.0.0-arm64-mac.zip",
    "flight-recorder-2.0.0-mac.zip",
  ]);
});

test("refuses mismatched versions and unknown formats", () => {
  assert.throws(() => buildManifest([linux, mac.replace("2.0.0", "2.0.1")]), /disagree/);
  assert.throws(() => readUpdateYml("hello: world"), /unexpected/);
});
