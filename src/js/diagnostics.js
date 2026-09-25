// Keeps the app's recent console output - errors, warnings and the info lines
// it logs about itself (transcription timing, input level, recording mode) -
// so Help > Debug info can show what went wrong without anyone having to
// open developer tools. Memory only, never written anywhere, and gone when
// the app closes.
//
// Imported first in main.js, with no imports of its own, so it's listening
// before any other module has run and can catch errors from startup.

const MAX_ENTRIES = 200;
const MAX_ENTRY_LENGTH = 600;
const entries = [];

function describe(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (value instanceof MediaError) return `MediaError ${value.code}${value.message ? `: ${value.message}` : ""}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function record(level, args) {
  const text = args.map(describe).join(" ");
  entries.push({ time: new Date(), level, text: text.length > MAX_ENTRY_LENGTH ? `${text.slice(0, MAX_ENTRY_LENGTH)}…` : text });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

for (const level of ["error", "warn", "info"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    record(level, args);
    original(...args);
  };
}

window.addEventListener("error", (event) => {
  record("error", [`Uncaught ${event.message}${event.filename ? ` (${event.filename.split("/").pop()}:${event.lineno})` : ""}`]);
});
window.addEventListener("unhandledrejection", (event) => {
  record("error", ["Unhandled rejection:", event.reason]);
});

// Oldest first: { time: Date, level: "error" | "warn" | "info", text }.
export function recentLog() {
  return entries.slice();
}
