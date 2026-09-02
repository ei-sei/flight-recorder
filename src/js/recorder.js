import {
  formatTimer,
  formatDuration,
  renderStars,
  autosizeTextarea,
  formatResponseDelay,
  formatWpm,
  formatConfidence,
  watermarkDateStamp,
} from "./util.js";
import { getWpmEnabled, setWpmEnabled, getRecordingSettings, saveRecordingSettings } from "./store.js";
import { showInfoTip } from "./infotip.js";

const previewEl = document.getElementById("preview");
const viewfinderMetaEl = document.getElementById("viewfinder-meta");
const viewfinderMetaInfoEl = document.getElementById("viewfinder-meta-info");
const viewfinderMetaStarsEl = document.getElementById("viewfinder-meta-stars");
const viewfinderEl = document.querySelector(".viewfinder");
const recorderPanelEl = document.querySelector(".recorder-panel");
const viewfinderEmptyEl = document.getElementById("viewfinder-empty");
const recIndicatorEl = document.getElementById("rec-indicator");
const recDotEl = document.getElementById("rec-dot");
const recLabelEl = document.getElementById("rec-label");
const reviewIndicatorEl = document.getElementById("review-indicator");
const timerEl = document.getElementById("timer");
const recordControlsEl = document.querySelector(".record-controls");
const cameraToggleRowEl = document.querySelector(".camera-toggle-row");
const cameraToggleBtn = document.getElementById("camera-toggle-btn");
const cameraToggleSwitch = document.getElementById("camera-toggle-switch");
const recordBtn = document.getElementById("record-btn");
const backToLiveBtn = document.getElementById("back-to-live-btn");
const currentQuestionEl = document.getElementById("current-question");
const reviewNotesRow = document.getElementById("review-notes-row");
const reviewNotesInput = document.getElementById("review-notes-input");
const reviewStatsRow = document.getElementById("review-stats-row");
const reviewTranscriptRow = document.getElementById("review-transcript-row");
const reviewTranscriptText = document.getElementById("review-transcript-text");
const reviewTranscriptEmpty = document.getElementById("review-transcript-empty");
const reviewTranscriptSettingsBtn = document.getElementById("review-transcript-settings-btn");
const liveReadoutsEl = document.getElementById("live-readouts");
const waveformCanvasEl = document.getElementById("voice-waveform");
const waveformCtx = waveformCanvasEl.getContext("2d");
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
let waveformStrokeStyle = "#4c7cf6";

let wpmEnabled = false;
let speechRecognizer = null;
let transcript = "";
let wpm = null;
let finalResultConfidences = [];
let speechConfidence = null;

let isReviewing = false;
let reviewObjectUrl = null;
let onExitReview = () => {};
let onNotesChange = () => {};
let onScoreChange = () => {};
let onOpenSettings = () => {};

let currentQuality = "720";
let cameraEnabled = false;
let cameraWasEnabledBeforeReview = false;

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

// Camera starts off rather than requesting getUserMedia the instant the app
// launches - a permission prompt firing with zero context on first open is a
// bad first impression, and it also means the toggle button below is the one
// and only path that ever requests camera/mic access.
async function enableCamera() {
  // Flip the switch and swap the empty-state copy immediately, before
  // awaiting anything - getUserMedia's own hardware negotiation already
  // takes a real, unavoidable moment, and the toggle looked stuck when it
  // only updated after that whole chain resolved.
  cameraToggleBtn.disabled = true;
  cameraToggleBtn.classList.add("active");
  cameraToggleSwitch.classList.add("checked");
  viewfinderEmptyEl.textContent = "Turning on camera…";
  viewfinderEmptyEl.hidden = false;

  const settings = await getRecordingSettings();
  currentQuality = settings.quality;

  try {
    const acquiredStream = await acquireStream(settings.cameraId, settings.micId, currentQuality);
    // enableCamera() is called fire-and-forget from exitReviewMode() to
    // restore the camera; if review mode was re-entered while this was
    // still negotiating (e.g. rapidly switching between attempts), the
    // review video is already showing again by the time we get here -
    // release this stream instead of clobbering previewEl.srcObject.
    if (isReviewing) {
      for (const track of acquiredStream.getTracks()) track.stop();
      return;
    }
    stream = acquiredStream;
    previewEl.srcObject = stream;
    viewfinderEmptyEl.hidden = true;
    cameraEnabled = true;
  } catch (err) {
    viewfinderEmptyEl.textContent = "Camera access denied or unavailable.";
    viewfinderEmptyEl.hidden = false;
    console.error("Failed to access camera/microphone", err);
  }
  updateCameraToggleUI();
  updateRecordButtonState();
}

function disableCamera() {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  previewEl.srcObject = null;
  cameraEnabled = false;
  viewfinderEmptyEl.textContent = "Camera is off.";
  viewfinderEmptyEl.hidden = false;
  updateCameraToggleUI();
  updateRecordButtonState();
}

function updateCameraToggleUI() {
  // Hidden rather than just disabled while reviewing - the camera isn't
  // shown then (the recorded clip is), so the toggle has nothing to act on.
  cameraToggleRowEl.hidden = isReviewing;
  cameraToggleBtn.disabled = mediaRecorder && mediaRecorder.state === "recording";
  cameraToggleBtn.classList.toggle("active", cameraEnabled);
  cameraToggleSwitch.classList.toggle("checked", cameraEnabled);
}

function toggleCamera() {
  if (cameraEnabled) {
    disableCamera();
  } else {
    enableCamera();
  }
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

  if (!cameraEnabled) return; // changing settings shouldn't turn the camera on by itself

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

// Normal speech only swings a small fraction of the mic's full -1..1
// range, so the raw samples render as a nearly flat line - gain them up so
// the wave actually visibly reacts to a normal speaking voice, clamping so
// louder moments don't just draw off the edge of the canvas.
const WAVEFORM_GAIN = 5;

function drawWaveform() {
  const { width, height } = waveformCanvasEl;
  waveformCtx.clearRect(0, 0, width, height);
  waveformCtx.beginPath();
  const sliceWidth = width / volumeData.length;
  let x = 0;
  for (let i = 0; i < volumeData.length; i++) {
    const amplified = Math.max(-1, Math.min(1, volumeData[i] * WAVEFORM_GAIN));
    const y = (0.5 + amplified * 0.5) * height;
    if (i === 0) {
      waveformCtx.moveTo(x, y);
    } else {
      waveformCtx.lineTo(x, y);
    }
    x += sliceWidth;
  }
  waveformCtx.strokeStyle = waveformStrokeStyle;
  waveformCtx.lineWidth = 1.5;
  waveformCtx.stroke();
}

function pollVolume() {
  analyser.getFloatTimeDomainData(volumeData);
  let sumSquares = 0;
  for (let i = 0; i < volumeData.length; i++) {
    sumSquares += volumeData[i] * volumeData[i];
  }
  const rms = Math.sqrt(sumSquares / volumeData.length);

  drawWaveform();

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

  // Canvas backing size is set explicitly (rather than relying on its CSS
  // size) so the waveform draws crisply instead of being stretched - read
  // once here rather than every animation frame.
  const dpr = window.devicePixelRatio || 1;
  waveformCanvasEl.width = waveformCanvasEl.clientWidth * dpr;
  waveformCanvasEl.height = waveformCanvasEl.clientHeight * dpr;
  waveformStrokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4c7cf6";

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
  finalResultConfidences = [];
  speechConfidence = null;
  readoutWpmEl.hidden = false;
  readoutWpmEl.textContent = "wpm —";

  speechRecognizer = new SpeechRecognitionImpl();
  speechRecognizer.continuous = true;
  speechRecognizer.interimResults = true;
  speechRecognizer.lang = "en-US";

  speechRecognizer.onresult = (event) => {
    let combined = "";
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      combined += result[0].transcript + " ";
      // Confidence is only meaningful once a result is finalised - interim
      // results report 0. Indices don't change once final, so overwriting
      // by index each event naturally de-dupes without double-counting.
      if (result.isFinal) {
        finalResultConfidences[i] = result[0].confidence;
      }
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

  const confidences = finalResultConfidences.filter((c) => typeof c === "number");
  speechConfidence = confidences.length ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length : null;
}

// Safari/WKWebView's MediaRecorder has historically only supported
// recording to MP4, not WebM - so the format actually has to be
// feature-detected per platform rather than assumed.
const RECORDING_FORMAT_CANDIDATES = [
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
  { mimeType: "video/mp4", extension: "mp4" },
];

function getSupportedRecordingFormat() {
  for (const candidate of RECORDING_FORMAT_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) return candidate;
  }
  return { mimeType: "", extension: "webm" };
}

let currentRecordingFormat = null;

// Burns the date/timer into the saved video, camcorder-style - the on-screen
// badge is a UI overlay only and was never part of the recorded pixels.
// Composites the live preview frame onto a hidden canvas each tick and
// records THAT canvas's stream (recombined with the mic's audio track)
// instead of the raw camera stream.
const WATERMARK_FPS = 30;
const WATERMARK_FONT = 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, "Liberation Mono", monospace';
const watermarkCanvas = document.createElement("canvas");
const watermarkCtx = watermarkCanvas.getContext("2d");
let watermarkStream = null;
let watermarkRafId = null;
let watermarkLastDrawTs = 0;

function drawWatermarkFrame(timestamp) {
  watermarkRafId = requestAnimationFrame(drawWatermarkFrame);
  // Throttled below the display refresh rate - captureStream re-sends the
  // last drawn frame on its own schedule, so redrawing less often than that
  // saves CPU without dropping frames from the actual recording.
  if (timestamp - watermarkLastDrawTs < 1000 / WATERMARK_FPS) return;
  watermarkLastDrawTs = timestamp;

  const { width, height } = watermarkCanvas;
  watermarkCtx.drawImage(previewEl, 0, 0, width, height);

  const text = `${watermarkDateStamp()}  ${formatTimer(Date.now() - recordStartTs)}`;
  const fontSize = Math.round(height * 0.032);
  watermarkCtx.font = `${fontSize}px ${WATERMARK_FONT}`;
  const paddingX = fontSize * 0.6;
  const paddingY = fontSize * 0.45;
  const boxX = fontSize * 0.5;
  const boxY = fontSize * 0.5;
  const boxWidth = watermarkCtx.measureText(text).width + paddingX * 2;
  const boxHeight = fontSize + paddingY * 2;

  watermarkCtx.fillStyle = "rgba(5, 7, 10, 0.65)";
  watermarkCtx.fillRect(boxX, boxY, boxWidth, boxHeight);

  watermarkCtx.fillStyle = "#eef2f7";
  watermarkCtx.textBaseline = "middle";
  watermarkCtx.fillText(text, boxX + paddingX, boxY + boxHeight / 2);
}

function startWatermarkCompositing() {
  // The actual negotiated resolution, not the preset's ideal - getUserMedia
  // constraints use "ideal", not "exact", so what the camera actually
  // delivers can differ; sizing off the preset instead would stretch every
  // frame to fit the wrong aspect ratio.
  const preset = getQualityPreset();
  watermarkCanvas.width = previewEl.videoWidth || preset.width;
  watermarkCanvas.height = previewEl.videoHeight || preset.height;
  watermarkLastDrawTs = 0;
  watermarkRafId = requestAnimationFrame(drawWatermarkFrame);

  watermarkStream = watermarkCanvas.captureStream(WATERMARK_FPS);
  return new MediaStream([...watermarkStream.getVideoTracks(), ...stream.getAudioTracks()]);
}

function stopWatermarkCompositing() {
  if (watermarkRafId !== null) {
    cancelAnimationFrame(watermarkRafId);
    watermarkRafId = null;
  }
  if (watermarkStream) {
    for (const track of watermarkStream.getTracks()) track.stop();
    watermarkStream = null;
  }
}

function startRecording() {
  if (!stream) return;

  chunks = [];
  currentRecordingFormat = getSupportedRecordingFormat();
  // Set before starting the watermark loop - it reads recordStartTs on its
  // very first drawn frame, which would otherwise show a garbage elapsed
  // time computed against the stale value from the previous recording.
  recordStartTs = Date.now();
  const recordingStream = startWatermarkCompositing();
  mediaRecorder = new MediaRecorder(recordingStream, {
    ...(currentRecordingFormat.mimeType ? { mimeType: currentRecordingFormat.mimeType } : {}),
    videoBitsPerSecond: getQualityPreset().bitrate,
    audioBitsPerSecond: 128_000,
  });
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  mediaRecorder.onstop = handleStop;
  mediaRecorder.start();

  recDotEl.hidden = false;
  recLabelEl.hidden = false;
  timerEl.textContent = "00:00.0";
  timerInterval = setInterval(updateTimer, 100);
  recordBtn.textContent = "Stop";
  recordBtn.classList.add("recording");
  viewfinderEl.classList.add("recording");

  liveReadoutsEl.hidden = false;
  startResponseDelayDetection();
  updateCameraToggleUI();

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
  stopWatermarkCompositing();
  stopResponseDelayDetection();
  if (wpmEnabled && SpeechRecognitionImpl) {
    stopSpeechPaceTracking();
  }
  recDotEl.hidden = true;
  recLabelEl.hidden = true;
  liveReadoutsEl.hidden = true;
  timerEl.textContent = "00:00.0";
  recordBtn.textContent = "Record";
  recordBtn.classList.remove("recording");
  viewfinderEl.classList.remove("recording");
  updateRecordButtonState();
  updateCameraToggleUI();

  const durationMs = Date.now() - recordStartTs;
  const format = currentRecordingFormat ?? getSupportedRecordingFormat();
  const blob = new Blob(chunks, { type: format.mimeType || `video/${format.extension}` });
  const question = getSelectedQuestion();
  if (question) {
    await onRecordingComplete({
      blob,
      extension: format.extension,
      durationMs,
      question,
      responseDelayMs,
      wpm: wpmEnabled ? wpm : null,
      transcript: wpmEnabled ? transcript : null,
      speechConfidence: wpmEnabled ? speechConfidence : null,
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
  const mimeType = attempt.videoPath.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/webm";
  reviewObjectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));

  const wasAlreadyReviewing = isReviewing;
  isReviewing = true;

  // Turn the camera off while reviewing - it's not shown (the recorded clip
  // is), so leaving it running just keeps the camera light on and the
  // device busy for no reason. Restored in exitReviewMode() only if it was
  // actually on before review started.
  //
  // Only snapshot this on the first transition into review, not on every
  // switch between attempts while already reviewing - the previous attempt's
  // exit may have fired an in-flight (fire-and-forget) camera restore that
  // hasn't resolved yet, and re-snapshotting here would misread that
  // still-off camera as "was off", permanently forgetting it should come
  // back once the user actually returns to the live view.
  if (!wasAlreadyReviewing) {
    cameraWasEnabledBeforeReview = cameraEnabled;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  cameraEnabled = false;

  previewEl.srcObject = null;
  previewEl.src = reviewObjectUrl;
  previewEl.muted = false;
  previewEl.controls = true;
  previewEl.play().catch(() => {});

  viewfinderEmptyEl.hidden = true;
  viewfinderEl.classList.add("reviewing");
  reviewIndicatorEl.hidden = false;
  recIndicatorEl.hidden = true;
  recordBtn.hidden = true;
  backToLiveBtn.hidden = false;
  currentQuestionEl.textContent = `Reviewing: “${attempt.questionText}”`;

  const dateLabel = new Date(attempt.date).toLocaleDateString("en-GB");
  viewfinderMetaInfoEl.textContent = `Attempt ${attemptNumber} · ${dateLabel} · ${attempt.category} · Duration: ${formatDuration(attempt.durationMs)}`;
  renderReviewStars(attempt.id, attempt.score);
  viewfinderMetaEl.hidden = false;

  reviewStatsRow.innerHTML = "";
  const delayLabel = formatResponseDelay(attempt.responseDelayMs);
  const wpmLabel = formatWpm(attempt.wpm);
  const confidenceLabel = formatConfidence(attempt.speechConfidence);
  const statsParts = [];
  if (delayLabel) statsParts.push({ text: delayLabel });
  if (wpmLabel) statsParts.push({ text: wpmLabel });
  if (confidenceLabel) {
    statsParts.push({
      text: confidenceLabel,
      hint: "How confident the recogniser was in what it heard - not a validated clarity score.",
    });
  }
  statsParts.forEach((part, index) => {
    if (index > 0) reviewStatsRow.appendChild(document.createTextNode(" · "));
    const span = document.createElement("span");
    span.textContent = part.text;
    if (part.hint) {
      span.classList.add("stat-hint");
      span.addEventListener("click", () => showInfoTip(span, part.hint));
    }
    reviewStatsRow.appendChild(span);
  });
  reviewStatsRow.hidden = statsParts.length === 0;

  reviewTranscriptRow.hidden = false;
  if (attempt.transcript) {
    reviewTranscriptText.hidden = false;
    reviewTranscriptEmpty.hidden = true;
    reviewTranscriptText.value = attempt.transcript;
    autosizeTextarea(reviewTranscriptText);
  } else {
    reviewTranscriptText.hidden = true;
    reviewTranscriptEmpty.hidden = false;
  }

  reviewNotesRow.hidden = false;
  reviewNotesInput.value = attempt.notes;
  autosizeTextarea(reviewNotesInput);
  reviewNotesInput.onblur = () => onNotesChange(attempt.id, reviewNotesInput.value);
  reviewNotesInput.oninput = () => autosizeTextarea(reviewNotesInput);

  updateRecordButtonState();
  updateCameraToggleUI();
  updateViewfinderSize();
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
  recIndicatorEl.hidden = false;
  recordBtn.hidden = false;
  backToLiveBtn.hidden = true;

  reviewStatsRow.hidden = true;
  reviewTranscriptRow.hidden = true;
  reviewNotesRow.hidden = true;
  reviewNotesInput.onblur = null;
  reviewNotesInput.oninput = null;
  viewfinderMetaEl.hidden = true;

  updateRecordButtonState();
  updateCameraToggleUI();
  updateViewfinderSize();
  onExitReview();

  // Not awaited - re-acquiring the camera shouldn't block the rest of the
  // exit-review teardown above, it can finish on its own a moment later.
  if (cameraWasEnabledBeforeReview) {
    enableCamera();
  }
}

// Matches QUALITY_PRESETS (1280x720 / 1920x1080) — both 16:9. A mismatched
// container ratio here just wastes space against object-fit: cover, since
// the box shape no longer matches what's actually being recorded.
const VIEWFINDER_ASPECT = 16 / 9;

function updateViewfinderSize() {
  viewfinderEl.style.flex = "0 0 auto";

  const panelStyle = getComputedStyle(recorderPanelEl);
  const horizontalPadding = parseFloat(panelStyle.paddingLeft) + parseFloat(panelStyle.paddingRight);
  const verticalPadding = parseFloat(panelStyle.paddingTop) + parseFloat(panelStyle.paddingBottom);
  const gap = parseFloat(panelStyle.rowGap) || 0;
  const availableWidth = recorderPanelEl.clientWidth - horizontalPadding;

  // recorderPanelEl.clientHeight is stable regardless of content - it has
  // overflow-y: auto, so overflowing children scroll instead of growing the
  // box. Available height for the player is that stable number minus only
  // the chrome that should always stay visible alongside it. Transcript and
  // notes are deliberately left out here: they're meant to scroll with the
  // rest of the panel instead of competing with the player for space.
  const alwaysVisible = [
    viewfinderMetaEl,
    cameraToggleRowEl,
    currentQuestionEl,
    liveReadoutsEl,
    recordControlsEl,
  ].filter((el) => !el.hidden);
  const chromeHeight = alwaysVisible.reduce((sum, el) => sum + el.offsetHeight, 0);
  const gapsCount = alwaysVisible.length; // one gap between each always-visible element and the player
  const availableHeight = recorderPanelEl.clientHeight - verticalPadding - chromeHeight - gapsCount * gap;

  if (availableWidth <= 0 || availableHeight <= 0) return;

  const widthIfHeightBound = availableHeight * VIEWFINDER_ASPECT;
  let finalWidth;
  if (widthIfHeightBound <= availableWidth) {
    // Panel height is the binding constraint.
    finalWidth = widthIfHeightBound;
    viewfinderEl.style.width = `${finalWidth}px`;
    viewfinderEl.style.height = `${availableHeight}px`;
  } else {
    // Panel width is the binding constraint.
    finalWidth = availableWidth;
    viewfinderEl.style.width = `${finalWidth}px`;
    viewfinderEl.style.height = `${finalWidth / VIEWFINDER_ASPECT}px`;
  }

  // Keep the review-mode info bar the same width as the player itself,
  // instead of an arbitrary CSS cap that left mismatched whitespace on
  // both sides whenever the player was wider than that guess.
  viewfinderMetaEl.style.width = `${finalWidth}px`;
}

function initViewfinderSizing() {
  updateViewfinderSize();
  new ResizeObserver(updateViewfinderSize).observe(recorderPanelEl);
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
  onOpenSettings = options.onOpenSettings ?? (() => {});

  recordBtn.addEventListener("click", toggleRecording);
  backToLiveBtn.addEventListener("click", exitReviewMode);
  // The browser's native video context menu (loop, save video as, PiP, "send
  // tab to your devices", ...) doesn't apply to a packaged desktop app.
  previewEl.addEventListener("contextmenu", (event) => event.preventDefault());
  reviewTranscriptSettingsBtn.addEventListener("click", onOpenSettings);
  cameraToggleBtn.addEventListener("click", toggleCamera);
  updateCameraToggleUI();
  initViewfinderSizing();
  await initWpmToggle();
}
