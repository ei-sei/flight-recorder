import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { blake2b512 } from "./blake2b.js";

test("matches OpenSSL's BLAKE2b-512 across block boundaries", () => {
  for (const length of [0, 1, 3, 64, 127, 128, 129, 255, 256, 257, 1000, 4096, 10_001]) {
    const data = crypto.randomBytes(length);
    assert.equal(blake2b512(data).toString("hex"), crypto.createHash("blake2b512").update(data).digest("hex"), `length ${length}`);
  }
});

test("RFC 7693 appendix A: BLAKE2b-512(\"abc\")", () => {
  assert.equal(
    blake2b512(Buffer.from("abc")).toString("hex"),
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"
  );
});
