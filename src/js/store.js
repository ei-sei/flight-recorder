import { Store, videoDir, join, mkdir, writeFile, exists } from "./platform.js";
import { correctLegacyWpm, dropLegacyPaceRanges } from "./util.js";

// A fresh install starts with one category - easier to see every question
// you have while the bank is small, with "add a category" there for anyone
// who wants the old Behavioural/Technical/Case split back. An existing
// library's categories are migrated as data instead (migrateCategories
// below), not reset to this.
const DEFAULT_CATEGORY_NAME = "General";

// The one staple every real interview opens with - worth having on first
// launch so the question bank isn't completely empty. Everything else is
// left for the user to add themselves.
const STAPLE_QUESTION_TEXT = "Tell me about yourself.";

const FOLDER_README = `This folder is managed by Flight Recorder - your practice recordings and data live here.

- library.json holds your questions, attempts, notes and scores. Don't rename it or edit it by hand.
- Each subfolder holds recordings for one of your question categories.
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

// Categories used to be a fixed three (Behavioural, Technical, Case) baked
// into the UI itself - a question just carried one of those names as a plain
// string, the same as attempt.category still does. Now they're a
// user-managed list, each with a stable id, so a rename never has to touch
// every question that was in it (the same reason attempt file names dropped
// the question's initials - anything that can change later shouldn't be
// what other data is keyed on). `existingCategories` is `library.categories`
// as read from disk; its presence, not its contents, is what says whether
// this library has already been migrated - an empty array still counts (see
// deleteCategory, which refuses to ever empty it completely).
//
// Every question here is expected to carry a plain `category` string still
// (this only ever runs once, before anything is migrated), so the categories
// it creates are built from whatever distinct names appear, in the order
// they're first seen - for every library saved before this change, that's
// Behavioural/Technical/Case in that order, the only three strings that
// could appear, so an existing user's tabs look exactly as they did before,
// just editable now.
function migrateCategories(questions, existingCategories) {
  if (existingCategories) return { categories: existingCategories, migrated: questions, changed: false };

  const categories = [];
  const idByName = new Map();
  const migrated = questions.map(({ category, ...question }) => {
    const name = category || DEFAULT_CATEGORY_NAME;
    let id = idByName.get(name);
    if (id === undefined) {
      id = crypto.randomUUID();
      idByName.set(name, id);
      categories.push({ id, name });
    }
    return { ...question, categoryId: id };
  });
  if (categories.length === 0) categories.push({ id: crypto.randomUUID(), name: DEFAULT_CATEGORY_NAME });
  return { categories, migrated, changed: true };
}

let storePromise = null;

// The one definition of where the library lives. This was rebuilt
// independently in four places (here, migrateFromOldStoreLocation,
// resolveVideoPath in attempts.js, and twice in main.js), which is exactly
// the coupling the portable-folder design depends on not drifting. Lives in
// store.js rather than util.js because util.js is deliberately free of shell
// calls (platform.js) so it can be unit tested under plain node.
export async function libraryDir() {
  return join(await videoDir(), "flight-recorder");
}

async function resolveStorePath() {
  const dir = await libraryDir();
  await mkdir(dir, { recursive: true });
  await ensureFolderReadme(dir);

  // Categories used to be a fixed three, pre-created here so
  // Videos/flight-recorder/ looked organized from the first launch. Now
  // they're user-defined and not known until the store itself is read, so
  // that's gone - computeVideoRelativePath in attempts.js still creates a
  // category's folder lazily, the first time something is actually recorded
  // under it, which is all this ever did beyond first impressions.

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

  const flightRecorderDir = await libraryDir();
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
    // whisperModelDownloaded was migrated here too. It isn't any more - the
    // model's presence is read from the filesystem now, so carrying a stale
    // copy of that answer forward would only reintroduce the drift.
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

// The one place questions (and with them, categories - see migrateCategories)
// are loaded and migrated. getCategories() below deliberately routes through
// here rather than duplicating that, so it's correct regardless of which one
// a caller reaches for first.
export async function getQuestions() {
  const store = await getStore();
  const existing = await store.get("questions");
  if (existing) {
    const spelling = migrateBehaviouralSpelling(existing);
    const notes = backfillPrepNotes(spelling.migrated);
    const existingCategories = await store.get("categories");
    const cats = migrateCategories(notes.migrated, existingCategories);
    if (spelling.changed || notes.changed || cats.changed) {
      await store.set("questions", cats.migrated);
      await store.set("categories", cats.categories);
      await store.save();
    }
    return cats.migrated;
  }

  const categoryId = crypto.randomUUID();
  const seeded = [
    {
      id: crypto.randomUUID(),
      categoryId,
      text: STAPLE_QUESTION_TEXT,
      createdAt: new Date().toISOString(),
      prepNotes: "",
    },
  ];
  await store.set("categories", [{ id: categoryId, name: DEFAULT_CATEGORY_NAME }]);
  await store.set("questions", seeded);
  await store.save();
  return seeded;
}

export async function saveQuestions(questions) {
  const store = await getStore();
  await store.set("questions", questions);
  await store.save();
}

export async function getCategories() {
  await getQuestions(); // ensures categories exist and are migrated, see above
  const store = await getStore();
  return (await store.get("categories")) ?? [];
}

export async function saveCategories(categories) {
  const store = await getStore();
  await store.set("categories", categories);
  await store.save();
}

export async function getAttempts() {
  const store = await getStore();
  const attempts = await store.get("attempts");
  if (!attempts) return [];

  const { migrated, changed } = migrateBehaviouralSpelling(attempts);
  // WPM used to be divided by the whole recording, and the pace spread
  // counted pauses as slow speech; see correctLegacyWpm and
  // dropLegacyPaceRanges. The pace check runs second: it relies on the mark
  // correctLegacyWpm leaves.
  const wpmCorrected = correctLegacyWpm(migrated);
  const paceDropped = dropLegacyPaceRanges(migrated);
  if (changed || wpmCorrected || paceDropped) {
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

// There was a getWhisperModelDownloaded/setWhisperModelDownloaded pair here,
// storing whether the speech model had been fetched. It is gone on purpose.
//
// This store lives in Videos/flight-recorder, and the model lives in the OS
// app-data directory, so the flag and the file it described could be removed
// independently - and were. Deleting app data took the model but left the flag
// saying it was present, which skipped the download confirmation dialog and
// let the next recording pull 60MB down unannounced. The `whisper_model_present`
// command asks the filesystem instead, which cannot disagree with itself.

export async function getRecordingSettings() {
  const store = await getStore();
  const value = await store.get("recordingSettings");
  return {
    cameraId: null,
    micId: null,
    quality: "480",
    alwaysOnTop: false,
    cameraEnabled: false,
    // Makeup gain in dB, applied to the recording as one constant multiplier.
    // Boosted by default because capture no longer applies auto gain control,
    // and without it most microphones record noticeably quieter than they
    // used to - AGC was what made the old recordings loud. Unlike AGC this is
    // static, so it lifts the whole recording without flattening it.
    //
    // +18 rather than +12: measured on a USB-C headset mic, +18 still left
    // speech around -31 dBFS with peaks near -10 and no clipping, so +12 was
    // recording quieter than it needed to. A hot USB desk mic could clip at
    // +18 - the setting's own note says to turn it down if loud audio
    // distorts, and a stored choice always wins over this default.
    micGainDb: 18,
    ...value,
  };
}

// Serialised. This is a read-modify-write, and several callers fire it without
// awaiting (the camera toggle, for one), so two overlapping calls could each
// read the same `current` and the second would write back the first's field as
// it was before the change - silently losing it. Chaining costs nothing here
// and makes the last writer win on a whole-object basis rather than by luck.
let recordingSettingsWrite = Promise.resolve();

export function saveRecordingSettings(settings) {
  const write = recordingSettingsWrite.then(async () => {
    const store = await getStore();
    const current = await getRecordingSettings();
    await store.set("recordingSettings", { ...current, ...settings });
    await store.save();
  });
  // The chain keeps a swallowed copy so one failed write can't reject every
  // write that queues behind it. The caller still gets the real promise.
  recordingSettingsWrite = write.catch(() => {});
  return write;
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
