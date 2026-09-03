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
  "erm",
  "hmm",
  "um",
  "uh",
  "er",
  "ah",
  "like",
];

export function countFillers(text) {
  if (!text) return 0;
  const normalised = text.toLowerCase().replace(/[^a-z\s]/g, " ");
  let total = 0;
  let remaining = ` ${normalised.replace(/\s+/g, " ").trim()} `;
  for (const phrase of FILLER_PHRASES) {
    const pattern = new RegExp(`\\s${phrase}\\s`, "g");
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
