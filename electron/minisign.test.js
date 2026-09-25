import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { verifyMinisign, parsePublicKey } from "./minisign.js";

// Signed with a throwaway key by Tauri's own signer (`tauri signer sign`),
// the tool that signs real releases - only the public half is kept here.
const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, "test-fixtures", name));
const data = fixture("update-manifest.json");
const signature = fixture("update-manifest.json.sig").toString("utf8");
const publicKey = fixture("test-key.pub").toString("utf8");

// The app's real update key, as tauri.conf.json stored it.
const RELEASE_KEY = "RWQ7ZTtlMl8Aq8gSomA72oSj54y+bnXqRTQP8bdU823WejVdmues2pfP";

test("accepts Tauri's signature over the file", () => {
  const { trustedComment } = verifyMinisign(data, signature, publicKey);
  assert.match(trustedComment, /file:manifest\.json/);
});

test("rejects a changed file", () => {
  const tampered = Buffer.from(data.toString("utf8").replace("9.9.9", "9.9.8"));
  assert.throws(() => verifyMinisign(tampered, signature, publicKey), /doesn't match/);
});

test("rejects a changed trusted comment", () => {
  const lines = Buffer.from(signature, "base64").toString("utf8").split("\n");
  lines[2] = lines[2].replace("manifest.json", "other.json");
  const edited = Buffer.from(lines.join("\n")).toString("base64");
  assert.throws(() => verifyMinisign(data, edited, publicKey), /trusted comment/);
});

test("rejects a signature from a different key", () => {
  assert.throws(() => verifyMinisign(data, signature, RELEASE_KEY), /different key/);
});

test("reads the release key in every form it's stored in", () => {
  const line = parsePublicKey(RELEASE_KEY);
  const file = parsePublicKey(`untrusted comment: minisign public key: AB005F32653B653B\n${RELEASE_KEY}\n`);
  const tauriConf = parsePublicKey(Buffer.from(`untrusted comment: minisign public key: AB005F32653B653B\n${RELEASE_KEY}\n`).toString("base64"));
  assert.equal(line.keyId.toString("hex").toUpperCase().match(/../g).reverse().join(""), "AB005F32653B653B");
  assert.ok(line.keyId.equals(file.keyId) && line.keyId.equals(tauriConf.keyId));
});

test("rejects garbage", () => {
  assert.throws(() => parsePublicKey("hello"), /not a minisign public key/);
  assert.throws(() => verifyMinisign(data, "nonsense", publicKey), /malformed/);
});
