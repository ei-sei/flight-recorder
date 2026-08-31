import { formatTimer, formatDuration, renderStars } from "./util.js";
import { getWpmEnabled, setWpmEnabled, getRecordingSettings, saveRecordingSettings } from "./store.js";

const previewEl = document.getElementById("preview");
const viewfinderMetaEl = document.getElementById("viewfinder-meta");
const viewfinderMetaInfoEl = document.getElementById("viewfinder-meta-info");
const viewfinderMetaStarsEl = document.getElementById("viewfinder-meta-stars");
const viewfinderEl = document.querySelector(".viewfinder");
const viewfinderEmptyEl = document.getElementById("viewfinder-empty");
const recIndicatorEl = document.getElementById("rec-indicator");
const reviewIndicatorEl = document.getElementById("review-indicator");
const timerEl = document.getElementById("timer");
const recordBtn = document.getElementById("record-btn");
const backToLiveBtn = document.getElementById("back-to-live-btn");
const currentQuestionEl = document.getElementById("current-question");
const reviewNotesRow = document.getElementById("review-notes-row");
const reviewNotesInput = document.getElementById("review-notes-input");
const liveReadoutsEl = document.getElementById("live-readouts");
const readoutDelayEl = document.getElementById("readout-delay");
const readoutWpmEl = document.getElementById("readout-wpm");
const wpmToggleRow = document.getElementById("wpm-toggle-row");
const wpmToggleInput = document.getElementById("wpm-toggle-input");
const wpmToggleHint = document.getElementById("wpm-toggle-hint");

const { readFile } = window.__TAURI__.fs;

const SPEECH_RMS_THRESHOLD = 0.02;
const SPEECH_SUSTAIN_MS = 150;
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

let stream = null;
let mediaRecorder = null;
let chunks = [];
let recordStartTs = 0;
let timerInterval = null;
let hasSelection = false;
let onRecordingComplete = () => {};
let getSelectedQuestion = () => null;

let audioCtx = null;
let analyser = null;
let volumeData = null;
let volumeRafId = null;
let speechAboveThresholdSinceTs = null;
let responseDelayMs = null;

let wpmEnabled = false;
let speechRecognizer = null;
let transcript = "";
let wpm = null;

let isReviewing = false;
let reviewObjectUrl = null;
let onExitReview = () => {};
let onNotesChange = () => {};
let onScoreChange = () => {};

let currentQuality = "720";

const QUALITY_PRESETS = {
  720: { width: 1280, height: 720, bitrate: 2_500_000 },
  1080: { width: 1920, height: 1080, bitrate: 5_000_000 },
};

function getQualityPreset() {
  return QUALITY_PRESETS[currentQuality] ?? QUALITY_PRESETS["720"];
}

async function acquireStream(cameraId, micId, quality) {
  const preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS["720"];
  const constraints = {
    video: {
      deviceId: cameraId ? { exact: cameraId } : undefined,
      width: { ideal: preset.width },
      height: { ideal: preset.height },
    },
    audio: {
      deviceId: micId ? { exact: micId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };

  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (cameraId || micId) {
      console.error("Failed to use selected device, falling back to default", err);
      constraints.video.deviceId = undefined;
      constraints.audio.deviceId = undefined;
      return navigator.mediaDevices.getUserMedia(constraints);
    }
    throw err;
  }
}

async function initCamera() {
  const settings = await getRecordingSettings();
  currentQuality = settings.quality;

  try {
    stream = await acquireStream(settings.cameraId, settings.micId, currentQuality);
    previewEl.srcObject = stream;
    viewfinderEmptyEl.hidden = true;
  } catch (err) {
    viewfinderEmptyEl.textContent = "Camera access denied or unavailable.";
    console.error("Failed to access camera/microphone", err);
  }
  updateRecordButtonState();
}

export async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: devices.filter((d) => d.kind === "videoinput"),
    mics: devices.filter((d) => d.kind === "audioinput"),
  };
}

export async function applyRecordingSettings({ cameraId, micId, quality }) {
  currentQuality = quality;
  await saveRecordingSettings({ cameraId, micId, quality });

  if (mediaRecorder && mediaRecorder.state === "recording") {
    return; // don't disrupt an in-progress recording; takes effect on the next one
  }

  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }

  stream = await acquireStream(cameraId, micId, quality);
  previewEl.srcObject = stream;
  viewfinderEmptyEl.hidden = true;
  updateRecordButtonState();
}

function updateRecordButtonState() {
  const recording = mediaRecorder && mediaRecorder.state === "recording";
  recordBtn.disabled = isReviewing || (!recording && (!hasSelection || !stream));
}

function updateTimer() {
  timerEl.textContent = formatTimer(Date.now() - recordStartTs);
}

function pollVolume() {
  analyser.getFloatTimeDomainData(volumeData);
  let sumSquares = 0;
  for (let i = 0; i < volumeData.length; i++) {
    sumSquares += volumeData[i] * volumeData[i];
  }
  const rms = Math.sqrt(sumSquares / volumeData.length);

  if (responseDelayMs === null) {
    const now = Date.now();
    if (rms > SPEECH_RMS_THRESHOLD) {
      if (speechAboveThresholdSinceTs === null) {
        speechAboveThresholdSinceTs = now;
      } else if (now - speechAboveThresholdSinceTs >= SPEECH_SUSTAIN_MS) {
        responseDelayMs = speechAboveThresholdSinceTs - recordStartTs;
        readoutDelayEl.textContent = `delay ${(responseDelayMs / 1000).toFixed(1)}s`;
      }
    } else {
      speechAboveThresholdSinceTs = null;
    }
  }

  volumeRafId = requestAnimationFrame(pollVolume);
}

function startResponseDelayDetection() {
  responseDelayMs = null;
  speechAboveThresholdSinceTs = null;
  readoutDelayEl.textContent = "delay —";

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  volumeData = new Float32Array(analyser.fftSize);
  source.connect(analyser);

  pollVolume();
}

function stopResponseDelayDetection() {
  if (volumeRafId !== null) {
    cancelAnimationFrame(volumeRafId);
    volumeRafId = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}

function countWords(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function startSpeechPaceTracking() {
  transcript = "";
  wpm = null;
  readoutWpmEl.hidden = false;
  readoutWpmEl.textContent = "wpm —";

  speechRecognizer = new SpeechRecognitionImpl();
  speechRecognizer.continuous = true;
  speechRecognizer.interimResults = true;
  speechRecognizer.lang = "en-US";

  speechRecognizer.onresult = (event) => {
    let combined = "";
    for (let i = 0; i < event.results.length; i++) {
      combined += event.results[i][0].transcript + " ";
    }
    transcript = combined.trim();

    const elapsedMinutes = (Date.now() - recordStartTs) / 60000;
    if (elapsedMinutes > 0) {
      wpm = countWords(transcript) / elapsedMinutes;
      readoutWpmEl.textContent = `${Math.round(wpm)} wpm`;
    }
  };
  speechRecognizer.onerror = (event) => {
    console.error("Speech recognition error", event.error);
  };

  speechRecognizer.start();
}

function stopSpeechPaceTracking() {
  if (speechRecognizer) {
    speechRecognizer.onresult = null;
    speechRecognizer.onerror = null;
    speechRecognizer.stop();
    speechRecognizer = null;
  }
  readoutWpmEl.hidden = true;
}

function startRecording() {
  if (!stream) return;

  chunks = [];
  mediaRecorder = new MediaRecorder(stream, {
    mimeType: "video/webm",
    videoBitsPerSecond: getQualityPreset().bitrate,
    audioBitsPerSecond: 128_000,
  });
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  mediaRecorder.onstop = handleStop;
  mediaRecorder.start();

  recordStartTs = Date.now();
  recIndicatorEl.hidden = false;
  timerEl.textContent = "00:00.0";
  timerInterval = setInterval(updateTimer, 100);
  recordBtn.textContent = "Stop";
  recordBtn.classList.add("recording");
  viewfinderEl.classList.add("recording");

  liveReadoutsEl.hidden = false;
  startResponseDelayDetection();

  if (wpmEnabled && SpeechRecognitionImpl) {
    startSpeechPaceTracking();
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

async function handleStop() {
  clearInterval(timerInterval);
  stopResponseDelayDetection();
  if (wpmEnabled && SpeechRecognitionImpl) {
    stopSpeechPaceTracking();
  }
  recIndicatorEl.hidden = true;
  liveReadoutsEl.hidden = true;
  timerEl.textContent = "00:00.0";
  recordBtn.textContent = "Record";
  recordBtn.classList.remove("recording");
  viewfinderEl.classList.remove("recording");
  updateRecordButtonState();

  const durationMs = Date.now() - recordStartTs;
  const blob = new Blob(chunks, { type: "video/webm" });
  const question = getSelectedQuestion();
  if (question) {
    await onRecordingComplete({
      blob,
      durationMs,
      question,
      responseDelayMs,
      wpm: wpmEnabled ? wpm : null,
      transcript: wpmEnabled ? transcript : null,
    });
  }
}

function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    stopRecording();
  } else {
    startRecording();
  }
}

export function setRecordEnabled(enabled) {
  hasSelection = enabled;
  updateRecordButtonState();
}

function renderReviewStars(attemptId, score) {
  renderStars(viewfinderMetaStarsEl, score, (newScore) => {
    onScoreChange(attemptId, newScore);
    renderReviewStars(attemptId, newScore);
  });
}

export async function enterReviewMode(attempt, attemptNumber) {
  if (mediaRecorder && mediaRecorder.state === "recording") return;

  if (reviewObjectUrl) {
    URL.revokeObjectURL(reviewObjectUrl);
    reviewObjectUrl = null;
  }

  const bytes = await readFile(attempt.videoPath);
  reviewObjectUrl = URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));

  isReviewing = true;
  previewEl.srcObject = null;
  previewEl.src = reviewObjectUrl;
  previewEl.muted = false;
  previewEl.controls = true;
  previewEl.play().catch(() => {});

  viewfinderEmptyEl.hidden = true;
  viewfinderEl.classList.add("reviewing");
  reviewIndicatorEl.hidden = false;
  timerEl.hidden = true;
  wpmToggleRow.hidden = true;
  recordBtn.hidden = true;
  backToLiveBtn.hidden = false;
  currentQuestionEl.textContent = `Reviewing: “${attempt.questionText}”`;

  const dateLabel = new Date(attempt.date).toLocaleDateString();
  viewfinderMetaInfoEl.textContent = `Attempt ${attemptNumber} · ${dateLabel} · ${attempt.category} · Duration: ${formatDuration(attempt.durationMs)}`;
  renderReviewStars(attempt.id, attempt.score);
  viewfinderMetaEl.hidden = false;
  viewfinderMetaStarsEl.hidden = false;

  reviewNotesRow.hidden = false;
  reviewNotesInput.value = attempt.notes;
  reviewNotesInput.onblur = () => onNotesChange(attempt.id, reviewNotesInput.value);

  updateRecordButtonState();
}

export function exitReviewMode() {
  if (!isReviewing) return;

  isReviewing = false;
  previewEl.controls = false;
  previewEl.removeAttribute("src");
  previewEl.load();
  previewEl.muted = true;
  previewEl.srcObject = stream;

  if (reviewObjectUrl) {
    URL.revokeObjectURL(reviewObjectUrl);
    reviewObjectUrl = null;
  }

  viewfinderEmptyEl.hidden = Boolean(stream);
  viewfinderEl.classList.remove("reviewing");
  reviewIndicatorEl.hidden = true;
  timerEl.hidden = false;
  wpmToggleRow.hidden = false;
  recordBtn.hidden = false;
  backToLiveBtn.hidden = true;

  reviewNotesRow.hidden = true;
  reviewNotesInput.onblur = null;
  viewfinderMetaEl.hidden = true;
  viewfinderMetaStarsEl.hidden = true;

  updateRecordButtonState();
  onExitReview();
}

async function initWpmToggle() {
  if (!SpeechRecognitionImpl) {
    wpmToggleInput.disabled = true;
    wpmToggleRow.classList.add("unavailable");
    wpmToggleHint.textContent = "Not available on this platform's webview.";
    return;
  }

  wpmEnabled = await getWpmEnabled();
  wpmToggleInput.checked = wpmEnabled;

  wpmToggleInput.addEventListener("change", () => {
    wpmEnabled = wpmToggleInput.checked;
    setWpmEnabled(wpmEnabled);
  });
}

export async function initRecorder(options = {}) {
  onRecordingComplete = options.onRecordingComplete ?? (() => {});
  getSelectedQuestion = options.getSelectedQuestion ?? (() => null);
  onExitReview = options.onExitReview ?? (() => {});
  onNotesChange = options.onNotesChange ?? (() => {});
  onScoreChange = options.onScoreChange ?? (() => {});

  recordBtn.addEventListener("click", toggleRecording);
  backToLiveBtn.addEventListener("click", exitReviewMode);
  await initWpmToggle();
  await initCamera();
}
