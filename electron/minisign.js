// Verifies minisign signatures - the format Tauri's updater signed releases
// with (`tauri signer sign`), and the same key still signs them. electron-
// updater on its own only checks a download against a SHA-512 listed in an
// unsigned file from the same release, and on Linux it then installs the
// package as root; this is what keeps a tampered release from being
// installed.
//
// Format (https://jedisct1.github.io/minisign/): the public key is "Ed" +
// 8-byte key id + 32-byte Ed25519 key. A signature file is an untrusted
// comment, the signature ("ED" = over the BLAKE2b-512 of the file, "Ed" =
// over the file itself, + key id + 64 bytes), a trusted comment, and a
// global signature over the signature bytes plus that trusted comment.

import crypto from "node:crypto";
import { blake2b512 } from "./blake2b.js";

// Accepts the key as the raw "RW..." line, the whole .pub file, or the
// base64 of the whole file (how Tauri stored it in tauri.conf.json).
function textOf(value) {
  const text = String(value).trim();
  if (text.includes("comment:") || text.startsWith("RW")) return text;
  return Buffer.from(text, "base64").toString("utf8");
}

function dataLines(text) {
  return textOf(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parsePublicKey(value) {
  const line = dataLines(value).find((l) => !l.startsWith("untrusted comment:"));
  const raw = Buffer.from(line ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("not a minisign public key");
  }
  return {
    keyId: raw.subarray(2, 10),
    key: crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10).toString("base64url") },
      format: "jwk",
    }),
  };
}

// Throws unless `signature` is a valid signature of `data` by `publicKey`.
export function verifyMinisign(data, signature, publicKey) {
  const { keyId, key } = typeof publicKey === "string" ? parsePublicKey(publicKey) : publicKey;
  const [untrusted, sigLine, trustedLine, globalLine] = dataLines(signature);
  if (!untrusted?.startsWith("untrusted comment:") || !trustedLine?.startsWith("trusted comment: ") || !globalLine) {
    throw new Error("malformed signature file");
  }

  const sig = Buffer.from(sigLine, "base64");
  if (sig.length !== 74) throw new Error("malformed signature");
  const algorithm = sig.subarray(0, 2).toString("latin1");
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error("unknown signature algorithm");
  if (!sig.subarray(2, 10).equals(keyId)) throw new Error("signed with a different key");
  const signatureBytes = sig.subarray(10);

  const message = algorithm === "ED" ? blake2b512(data) : data;
  if (!crypto.verify(null, message, key, signatureBytes)) throw new Error("signature doesn't match");

  const trustedComment = trustedLine.slice("trusted comment: ".length);
  const globalSignature = Buffer.from(globalLine, "base64");
  const signed = Buffer.concat([signatureBytes, Buffer.from(trustedComment, "utf8")]);
  if (!crypto.verify(null, signed, key, globalSignature)) throw new Error("trusted comment signature doesn't match");
  return { trustedComment };
}
