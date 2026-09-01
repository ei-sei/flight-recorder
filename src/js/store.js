const { Store } = window.__TAURI__.store;

// The one staple every real interview opens with - worth having on first
// launch so the question bank isn't completely empty. Everything else is
// left for the user to add themselves.
const STAPLE_QUESTION = { category: "Behavioral", text: "Tell me about yourself." };

let storePromise = null;

function getStore() {
  if (!storePromise) {
    storePromise = Store.load("flight-recorder.json");
  }
  return storePromise;
}

export async function getQuestions() {
  const store = await getStore();
  const existing = await store.get("questions");
  if (existing) return existing;

  const seeded = [
    {
      id: crypto.randomUUID(),
      category: STAPLE_QUESTION.category,
      text: STAPLE_QUESTION.text,
      createdAt: new Date().toISOString(),
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
  return attempts ?? [];
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

export async function getRecordingSettings() {
  const store = await getStore();
  const value = await store.get("recordingSettings");
  return { cameraId: null, micId: null, quality: "720", alwaysOnTop: false, ...value };
}

export async function saveRecordingSettings(settings) {
  const store = await getStore();
  const current = await getRecordingSettings();
  await store.set("recordingSettings", { ...current, ...settings });
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
