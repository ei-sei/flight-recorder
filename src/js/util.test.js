// Node's built-in test runner, no dependencies. Run with `node --test src/js/`.
//
// Everything covered here is a pure function that produces a number the app
// shows the user as fact. Each has already been through at least one round of
// subtle correction - the two-second pace floor, the min/max equality guard,
// the back-to-back filler sweep - with nothing to stop the next change quietly
// undoing one of them.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  abbreviateQuestion,
  computePaceRange,
  countFillers,
  countWords,
  dbfs,
  formatBytes,
  formatPaceRange,
  formatTimer,
  normaliseForTranscription,
  pluralise,
  rejectHallucinatedSegments,
  slugify,
} from "./util.js";

// Helper: a constant-amplitude square wave, so RMS equals the amplitude and
// the expected gain is arithmetic rather than guesswork.
function tone(amplitude, length = 1000) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 2 === 0 ? amplitude : -amplitude;
  return out;
}

function rmsOf(samples) {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

test("normalise lifts quiet audio towards the target level", () => {
  // This is the case that made quiet mics transcribe to nothing when auto
  // gain control was turned off at capture.
  const quiet = tone(0.005);
  normaliseForTranscription(quiet);
  assert.ok(rmsOf(quiet) > 0.09, `expected ~0.1, got ${rmsOf(quiet)}`);
});

test("normalise refuses to amplify a silent recording into noise", () => {
  // Without the cap, a noise floor gets lifted to full scale and whisper
  // invents fluent sentences over it.
  const nearSilent = tone(1e-6);
  normaliseForTranscription(nearSilent);
  assert.ok(rmsOf(nearSilent) < 0.01, "near-silence must stay quiet");
});

test("normalise caps its gain rather than hitting the target at any cost", () => {
  const veryQuiet = tone(0.001);
  normaliseForTranscription(veryQuiet);
  // 0.001 * 30 (the cap) = 0.03, well short of the 0.1 target.
  assert.ok(rmsOf(veryQuiet) <= 0.031, `gain exceeded the cap: ${rmsOf(veryQuiet)}`);
});

test("normalise leaves already-loud audio alone", () => {
  const loud = tone(0.4);
  const before = Array.from(loud);
  normaliseForTranscription(loud);
  assert.deepEqual(Array.from(loud), before);
});

test("normalise clamps rather than letting a transient exceed full scale", () => {
  const withTransient = tone(0.02, 999);
  const buf = new Float32Array(1000);
  buf.set(withTransient);
  buf[999] = 0.9;
  normaliseForTranscription(buf);
  for (const s of buf) assert.ok(s >= -1 && s <= 1, `sample out of range: ${s}`);
});

test("normalise handles an empty buffer", () => {
  assert.deepEqual(normaliseForTranscription(new Float32Array(0)), { rms: 0, gain: 1 });
});

test("normalise reports what it measured and what it did", () => {
  // The caller logs these so how quiet a microphone really is can be read off
  // rather than guessed at.
  const quiet = tone(0.005);
  const { rms, gain } = normaliseForTranscription(quiet);
  assert.ok(Math.abs(rms - 0.005) < 1e-6, `rms should describe the input, got ${rms}`);
  assert.ok(gain > 1 && gain <= 30, `gain should be within the cap, got ${gain}`);

  assert.equal(normaliseForTranscription(tone(0.4)).gain, 1, "loud audio reports no lift");
});

test("dbfs converts to the unit microphone levels are discussed in", () => {
  assert.equal(Math.round(dbfs(1)), 0);
  assert.equal(Math.round(dbfs(0.1)), -20);
  assert.equal(Math.round(dbfs(0.01)), -40);
  assert.equal(dbfs(0), -Infinity);
});

test("rejectHallucinatedSegments keeps a segment overlapping measured speech", () => {
  const segments = [{ text: "hello", startMs: 1000, endMs: 2000 }];
  assert.equal(rejectHallucinatedSegments(segments, [[1500, 3000]]).length, 1);
});

test("rejectHallucinatedSegments keeps everything when nothing was measured", () => {
  const segments = [{ text: "hello", startMs: 0, endMs: 1000 }];
  assert.equal(rejectHallucinatedSegments(segments, []).length, 1);
  assert.equal(rejectHallucinatedSegments(segments, undefined).length, 1);
});

test("rejectHallucinatedSegments drops a segment invented over silence", () => {
  const segments = [
    { text: "a", startMs: 0, endMs: 1000 },
    { text: "b", startMs: 1000, endMs: 2000 },
    { text: "invented", startMs: 5000, endMs: 6000 },
    { text: "c", startMs: 7000, endMs: 8000 },
  ];
  const kept = rejectHallucinatedSegments(segments, [[0, 2000], [7000, 8000]]);
  assert.deepEqual(
    kept.map((s) => s.text),
    ["a", "b", "c"],
  );
});

test("rejectHallucinatedSegments gives up rather than blank the transcript", () => {
  // What a recording made with the window hidden looks like: the sampling loop
  // is clamped, so the intervals cover almost nothing and the filter would
  // otherwise throw away real words.
  const segments = [
    { text: "a", startMs: 0, endMs: 1000 },
    { text: "b", startMs: 10000, endMs: 11000 },
    { text: "c", startMs: 20000, endMs: 21000 },
    { text: "d", startMs: 30000, endMs: 31000 },
    { text: "e", startMs: 40000, endMs: 41000 },
  ];
  assert.equal(rejectHallucinatedSegments(segments, [[0, 500]]).length, 5);
});

test("computePaceRange ignores segments too short to be meaningful", () => {
  const segments = [
    { text: "two words", startMs: 0, endMs: 1000 },
    { text: "a longer stretch of speech here", startMs: 2000, endMs: 5000 },
    { text: "another longer stretch of speech", startMs: 6000, endMs: 12000 },
  ];
  const { minWpm, maxWpm } = computePaceRange(segments);
  // Only the two segments of at least 2s count: 6 words over 3s = 120wpm,
  // and 5 words over 6s = 50wpm.
  assert.equal(Math.round(minWpm), 50);
  assert.equal(Math.round(maxWpm), 120);
});

test("computePaceRange refuses to call a single segment a range", () => {
  const segments = [{ text: "one two three four", startMs: 0, endMs: 3000 }];
  assert.deepEqual(computePaceRange(segments), { minWpm: null, maxWpm: null });
});

test("formatPaceRange hides a range that rounds to one number", () => {
  assert.equal(formatPaceRange(120.1, 120.4), null);
  assert.equal(formatPaceRange(110, 175), "pace 110-175 wpm");
  assert.equal(formatPaceRange(null, 175), null);
});

test("countFillers counts back-to-back repeats", () => {
  assert.equal(countFillers("um um so it was fine"), 2);
});

test("countFillers counts a multi-word phrase once, not as its parts", () => {
  assert.equal(countFillers("you know it was fine"), 1);
});

test("countFillers is zero on text with none", () => {
  assert.equal(countFillers("I led the migration and it shipped on time"), 0);
  assert.equal(countFillers(""), 0);
});

test("countFillers matches stretched-out hesitations", () => {
  // What people actually produce when hesitating, and what Whisper writes
  // down when it writes it down at all. Matching only the clipped forms found
  // "um" and missed every "ummm".
  assert.equal(countFillers("ummm so I did the thing"), 1);
  assert.equal(countFillers("errr so I did the thing"), 1);
  assert.equal(countFillers("uhhh so I did the thing"), 1);
  assert.equal(countFillers("hmmm so I did the thing"), 1);
  assert.equal(countFillers("aaah so I did the thing"), 1);
});

test("countFillers still matches the clipped forms", () => {
  assert.equal(countFillers("um so I did the thing"), 1);
  assert.equal(countFillers("er so I did the thing"), 1);
  assert.equal(countFillers("Um, so I did the thing"), 1);
});

test("countFillers counts erm as one filler, not erm plus er", () => {
  assert.equal(countFillers("erm so I did the thing"), 1);
  assert.equal(countFillers("ermmm so I did the thing"), 1);
});

test("countFillers does not match a hesitation inside a real word", () => {
  // The whitespace delimiters are what stop u+m+ finding "um" in "umbrella".
  assert.equal(countFillers("I brought an umbrella to the interview"), 0);
  assert.equal(countFillers("the answer was uhhhindered by nothing"), 0);
  assert.equal(countFillers("I was there early"), 0);
});

test("countFillers does not count ordinary uses of like", () => {
  // "like" is a verb and a preposition far more often than it is a filler,
  // and this count is shown as a bare number with nothing to qualify it.
  assert.equal(countFillers("I like working in teams on something like that"), 0);
});

test("countWords ignores surrounding and repeated whitespace", () => {
  assert.equal(countWords("  one   two \n three "), 3);
  assert.equal(countWords("   "), 0);
});

test("pluralise agrees with its count", () => {
  // Used in the reset-all-data warning, where "1 questions" would undercut a
  // dialog that is asking the user to type DELETE.
  assert.equal(pluralise(0, "question"), "0 questions");
  assert.equal(pluralise(1, "question"), "1 question");
  assert.equal(pluralise(2, "attempt"), "2 attempts");
  assert.equal(pluralise(11, "attempt"), "11 attempts");
});

test("formatBytes switches unit and precision at the right points", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024 * 10), "10 MB");
  assert.equal(formatBytes(1024 ** 3 * 39), "39 GB");
});

test("formatTimer renders tenths, not seconds", () => {
  assert.equal(formatTimer(0), "00:00.0");
  assert.equal(formatTimer(65_400), "01:05.4");
  assert.equal(formatTimer(600_000), "10:00.0");
});

test("slugify never returns an empty path segment", () => {
  assert.equal(slugify("Behavioural"), "behavioural");
  assert.equal(slugify("Tell me about yourself."), "tell-me-about-yourself");
  // A filename is built from this, so punctuation alone must not produce "".
  assert.equal(slugify("!!!"), "question");
});

test("abbreviateQuestion drops single-letter words", () => {
  assert.equal(abbreviateQuestion("Describe a project you're proud of and why."), "dpypoaw");
  assert.equal(abbreviateQuestion("!!!"), "q");
});
