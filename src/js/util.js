export function slugify(text) {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "question";
}

export function shortDateStamp(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

export function watermarkDateStamp(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy}`;
}

// Initials of each word, dropping single-letter words (like "a"/"I") so
// short connective words don't drown out the words that actually carry the
// question's meaning - "Describe a project you're proud of and why." becomes
// "dpypoaw" rather than a long slugified sentence.
export function abbreviateQuestion(text) {
  const initials = text
    .split(/\s+/)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((word) => word.length > 1)
    .map((word) => word[0])
    .join("");
  return initials.toLowerCase() || "q";
}

export function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatTimer(ms) {
  const totalTenths = Math.floor(ms / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function formatResponseDelay(ms) {
  if (ms === null || ms === undefined) return null;
  return `delay ${(ms / 1000).toFixed(1)}s`;
}

export function formatWpm(wpm) {
  if (wpm === null || wpm === undefined) return null;
  return `${Math.round(wpm)} wpm`;
}

export function countWords(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function formatPauses(count) {
  if (count === null || count === undefined) return null;
  return `${count} ${count === 1 ? "pause" : "pauses"}`;
}

export function formatLongestPause(ms) {
  if (!ms) return null;
  return `longest ${(ms / 1000).toFixed(1)}s`;
}

export function formatSpeakingRatio(ratio) {
  if (ratio === null || ratio === undefined) return null;
  return `${Math.round(ratio * 100)}% talking`;
}

// Hesitation markers, and the hedges people reach for while thinking. Ordered
// longest-first so "you know" is matched before "know" would be, and so the
// multi-word phrases can't be double-counted by their parts.
//
// Worth knowing: Whisper keeps fillers far better than a browser speech API
// does, but still inconsistently - it's transcribing for readability, not
// for stenographic accuracy. A zero here means "none survived
// transcription", not necessarily "none said", which is why the pause
// figures, measured straight off the mic, are the more trustworthy signal.
// Multi-word hedges. Matched literally, longest first so "you know" is
// consumed before anything could match a single word inside it.
//
// Bare "like" was on this list and is deliberately off it now. It is an
// ordinary verb and an ordinary preposition ("I like working in teams",
// "something like that"), so every one of those counted as a filler and
// inflated the total on answers containing none. Nothing replaces it:
// separating filler "like" from ordinary "like" needs the grammar around it,
// which this cannot see, and over-counting is worse than missing it - the
// number is shown bare, with nothing to signal it might be wrong.
const FILLER_PHRASES = [
  "you know",
  "i mean",
  "sort of",
  "kind of",
  "basically",
  "literally",
  "actually",
  "honestly",
  "obviously",
];

// Hesitation sounds, which people stretch out - "ummm", "errr", "uhhh" - and
// which Whisper transcribes with the stretch intact when it transcribes them
// at all. Every letter is therefore allowed to repeat, because matching these
// literally found "um" and missed "ummm", which is the form people actually
// produce when hesitating. Longest first for the same reason as above, so
// "erm" is consumed before "er" could take part of it.
const FILLER_INTERJECTIONS = ["erm", "hmm", "um", "uh", "er", "ah"];

// Whitespace-delimited either way, so "um" can't match inside "umbrella" and
// the elongated forms can't match inside a longer word either.
function fillerPattern(phrase, elongated) {
  const body = elongated
    ? phrase
        .split("")
        .map((letter) => `${letter}+`)
        .join("")
    : phrase;
  return new RegExp(`\\s${body}\\s`, "g");
}

export function countFillers(text) {
  if (!text) return 0;
  const normalised = text.toLowerCase().replace(/[^a-z\s]/g, " ");
  let total = 0;
  let remaining = ` ${normalised.replace(/\s+/g, " ").trim()} `;
  const patterns = [
    ...FILLER_PHRASES.map((phrase) => fillerPattern(phrase, false)),
    ...FILLER_INTERJECTIONS.map((phrase) => fillerPattern(phrase, true)),
  ];
  for (const pattern of patterns) {
    // Replaced as they're counted so a longer phrase's words can't also be
    // counted on their own. The single space keeps neighbouring words apart.
    remaining = remaining.replace(pattern, () => {
      total++;
      return " ";
    });
    // One pass can't catch back-to-back repeats ("um um") - the shared space
    // gets consumed by the first match, so sweep until nothing more is found.
    let previous;
    do {
      previous = remaining;
      remaining = remaining.replace(pattern, () => {
        total++;
        return " ";
      });
    } while (remaining !== previous);
  }
  return total;
}

// "1 question", "3 questions". Only handles nouns that pluralise with an s,
// which is all this app has.
export function pluralise(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatFillers(count) {
  if (count === null || count === undefined) return null;
  return `${count} ${count === 1 ? "filler" : "fillers"}`;
}

export function formatLongestStretch(ms) {
  if (!ms) return null;
  return `longest run ${Math.round(ms / 1000)}s`;
}

export function formatPaceRange(minWpm, maxWpm) {
  if (minWpm === null || minWpm === undefined) return null;
  if (maxWpm === null || maxWpm === undefined) return null;
  // A single usable segment gives min === max, which isn't a range and
  // shouldn't be dressed up as one - the plain average already says it.
  if (Math.round(minWpm) === Math.round(maxWpm)) return null;
  return `pace ${Math.round(minWpm)}-${Math.round(maxWpm)} wpm`;
}

// Whisper will happily invent fluent-sounding sentences over silence - a
// well-known failure mode, and one that lands straight in the word count and
// drags WPM with it. Its own no-speech probability isn't exposed by the Rust
// bindings, so cross-check against when the mic actually registered speech
// instead: an independent physical signal, and a better one. A segment is
// kept if it overlaps measured speech at all, which is deliberately generous
// - dropping words somebody really said would be far worse than keeping an
// occasional invented one.
//
// Below this share of segments surviving, the filter itself is treated as the
// unreliable party and skipped entirely - see the comment in the body.
//
// Was 0.25. Proven too low by a real recording (2:34, clean single-take
// interview answer, nothing hallucinated): whisper produced 23 correct
// segments, the live detector's speechIntervals only covered a sliver of the
// actual speaking time (recorded speakingRatio 1.4%), and the filter kept 8
// of 23 - 34.8%, comfortably past the old 25% floor, so the bypass never
// fired. It silently deleted 15 real segments, including the entire action
// section of the answer, with nothing to indicate anything was missing.
// 0.6 sits above that measured 34.8%, so a recording with this same failure
// mode is now caught. It doesn't fix the live detector itself - see the
// SPEECH_NOISE_MULTIPLIER comment in recorder.js - it only stops that
// detector's mistakes from being allowed to delete real words, which the
// function's own original design principle already called worse than
// keeping an occasional invented sentence.
const MIN_SEGMENT_KEEP_RATIO = 0.6;

export function rejectHallucinatedSegments(segments, speechIntervals) {
  if (!Array.isArray(speechIntervals) || speechIntervals.length === 0) return segments;
  const kept = segments.filter((segment) =>
    speechIntervals.some(([start, end]) => segment.startMs < end && segment.endMs > start)
  );
  // If the filter wants to drop nearly everything, the mic-level record is
  // what's wrong, not whisper - the sampling loop is clamped hard while the
  // window is hidden, so a recording made in the background leaves sparse
  // intervals that match almost nothing. Keeping the unfiltered segments
  // returns a real transcript instead of a blank one, which is the same
  // trade-off the "any overlap keeps the segment" rule already makes.
  if (segments.length > 0 && kept.length / segments.length < MIN_SEGMENT_KEEP_RATIO) return segments;
  return kept;
}

// NOT recorder.js's PAUSE_MIN_MS (1200) - deliberately higher, and this is
// the second time this constant has needed correcting, so the reasoning is
// worth spelling out. Pause *location* comes from speechIntervals (the live
// mic-level detector); it's the right signal (see the comment on
// joinWordsWithPauses for why whisper's own word gaps can't be trusted for
// this), but reusing trackPauses's own bar for what counts as "real" was
// still wrong. Tested directly against a real 166s recording that a user
// reported as full of ellipses on ordinary speech: the live detector's own
// pauseCount was 33, and simulating its algorithm tick-by-tick against the
// actual audio to get each pause's real duration showed why - 18 of them
// sat in a narrow 1200-1800ms band right above the detector's threshold,
// consistent with ordinary breath/word-boundary dips barely crossing it
// rather than real hesitation, with a second, greyer band up to about
// 2900ms. 3000ms clears both: it's also the rough point conversational-
// analysis research and interview coaching alike treat as where a silence
// stops reading as normal pacing and starts reading as "they paused" - a
// 1-2s gap while thinking is unremarkable, but a 3+ second one is what gets
// flagged. On that same recording, 3000ms leaves 3 marked pauses (the
// genuinely dramatic ones) instead of 33. pauseCount itself is left alone at
// 1200 - it's an aggregate a reader takes in as one number, where a slightly
// generous count costs little. An ellipsis is read one at a time inline in
// the transcript, where the same borderline detections read as constant
// hesitation instead.
const ELLIPSIS_PAUSE_MIN_MS = 3000;

// Whisper's word timestamps can't be trusted across a long silence, and they
// go wrong in both directions. Tested against an answer with a known 4s
// pause: in a quiet room "while we switched" came back spread over the whole
// 4 seconds while "I" landed exactly where speech restarted; with fan noise
// "I" was pulled back almost a second into the silence instead. And a real
// recording with a 37s pause had the words either side of it 0ms apart.
//
// What held up in every one of those runs is where whisper starts a new
// segment: right at the pause, with the words after the break being the ones
// said after it. So the far side of a pause is, in order of trust:
//   1. the first word of a segment that starts inside the pause
//   2. the first word timed where speech resumed
//   3. the first word timed after the pause began
// Words carry segmentStartMs on the first word of each segment (see
// transcribeAttemptInBackground in attempts.js).
const RESUME_TOLERANCE_MS = 500;

function firstWordAfterPause(words, from, gapStart, gapEnd) {
  let atBreak = -1;
  for (let i = Math.max(from, 1); i < words.length; i++) {
    const breakAt = words[i].segmentStartMs;
    if (breakAt === undefined) continue;
    if (breakAt > gapEnd + RESUME_TOLERANCE_MS) break;
    // Inside the silence, or just after it - whisper sometimes starts the
    // next segment a moment late, never before the pause began. The break
    // nearest where speech resumed wins if there's more than one.
    if (breakAt >= gapStart) atBreak = i;
  }
  if (atBreak !== -1) return atBreak;

  let resumed = from;
  while (resumed < words.length && words[resumed].startMs < gapEnd - RESUME_TOLERANCE_MS) resumed++;
  if (resumed < words.length) return resumed;
  let began = from;
  while (began < words.length && words[began].startMs < gapStart) began++;
  return began;
}

// Turns the live detector's speech-active stretches into the silences
// between them.
function pauseWindows(speechIntervals) {
  const windows = [];
  for (let i = 1; i < speechIntervals.length; i++) {
    const gapStart = speechIntervals[i - 1][1];
    const gapEnd = speechIntervals[i][0];
    if (gapEnd - gapStart >= ELLIPSIS_PAUSE_MIN_MS) windows.push([gapStart, gapEnd]);
  }
  return windows;
}

// Reconstructs the transcript from individual words rather than whole
// segments, marking a real pause wherever one falls - including inside a
// segment, and including the span where an entire segment was dropped by
// rejectHallucinatedSegments, which otherwise vanishes with nothing to show
// it was ever there. Segments are ~30s decode windows, not sentences, so a
// mid-answer hesitation the user actually wants to see would otherwise be
// invisible in the middle of one.
//
// Pause locations come from speechIntervals (real mic-level silence, see
// recorder.js), not from whisper's own word-to-word gap - see the comment on
// ELLIPSIS_PAUSE_MIN_MS above for why that gap can't be trusted. Whisper's
// word timestamps are used only to find which pair of words a real pause falls
// between - see firstWordAfterPause for how, since they drift around a
// silence. A pause before the first surviving word or after the last isn't
// marked - there's no adjacent word to attach it to, and the response delay
// and any trailing silence are already measured elsewhere.
export function joinWordsWithPauses(words, speechIntervals = []) {
  if (words.length === 0) return "";
  const pauseBeforeWord = new Set();
  let wordIdx = 0;
  for (const [gapStart, gapEnd] of pauseWindows(speechIntervals)) {
    wordIdx = firstWordAfterPause(words, wordIdx, gapStart, gapEnd);
    if (wordIdx > 0 && wordIdx < words.length) pauseBeforeWord.add(wordIdx);
  }

  let out = words[0].text;
  for (let i = 1; i < words.length; i++) {
    out += pauseBeforeWord.has(i) ? " … " : " ";
    out += words[i].text;
  }
  return out;
}

// Must match PAUSE_MIN_MS in recorder.js: a silence this long is a pause, the
// same definition the review screen's pause count uses. Anything shorter -
// a breath, a gap between sentences - is part of speaking.
const PAUSE_MIN_MS = 1200;
// Shorter than this, the timing is too coarse to be worth a rate: a two-word,
// one-second stretch computes to a wild number that says nothing about how
// someone was actually speaking.
const MIN_PACE_WINDOW_MS = 2000;
// A long unbroken stretch is split into windows about this long, so an answer
// with few real pauses still shows whether it sped up. Inside continuous
// speech whisper's word timing is sound; it only drifts across silences.
const PACE_WINDOW_MS = 10000;

// The live detector's speech-active intervals, joined into the stretches
// between real pauses.
export function speechStretches(speechIntervals = []) {
  const stretches = [];
  for (const [start, end] of speechIntervals) {
    const last = stretches.at(-1);
    if (last && start - last[1] < PAUSE_MIN_MS) last[1] = end;
    else stretches.push([start, end]);
  }
  return stretches;
}

// Words per minute from the first word to the last, as the mic heard them.
// It used to divide by the whole recording, which counted the thinking time
// before the first word and the silence before Stop as if they were slow
// speech: tested against an answer spoken at 125 wpm it reported 100, and the
// longer someone thought before answering, the slower they looked. Falls back
// to the whole recording only when the mic measurement isn't there.
const MIN_SPEECH_SPAN_MS = 2000;

export function computeWpm(wordCount, speechIntervals = [], durationMs = 0) {
  if (!wordCount) return { wpm: null, measuredOver: null };
  const span = speechIntervals.length ? speechIntervals.at(-1)[1] - speechIntervals[0][0] : 0;
  if (span >= MIN_SPEECH_SPAN_MS) return { wpm: wordCount / (span / 60000), measuredOver: "speech" };
  if (durationMs > 0) return { wpm: wordCount / (durationMs / 60000), measuredOver: "recording" };
  return { wpm: null, measuredOver: null };
}

// The spread of speaking rates across an answer, for "rushed the end" -
// the average is already the headline WPM. Each stretch between real pauses
// is timed by the mic and gets the words spoken in it, so a pause can't count
// as slow speech. (It used to rate whisper's own segments, which often
// contain a pause: the same known answer came back 50-147, 90-116 and 72-120
// on three runs when it was actually spoken at a steady 156-173.) Without
// the mic measurement there's no honest way to do this, so nothing is shown.
export function computePaceRange(words = [], speechIntervals = []) {
  const none = { minWpm: null, maxWpm: null };
  const stretches = speechStretches(speechIntervals);
  if (stretches.length === 0 || words.length === 0) return none;

  // Index of the first word in each stretch.
  const firstWord = [0];
  for (let i = 1; i < stretches.length; i++) {
    firstWord.push(firstWordAfterPause(words, firstWord[i - 1], stretches[i - 1][1], stretches[i][0]));
  }

  const rates = [];
  stretches.forEach(([start, end], i) => {
    const stretchWords = words.slice(firstWord[i], firstWord[i + 1] ?? words.length);
    const windows = Math.max(1, Math.round((end - start) / PACE_WINDOW_MS));
    const windowMs = (end - start) / windows;
    if (windowMs < MIN_PACE_WINDOW_MS) return;
    const counts = new Array(windows).fill(0);
    for (const word of stretchWords) {
      // Clamped: a word whisper timed just outside its stretch still belongs
      // to it, by the assignment above.
      const at = Math.min(Math.max(word.startMs, start), end - 1);
      counts[Math.min(windows - 1, Math.floor((at - start) / windowMs))]++;
    }
    for (const count of counts) if (count > 0) rates.push(count / (windowMs / 60000));
  });
  if (rates.length < 2) return none;
  return { minWpm: Math.min(...rates), maxWpm: Math.max(...rates) };
}

// Attempts from before the fix above had their WPM divided by the whole
// recording. Their mic timing wasn't kept, so the best correction available
// is to take out the response delay they did store - the thinking time, by
// far the bigger of the two silences that skewed it. Marked, so it's only
// ever applied once. Returns whether anything changed.
export function correctLegacyWpm(attempts) {
  let changed = false;
  for (const attempt of attempts) {
    if (attempt.wpm == null || attempt.wpmMeasuredOver) continue;
    changed = true;
    const span = attempt.durationMs - (attempt.responseDelayMs ?? 0);
    if (attempt.responseDelayMs != null && span >= MIN_SPEECH_SPAN_MS) {
      attempt.wpm = (attempt.wpm * attempt.durationMs) / span;
      attempt.wpmMeasuredOver = "recording-minus-delay";
    } else {
      attempt.wpmMeasuredOver = "recording";
    }
  }
  return changed;
}

// Level whisper is handed, as RMS across the whole recording. Speech at a
// comfortable listening level sits near here; the exact figure matters far
// less than not handing it something almost silent.
const TARGET_RMS = 0.1;
// Ceiling on how much the signal may be lifted. Without it a near-silent
// recording gets its noise floor amplified to full scale, and whisper invents
// fluent sentences over the result - the very failure
// rejectHallucinatedSegments exists to catch, so better not to manufacture it.
const MAX_NORMALISE_GAIN = 30;
// Below this there is no signal worth lifting, only noise.
const SILENCE_RMS = 1e-4;

// Lifts quiet audio to a level whisper can work with. Mutates in place - the
// buffer is millions of samples and is thrown away straight afterwards.
//
// This replaces the microphone's auto gain control, which used to do the same
// job during capture at the cost of flattening the recording itself. Doing it
// here means the saved video keeps the real dynamics of the voice, and only
// the copy whisper sees gets levelled. Turning AGC off *without* this made
// quiet microphones transcribe to nothing at all, silently - so the two are
// coupled: if this ever goes, auto gain control has to come back on.
//
// RMS rather than peak: one door slam or chair scrape would hold a peak-based
// gain right down, whereas RMS tracks how loud the speech actually is. The
// clamp afterwards means such a transient simply clips, which a speech model
// does not care about.
// Returns { rms, gain } describing what it found and what it did. The caller
// logs these: how quiet the microphone actually is, is otherwise guesswork,
// and guessing is a bad way to decide whether a recording needs more gain at
// the hardware, at the OS, or in this app.
export function normaliseForTranscription(samples) {
  if (samples.length === 0) return { rms: 0, gain: 1 };

  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms < SILENCE_RMS) return { rms, gain: 1 };

  const gain = Math.min(TARGET_RMS / rms, MAX_NORMALISE_GAIN);
  // Already at or above the target. Leaving it alone beats quietening it.
  if (gain <= 1) return { rms, gain: 1 };

  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return { rms, gain };
}

// RMS as dBFS, which is the unit microphone levels are actually discussed in.
// Speech recorded at a healthy level sits around -20; below about -40 the
// signal is weak enough that boosting it also boosts the room.
export function dbfs(rms) {
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms);
}

export function autosizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// A real tab character, not spaces - tabs snap to a fixed column position
// regardless of what precedes them, so lines with differently-sized labels
// still line up. Plain spaces can't do that.
const TAB_INDENT = "\t";

// Tab normally jumps focus to the next control - for a notes field, typing
// an indent is more useful. Shift+Tab is left alone (normal focus-back).
export function enableTabIndent(el) {
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || event.shiftKey) return;
    event.preventDefault();
    const { selectionStart, selectionEnd, value } = el;
    el.value = value.slice(0, selectionStart) + TAB_INDENT + value.slice(selectionEnd);
    el.selectionStart = el.selectionEnd = selectionStart + TAB_INDENT.length;
  });
}

export function renderStars(container, score, onChange, readOnly = false) {
  container.innerHTML = "";
  container.classList.toggle("readonly", readOnly);
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("button");
    star.type = "button";
    star.className = "star" + (i <= score ? " filled" : "");
    star.textContent = i <= score ? "★" : "☆";
    star.title = `${i} star${i === 1 ? "" : "s"}`;
    if (readOnly) {
      star.disabled = true;
    } else {
      star.addEventListener("click", () => onChange(i === score ? 0 : i));
    }
    container.appendChild(star);
  }
}
