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
const MIN_SEGMENT_KEEP_RATIO = 0.25;

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

// Per-segment speaking rate, for the spread rather than the average - the
// average is already the headline WPM. Short segments are skipped: a
// two-word one second segment computes to a wild rate that says nothing
// about how someone was actually speaking.
const MIN_PACE_SEGMENT_MS = 2000;

export function computePaceRange(segments) {
  const rates = [];
  for (const segment of segments) {
    const durationMs = segment.endMs - segment.startMs;
    if (durationMs < MIN_PACE_SEGMENT_MS) continue;
    const words = countWords(segment.text);
    if (words === 0) continue;
    rates.push(words / (durationMs / 60000));
  }
  if (rates.length < 2) return { minWpm: null, maxWpm: null };
  return { minWpm: Math.min(...rates), maxWpm: Math.max(...rates) };
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
export function normaliseForTranscription(samples) {
  if (samples.length === 0) return samples;

  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms < SILENCE_RMS) return samples;

  const gain = Math.min(TARGET_RMS / rms, MAX_NORMALISE_GAIN);
  // Already at or above the target. Leaving it alone beats quietening it.
  if (gain <= 1) return samples;

  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return samples;
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
