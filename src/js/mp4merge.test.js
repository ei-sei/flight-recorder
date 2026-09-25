// Covers mp4merge.js against real WebKitGTK 2.54 MediaRecorder output (a
// 64x64 canvas at 24fps and a 44.1kHz tone, recorded by two recorders at
// once, exactly as splitrecorder.js does). Real files rather than synthetic
// ones on purpose: their quirks - a duplicated final moof whose first copy
// points at the wrong bytes, two ftyp boxes - are exactly what the parser has
// to survive. The fixtures live outside src/ so they aren't bundled into the
// app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseMp4, countSamples, mergeAudioVideo, concatParts } from "./mp4merge.js";

const fixture = (name) => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));
const VIDEO = fixture("webkit-video-only.mp4");
const AUDIO = fixture("webkit-audio-only.mp4");

// An independent reader for the non-fragmented output, written against the
// spec rather than sharing code with the writer, so a bug in one can't hide
// a matching bug in the other.
function readBox(b, p) {
  const size = ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
  return { size, type: String.fromCharCode(...b.subarray(p + 4, p + 8)), body: p + 8, end: p + size };
}
function find(b, start, end, type) {
  for (let p = start; p < end; ) {
    const box = readBox(b, p);
    if (box.type === type) return box;
    p = box.end;
  }
  return null;
}
function all(b, start, end, type) {
  const out = [];
  for (let p = start; p < end; ) {
    const box = readBox(b, p);
    if (box.type === type) out.push(box);
    p = box.end;
  }
  return out;
}
const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
function readStbl(b, trak) {
  const at = (...types) => types.reduce((box, t) => find(b, box.body, box.end, t), trak);
  const stbl = at("mdia", "minf", "stbl");
  const get = (t) => find(b, stbl.body, stbl.end, t);
  const stsz = get("stsz"), stco = get("stco"), stsc = get("stsc"), stts = get("stts");
  const sizes = Array.from({ length: u32(b, stsz.body + 8) }, (_, i) => u32(b, stsz.body + 12 + i * 4));
  const offsets = Array.from({ length: u32(b, stco.body + 4) }, (_, i) => u32(b, stco.body + 8 + i * 4));
  const stscRows = Array.from({ length: u32(b, stsc.body + 4) }, (_, i) => [u32(b, stsc.body + 8 + i * 12), u32(b, stsc.body + 12 + i * 12)]);
  const durations = [];
  for (let i = 0; i < u32(b, stts.body + 4); i++) {
    for (let n = 0; n < u32(b, stts.body + 8 + i * 8); n++) durations.push(u32(b, stts.body + 12 + i * 8));
  }
  const samples = [];
  let s = 0;
  offsets.forEach((offset, chunkIndex) => {
    const row = [...stscRows].reverse().find(([first]) => first <= chunkIndex + 1);
    for (let k = 0; k < row[1]; k++) {
      samples.push({ offset, size: sizes[s] });
      offset += sizes[s];
      s++;
    }
  });
  const handler = String.fromCharCode(...b.subarray(at("mdia", "hdlr").body + 8, at("mdia", "hdlr").body + 12));
  return { handler, samples, durations, edts: find(b, trak.body, trak.end, "edts") };
}
function readMerged(bytes) {
  const moov = find(bytes, 0, bytes.length, "moov");
  return all(bytes, moov.body, moov.end, "trak").map((trak) => readStbl(bytes, trak));
}
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

test("parses WebKit's video-only recording, ignoring its bogus duplicate moof", () => {
  const [track] = parseMp4(VIDEO);
  assert.equal(track.handler, "vide");
  assert.equal(track.timescale, 2400);
  // 15 + 14 real frames. Counting the duplicated final moof would give 43.
  assert.equal(track.samples.length, 29);
  assert.ok(track.samples[0].sync, "a recording starts on a keyframe");
  assert.ok(track.samples.every((s) => s.duration === 100), "24fps is 100 ticks at 2400/s");
  assert.ok(track.samples.every((s) => s.offset + s.size <= VIDEO.length));
});

test("parses WebKit's audio-only recording", () => {
  const [track] = parseMp4(AUDIO);
  assert.equal(track.handler, "soun");
  assert.equal(track.timescale, 44100);
  assert.equal(track.samples.length, 51);
  assert.ok(track.samples.every((s) => s.duration === 1024), "one AAC frame is 1024 samples");
});

test("countSamples tells an audio-only file from one with video", () => {
  assert.deepEqual(countSamples(VIDEO), { video: 29, audio: 0 });
  assert.deepEqual(countSamples(AUDIO), { video: 0, audio: 51 });
});

test("merge keeps every sample, byte for byte, in order", () => {
  const merged = concatParts(mergeAudioVideo(VIDEO, AUDIO));
  const tracks = readMerged(merged);
  assert.deepEqual(tracks.map((t) => t.handler), ["vide", "soun"]);
  for (const [out, source, bytes] of [[tracks[0], parseMp4(VIDEO)[0], VIDEO], [tracks[1], parseMp4(AUDIO)[0], AUDIO]]) {
    assert.equal(out.samples.length, source.samples.length);
    out.samples.forEach((sample, i) => {
      const expected = bytes.subarray(source.samples[i].offset, source.samples[i].offset + source.samples[i].size);
      assert.ok(sameBytes(merged.subarray(sample.offset, sample.offset + sample.size), expected), `${out.handler} sample ${i} differs`);
    });
    assert.deepEqual(out.durations, source.samples.map((s) => s.duration));
  }
});

test("merged file is a plain MP4: one ftyp, moov before mdat, no fragments", () => {
  const merged = concatParts(mergeAudioVideo(VIDEO, AUDIO));
  const top = [];
  let p = 0;
  while (p < merged.length) {
    const box = readBox(merged, p);
    top.push(box.type);
    p = box.end;
  }
  assert.deepEqual(top, ["ftyp", "moov", "mdat"]);
  // The boxes tile the file exactly - no gap, no overrun.
  assert.equal(p, merged.length);
});

test("countSamples sees both tracks in the merged file", () => {
  assert.deepEqual(countSamples(concatParts(mergeAudioVideo(VIDEO, AUDIO))), { video: 29, audio: 51 });
});

test("a start-time correction delays only the later track, with an edit list", () => {
  const delayedAudio = readMerged(concatParts(mergeAudioVideo(VIDEO, AUDIO, { audioDelayMs: 40 })));
  assert.equal(delayedAudio[0].edts, null);
  assert.ok(delayedAudio[1].edts);
  const delayedVideo = readMerged(concatParts(mergeAudioVideo(VIDEO, AUDIO, { audioDelayMs: -40 })));
  assert.ok(delayedVideo[0].edts);
  assert.equal(delayedVideo[1].edts, null);
});

test("refuses inputs it can't merge rather than writing a broken file", () => {
  assert.throws(() => mergeAudioVideo(AUDIO, AUDIO), /no video samples/);
  assert.throws(() => mergeAudioVideo(VIDEO, VIDEO), /no audio samples/);
  assert.throws(() => mergeAudioVideo(new Uint8Array(16), AUDIO), /no moov/);
});
