const { Store } = window.__TAURI__.store;

const DEFAULT_QUESTIONS = [
  { category: "Behavioral", text: "Tell me about a time you disagreed with a teammate." },
  { category: "Behavioral", text: "Describe a project you're proud of and why." },
  { category: "Technical", text: "Explain how a hash map works under the hood." },
  { category: "Technical", text: "How would you design a URL shortener?" },
  { category: "Case", text: "Estimate the number of piano tuners in Chicago." },
  { category: "Case", text: "A client's revenue is declining. How do you investigate why?" },
];

let storePromise = null;

function getStore() {
  if (!storePromise) {
    storePromise = Store.load("flight-recorder.json");
  }
  return storePromise;
}

function makeId() {
  return crypto.randomUUID();
}

export async function getQuestions() {
  const store = await getStore();
  const existing = await store.get("questions");
  if (existing && existing.length > 0) {
    return existing;
  }

  const seeded = DEFAULT_QUESTIONS.map((q) => ({
    id: makeId(),
    category: q.category,
    text: q.text,
    createdAt: new Date().toISOString(),
  }));
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

export async function clearAllData() {
  const store = await getStore();
  await store.set("questions", []);
  await store.set("attempts", []);
  await store.save();
}
