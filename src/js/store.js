const { Store } = window.__TAURI__.store;
const { videoDir, join } = window.__TAURI__.path;
const { mkdir, writeFile, exists } = window.__TAURI__.fs;

import { slugify } from "./util.js";

// The only categories a question can be tagged with (fixed sidebar tabs,
// not a user-extensible list) - kept here just to pre-create their folders
// on first launch, not as a shared source of truth used elsewhere.
const CATEGORIES = ["Behavioural", "Technical", "Case"];

// The one staple every real interview opens with - worth having on first
// launch so the question bank isn't completely empty. Everything else is
// left for the user to add themselves.
const STAPLE_QUESTION = { category: "Behavioural", text: "Tell me about yourself." };

const FOLDER_README = `This folder is managed by Flight Recorder - your practice recordings and data live here.

- library.json holds your questions, attempts, notes and scores. Don't rename it or edit it by hand.
- Each subfolder holds recordings for one category (Behavioural, Technical, Case).
- To move your data to a different computer: copy this whole folder into the Videos folder there, then launch the app - it picks everything up automatically, no import needed.

https://github.com/ei-sei/flight-recorder
`;

// Only written if missing, not overwritten on every launch - if the user's
// ever edited or removed it, that's their call, not something to stomp on.
async function ensureFolderReadme(dir) {
  const path = await join(dir, "README.txt");
  if (await exists(path)) return;
  await writeFile(path, new TextEncoder().encode(FOLDER_README));
}

// "Behavioral" was the category's original (American) spelling; anything
// already saved under it gets silently relabelled on next load rather than
// left stranded out of the renamed "Behavioural" tab/filter.
function migrateBehaviouralSpelling(records) {
  let changed = false;
  const migrated = records.map((record) => {
    if (record.category !== "Behavioral") return record;
    changed = true;
    return { ...record, category: "Behavioural" };
  });
  return { migrated, changed };
}

// Questions created before prep notes existed have no prepNotes key at all.
// Reading it with `?? ""` already covers that, but leaving the on-disk
// schema inconsistent forever (only backfilled the moment someone happens
// to edit it) is untidy - normalize it the same way the spelling migration
// above does, rather than relying on scattered read-time fallbacks.
function backfillPrepNotes(questions) {
  let changed = false;
  const migrated = questions.map((question) => {
    if (question.prepNotes !== undefined) return question;
    changed = true;
    return { ...question, prepNotes: "" };
  });
  return { migrated, changed };
}

let storePromise = null;

async function resolveStorePath() {
  const dir = await join(await videoDir(), "flight-recorder");
  await mkdir(dir, { recursive: true });

  // Pre-create each category's folder so Videos/flight-recorder/ looks
  // organized from the very first launch, rather than only growing a
  // category's folder the first time something is actually recorded under
  // it (computeVideoRelativePath in attempts.js still creates it lazily
  // too, so this is just about first impressions, not a hard dependency).
  for (const category of CATEGORIES) {
    await mkdir(await join(dir, slugify(category)), { recursive: true });
  }
  await ensureFolderReadme(dir);

  return join(dir, "library.json");
}

// The store used to live in the OS-hidden app-data directory - it now lives
// inside Videos/flight-recorder/ instead, alongside the video files it
// describes, so the whole folder is one portable, self-contained unit:
// copy it to a different machine (even a different OS) and the app just
// picks it up, no export/import step needed. Anyone who already had data
// under the old location gets it copied over once, including converting
// each attempt's absolute videoPath into one relative to this folder - an
// absolute path baked in on one machine/OS never resolves on another,
// which was the actual point of moving the store here in the first place.
async function migrateFromOldStoreLocation(newStore) {
  const alreadyHasData = await newStore.get("questions");
  if (alreadyHasData) return;

  let oldStore;
  try {
    oldStore = await Store.load("flight-recorder.json");
  } catch (err) {
    return; // no old store to migrate from
  }
  const oldQuestions = await oldStore.get("questions");
  if (!oldQuestions) return;

  const flightRecorderDir = await join(await videoDir(), "flight-recorder");
  const oldAttempts = (await oldStore.get("attempts")) ?? [];
  const migratedAttempts = oldAttempts.map((attempt) => {
    const { videoPath, ...rest } = attempt;
    if (!videoPath) return attempt;
    const relative = videoPath.startsWith(flightRecorderDir)
      ? videoPath.slice(flightRecorderDir.length).replace(/^[/\\]/, "")
      : videoPath;
    return { ...rest, videoRelativePath: relative };
  });

  await newStore.set("questions", oldQuestions);
  await newStore.set("attempts", migratedAttempts);
  for (const key of [
    "wpmEnabled",
    "recordingSettings",
    "theme",
    "prepNotesCollapsed",
    "prepNotesHeight",
    "whisperModelDownloaded",
  ]) {
    const value = await oldStore.get(key);
    if (value !== undefined) await newStore.set(key, value);
  }
  await newStore.save();
}

function getStore() {
  if (!storePromise) {
    storePromise = resolveStorePath()
      .then((path) => Store.load(path))
      .then(async (store) => {
        await migrateFromOldStoreLocation(store);
        return store;
      });
  }
  return storePromise;
}

export async function getQuestions() {
  const store = await getStore();
  const existing = await store.get("questions");
  if (existing) {
    const spelling = migrateBehaviouralSpelling(existing);
    const notes = backfillPrepNotes(spelling.migrated);
    if (spelling.changed || notes.changed) {
      await store.set("questions", notes.migrated);
      await store.save();
    }
    return notes.migrated;
  }

  const seeded = [
    {
      id: crypto.randomUUID(),
      category: STAPLE_QUESTION.category,
      text: STAPLE_QUESTION.text,
      createdAt: new Date().toISOString(),
      prepNotes: "",
    },
  ];
  await store.set("questions", seeded);
  await store.save();
  return seeded;
}

export async function saveQuestions(questions) {
  const store = await getStore();
  await store.set("questions", questions);
  await store.save();
}

export async function getAttempts() {
  const store = await getStore();
  const attempts = await store.get("attempts");
  if (!attempts) return [];

  const { migrated, changed } = migrateBehaviouralSpelling(attempts);
  if (changed) {
    await store.set("attempts", migrated);
    await store.save();
  }
  return migrated;
}

export async function saveAttempts(attempts) {
  const store = await getStore();
  await store.set("attempts", attempts);
  await store.save();
}

export async function getWpmEnabled() {
  const store = await getStore();
  const value = await store.get("wpmEnabled");
  return value ?? false;
}

export async function setWpmEnabled(enabled) {
  const store = await getStore();
  await store.set("wpmEnabled", enabled);
  await store.save();
}

// Mac/Linux only - whether the local Whisper speech model has already been
// downloaded. Purely a UX shortcut to skip re-prompting; the Rust side
// re-downloads transparently if the cached file is ever missing, so nothing
// depends on this staying accurate.
export async function getWhisperModelDownloaded() {
  const store = await getStore();
  const value = await store.get("whisperModelDownloaded");
  return value ?? false;
}

export async function setWhisperModelDownloaded(downloaded) {
  const store = await getStore();
  await store.set("whisperModelDownloaded", downloaded);
  await store.save();
}

export async function getRecordingSettings() {
  const store = await getStore();
  const value = await store.get("recordingSettings");
  return {
    cameraId: null,
    micId: null,
    quality: "480",
    alwaysOnTop: false,
    cameraEnabled: false,
    noiseSuppression: true,
    autoGainControl: true,
    ...value,
  };
}

export async function saveRecordingSettings(settings) {
  const store = await getStore();
  const current = await getRecordingSettings();
  await store.set("recordingSettings", { ...current, ...settings });
  await store.save();
}

export async function getPrepNotesCollapsed() {
  const store = await getStore();
  const value = await store.get("prepNotesCollapsed");
  return value ?? false;
}

export async function setPrepNotesCollapsed(collapsed) {
  const store = await getStore();
  await store.set("prepNotesCollapsed", collapsed);
  await store.save();
}

// null means "no custom height chosen yet" - use the built-in default.
export async function getPrepNotesHeight() {
  const store = await getStore();
  const value = await store.get("prepNotesHeight");
  return value ?? null;
}

export async function setPrepNotesHeight(height) {
  const store = await getStore();
  await store.set("prepNotesHeight", height);
  await store.save();
}

export async function getTheme() {
  const store = await getStore();
  const value = await store.get("theme");
  return value ?? "light";
}

export async function setTheme(theme) {
  const store = await getStore();
  await store.set("theme", theme);
  await store.save();
}

export async function clearAllData() {
  const store = await getStore();
  await store.set("questions", []);
  await store.set("attempts", []);
  await store.save();
}
