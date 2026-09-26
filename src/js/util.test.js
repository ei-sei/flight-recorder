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
  computeWpm,
  correctLegacyWpm,
  countFillers,
  countWords,
  dbfs,
  formatBytes,
  formatPaceRange,
  formatTimer,
  joinWordsWithPauses,
  normaliseForTranscription,
  pluralise,
  rejectHallucinatedSegments,
  slugify,
} from "./util.js";

function word(text, startMs, endMs) {
  return { text, startMs, endMs };
}

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

test("rejectHallucinatedSegments does not let a degraded live detector delete a real transcript", () => {
  // A real production incident, reproduced at the same ratio. A 2:34
  // single-take interview answer - nothing invented, confirmed by running
  // the exact PCM directly through whisper outside the app - came back as
  // 23 correct segments. The live mic-level detector only registered
  // speechIntervals covering a sliver of the actual talking (measured
  // speakingRatio on the attempt: 1.4%), so only 8 of the 23 segments
  // overlapped anything - 34.8%. The old 0.25 floor let that through as a
  // real filtering decision, and it silently deleted 15 segments including
  // the entire action section of the answer.
  const segments = Array.from({ length: 23 }, (_, i) => ({
    text: `segment ${i}`,
    startMs: i * 1000,
    endMs: i * 1000 + 900,
  }));
  // Only the first 8 overlap a measured interval - the same 34.8% ratio as
  // the incident.
  const speechIntervals = segments.slice(0, 8).map((s) => [s.startMs, s.endMs]);
  const kept = rejectHallucinatedSegments(segments, speechIntervals);
  assert.equal(kept.length, 23, "34.8% is a real transcript, not a hallucination - must not be filtered");
});

test("joinWordsWithPauses joins ordinary words with plain spaces when nothing paused", () => {
  const words = [word("Hello", 0, 300), word("there", 350, 600)];
  assert.equal(joinWordsWithPauses(words, [[0, 600]]), "Hello there");
});

test("joinWordsWithPauses marks a real pause between two speech-active stretches", () => {
  // Whisper reports these as touching (a 10ms gap) - exactly the failure
  // mode that broke this feature. The live detector saw the words on either
  // side as two separate speech intervals with a 3200ms silence between.
  const words = [word("Hello", 0, 300), word("there", 310, 600)];
  const speechIntervals = [
    [0, 300],
    [3500, 3800],
  ];
  assert.equal(joinWordsWithPauses(words, speechIntervals), "Hello … there");
});

test("joinWordsWithPauses does not mark a gap shorter than the pause threshold", () => {
  const words = [word("Hello", 0, 300), word("there", 350, 600)];
  // Only 100ms between the speech-active stretches - not a pause.
  const speechIntervals = [
    [0, 300],
    [400, 600],
  ];
  const result = joinWordsWithPauses(words, speechIntervals);
  assert.equal(result, "Hello there");
  assert.ok(!result.includes("…"));
});

test("joinWordsWithPauses does not mark a gap that trackPauses would count as a pause but isn't a large one", () => {
  // 1700ms clears recorder.js's own PAUSE_MIN_MS (1200) - trackPauses would
  // count this as a real pause for pauseCount - but sits well under this
  // feature's higher ELLIPSIS_PAUSE_MIN_MS bar, which real-recording testing
  // showed is needed: most pauses right above 1200ms are ordinary breath or
  // word-boundary dips, not something a reader should see marked inline.
  const words = [word("Hello", 0, 300), word("there", 2000, 2300)];
  const speechIntervals = [
    [0, 300],
    [2000, 2300],
  ];
  const result = joinWordsWithPauses(words, speechIntervals);
  assert.equal(result, "Hello there");
  assert.ok(!result.includes("…"));
});

test("joinWordsWithPauses can mark more than one pause", () => {
  const words = [word("One", 0, 300), word("two", 3400, 3700), word("three", 7100, 7400)];
  const speechIntervals = [
    [0, 300],
    [3400, 3700],
    [7100, 7400],
  ];
  assert.equal(joinWordsWithPauses(words, speechIntervals), "One … two … three");
});

test("joinWordsWithPauses does not mark a pause before the first word or after the last", () => {
  const words = [word("Solo", 3500, 3800)];
  // A pause before the first word (response delay) and one after the last
  // (trailing silence) - neither has an adjacent word to attach to.
  const speechIntervals = [
    [3500, 3800],
    [7000, 7300],
  ];
  assert.equal(joinWordsWithPauses(words, speechIntervals), "Solo");
});

test("joinWordsWithPauses ignores whisper's own word gap entirely", () => {
  // A large gap by whisper's own timestamps, but the live detector recorded
  // continuous speech - not a real pause, so it must not be marked.
  const words = [word("Hello", 0, 300), word("there", 5000, 5300)];
  assert.equal(joinWordsWithPauses(words, [[0, 5300]]), "Hello there");
});

test("joinWordsWithPauses handles zero and one words", () => {
  assert.equal(joinWordsWithPauses([], [[0, 300]]), "");
  assert.equal(joinWordsWithPauses([word("Solo", 0, 300)], [[0, 300]]), "Solo");
});

test("joinWordsWithPauses handles no speechIntervals at all", () => {
  const words = [word("Hello", 0, 300), word("there", 350, 600)];
  assert.equal(joinWordsWithPauses(words), "Hello there");
});

// Whisper's real word timings either side of a known 4-second pause, from an
// answer recorded through the app (mic: speech until 19.8s, silent, resumes at
// 23.8s). "while we switched." were said before the pause but come back
// spread across it; "I" is timed exactly where speech resumed.
const smearedAcrossPause = [
  word("customer", 17740, 19190),
  word("running", 19190, 19760),
  word("while", 19760, 21370),
  word("we", 21370, 21730),
  word("switched.", 21730, 23760),
  word("I", 23780, 23860),
  word("learned", 23860, 24450),
  word("that", 24620, 24950),
];
const aroundPauseIntervals = [
  [15700, 19800],
  [23800, 27800],
];

test("joinWordsWithPauses puts the pause where speech resumed, not where whisper smeared the words before it", () => {
  assert.equal(
    joinWordsWithPauses(smearedAcrossPause, aroundPauseIntervals),
    "customer running while we switched. … I learned that"
  );
});

test("joinWordsWithPauses trusts a segment break inside the pause over word timings", () => {
  // The same answer with fan noise: whisper pulled "I" back almost a second
  // into the silence, but started a new segment at it.
  const words = [
    word("customer", 18890, 19610),
    word("running", 19610, 20910),
    word("while", 20910, 21580),
    word("we", 21580, 21850),
    word("switched.", 21850, 23000),
    { ...word("I", 23000, 23120), segmentStartMs: 23000 },
    word("learned", 23740, 23960),
    word("that", 23960, 24410),
  ];
  assert.equal(
    joinWordsWithPauses(words, [[15900, 19700], [23900, 27900]]),
    "customer running while we switched. … I learned that"
  );
  // Without the segment break the word timings alone get this one wrong -
  // which is why the break is trusted first.
  const noBreak = words.map(({ segmentStartMs, ...w }) => w);
  assert.notEqual(joinWordsWithPauses(noBreak, [[15900, 19700], [23900, 27900]]), "customer running while we switched. … I learned that");
});

test("joinWordsWithPauses ignores segment breaks nowhere near a pause", () => {
  const words = [
    word("One", 0, 300),
    { ...word("two", 400, 700), segmentStartMs: 400 },
    word("three", 4000, 4300),
  ];
  assert.equal(joinWordsWithPauses(words, [[0, 700], [4000, 4300]]), "One two … three");
});

test("computeWpm times the answer from first word to last, not the whole recording", () => {
  // 51 words; speech from 3.4s to 27.9s of a 30.5s recording - the known
  // answer that used to read as 100 wpm when it was spoken at 125.
  const { wpm, measuredOver } = computeWpm(51, [[3380, 13750], [15700, 19800], [23800, 27930]], 30515);
  assert.equal(Math.round(wpm), 125);
  assert.equal(measuredOver, "speech");
});

test("computeWpm falls back to the whole recording without a mic measurement", () => {
  assert.deepEqual(computeWpm(60, [], 60000), { wpm: 60, measuredOver: "recording" });
  // A sliver of detected speech isn't a span worth dividing by.
  assert.equal(computeWpm(60, [[0, 500]], 60000).measuredOver, "recording");
  assert.deepEqual(computeWpm(0, [[0, 5000]], 60000), { wpm: null, measuredOver: null });
});

test("computePaceRange rates each stretch between pauses, so a pause can't read as slow speech", () => {
  // Two stretches split by a 4s pause, 10 words then 12. Whisper smears the
  // last two words of the first across the pause; they still count there.
  const words = [
    ...Array.from({ length: 8 }, (_, i) => word(`a${i}`, i * 450, i * 450 + 400)),
    word("a8", 4200, 5500),
    word("a9", 5500, 7900),
    ...Array.from({ length: 12 }, (_, i) => word(`b${i}`, 8000 + i * 330, 8000 + i * 330 + 300)),
  ];
  const { minWpm, maxWpm } = computePaceRange(words, [[0, 4000], [8000, 12000]]);
  assert.equal(Math.round(minWpm), 150); // 10 words over 4s
  assert.equal(Math.round(maxWpm), 180); // 12 words over 4s
});

test("computePaceRange splits a long unbroken stretch into windows", () => {
  // 30s of continuous speech: 20 words in the first 20s, then 20 in the last 10.
  const words = [
    ...Array.from({ length: 20 }, (_, i) => word(`s${i}`, i * 1000, i * 1000 + 300)),
    ...Array.from({ length: 20 }, (_, i) => word(`f${i}`, 20000 + i * 500, 20000 + i * 500 + 300)),
  ];
  const { minWpm, maxWpm } = computePaceRange(words, [[0, 30000]]);
  assert.equal(Math.round(minWpm), 60);
  assert.equal(Math.round(maxWpm), 120);
});

test("computePaceRange shows nothing it can't back up", () => {
  const words = [word("one", 0, 300), word("two", 400, 700), word("three", 800, 1100)];
  // No mic measurement at all.
  assert.deepEqual(computePaceRange(words, []), { minWpm: null, maxWpm: null });
  // A single stretch too short to split: one rate isn't a range.
  assert.deepEqual(computePaceRange(words, [[0, 3000]]), { minWpm: null, maxWpm: null });
  // Stretches under 2s are too coarse to rate at all.
  assert.deepEqual(computePaceRange(words, [[0, 1500], [5000, 6000]]), { minWpm: null, maxWpm: null });
});

test("correctLegacyWpm takes the response delay out of old whole-recording figures, once", () => {
  const attempts = [
    { wpm: 100, durationMs: 30000, responseDelayMs: 6000 },
    { wpm: 90, durationMs: 30000, responseDelayMs: null },
    { wpm: 130, durationMs: 30000, responseDelayMs: 3000, wpmMeasuredOver: "speech" },
    { wpm: null, durationMs: 30000, responseDelayMs: 2000 },
  ];
  assert.equal(correctLegacyWpm(attempts), true);
  assert.equal(attempts[0].wpm, 125); // same words over 24s instead of 30s
  assert.equal(attempts[0].wpmMeasuredOver, "recording-minus-delay");
  assert.equal(attempts[1].wpm, 90); // nothing to take out
  assert.equal(attempts[1].wpmMeasuredOver, "recording");
  assert.equal(attempts[2].wpm, 130); // already measured the new way
  assert.equal(attempts[3].wpmMeasuredOver, undefined); // no wpm to correct
  assert.equal(correctLegacyWpm(attempts), false);
  assert.equal(attempts[0].wpm, 125);
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
