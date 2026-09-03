import {
  formatTimer,
  formatDuration,
  renderStars,
  autosizeTextarea,
  formatResponseDelay,
  formatWpm,
  formatPauses,
  formatLongestPause,
  formatLongestStretch,
  formatPaceRange,
  formatSpeakingRatio,
  formatFillers,
  countFillers,
  watermarkDateStamp,
  enableTabIndent,
  formatBytes,
} from "./util.js";
import {
  getWpmEnabled,
  setWpmEnabled,
  getRecordingSettings,
  saveRecordingSettings,
  getPrepNotesCollapsed,
  setPrepNotesCollapsed,
  getPrepNotesHeight,
  setPrepNotesHeight,
  getWhisperModelDownloaded,
  setWhisperModelDownloaded,
} from "./store.js";
import { resolveVideoPath } from "./attempts.js";
import { showConfirm, showAlert, setModalProgress, finishModal } from "./modal.js";

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
const prepNotesRow = document.getElementById("prep-notes-row");
const prepNotesInput = document.getElementById("prep-notes-input");
const prepNotesToggleBtn = document.getElementById("prep-notes-toggle");
const prepNotesBodyEl = document.getElementById("prep-notes-body");
const prepNotesResizeHandleEl = document.getElementById("prep-notes-resize-handle");
const reviewNotesRow = document.getElementById("review-notes-row");
const reviewNotesInput = document.getElementById("review-notes-input");
const reviewStatsRow = document.getElementById("review-stats-row");
const reviewDelayEl = document.getElementById("review-delay");
const reviewTranscriptRow = document.getElementById("review-transcript-row");
const reviewTranscriptText = document.getElementById("review-transcript-text");
const reviewTranscriptEmpty = document.getElementById("review-transcript-empty");
const reviewTranscriptEmptyText = document.getElementById("review-transcript-empty-text");
const reviewTranscriptSettingsBtn = document.getElementById("review-transcript-settings-btn");
const liveReadoutsEl = document.getElementById("live-readouts");
const waveformCanvasEl = document.getElementById("voice-waveform");
const waveformCtx = waveformCanvasEl.getContext("2d");
const readoutDelayEl = document.getElementById("readout-delay");
const wpmToggleInput = document.getElementById("wpm-toggle-input");
const wpmToggleHint = document.getElementById("wpm-toggle-hint");

const { convertFileSrc, invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Absolute mic levels vary hugely between a close headset and a laptop's
// built-in array - more so with auto gain control off, but a fixed
// threshold was never reliable even with it on. Track the noise floor
// instead and require speech to sit well clear of it.
const SPEECH_NOISE_MULTIPLIER = 4;
// Still needs an absolute floor: in a silent room the tracked floor tends to
// zero, and any multiple of nearly-zero is nearly-zero.
const SPEECH_RMS_FLOOR = 0.01;
const SPEECH_SUSTAIN_MS = 150;
// Below the speech threshold for this long counts as a pause worth showing.
// Shorter gaps are ordinary between-sentence breathing, not hesitation.
const PAUSE_MIN_MS = 1200;
// How long the level has to stay down before a run of speech is considered
// over. Covers the dips between syllables and words.
const SILENCE_HOLD_MS = 400;

let stream = null;
let mediaRecorder = null;
let chunks = [];
let recordStartTs = 0;
let timerInterval = null;
let hasSelection = false;
let currentQuestion = null;
let onRecordingComplete = () => {};
let onPrepNotesChange = () => {};
let getSelectedQuestion = () => null;

let audioCtx = null;
let analyser = null;
let volumeData = null;
let volumeRafId = null;
let speechAboveThresholdSinceTs = null;
let responseDelayMs = null;
let noiseFloorRms = null;
let isSpeaking = false;
let speechStartTs = null;
let lastSpeechEndTs = null;
let belowThresholdSinceTs = null;
let speakingMs = 0;
let pauseCount = 0;
let longestPauseMs = 0;
let longestStretchMs = 0;
let stretchStartTs = null;
// Speech runs as [startMs, endMs] offsets from recordStartTs. Handed to
// transcription so whisper's segments can be checked against times the mic
// actually registered speech, then thrown away - useful for a few seconds,
// far too bulky to keep on every attempt forever.
let speechIntervals = [];
let waveformStrokeStyle = "#4c7cf6";

let wpmEnabled = false;
let prepNotesCollapsed = false;
let prepNotesHeight = 0;

let isReviewing = false;
let onExitReview = () => {};
let onNotesChange = () => {};
let onScoreChange = () => {};
let onOpenSettings = () => {};

let currentQuality = "720";
let cameraEnabled = false;
let cameraWasEnabledBeforeReview = false;

// These numbers were originally tuned for VP9. When recording switched to
// H.264 everywhere (see RECORDING_FORMAT_CANDIDATES), both presets kept
// their VP9-era bitrate - H.264 needs roughly 25% more bits than VP9 for
// the same picture, so both were quietly under-delivering quality relative
// to before, not just 480p's separate resolution/fps retuning. Confirmed by
// real testing: recordings looked visibly worse than the old defaults.
// Bumped ~+25% at both tiers to actually match. 24fps (see WATERMARK_FPS)
// still claws some of that back.
const QUALITY_PRESETS = {
  480: { width: 854, height: 480, bitrate: 1_600_000 },
  720: { width: 1280, height: 720, bitrate: 3_200_000 },
};

// Every preset is 16:9, and the recording is held to it - a camera that only
// offers 4:3 gets centre-cropped to fit rather than squashed into it. Also
// drives the viewfinder's box shape, so the preview matches what's saved.
const VIEWFINDER_ASPECT = 16 / 9;

function getQualityPreset() {
  return QUALITY_PRESETS[currentQuality] ?? QUALITY_PRESETS["480"];
}

async function acquireStream(cameraId, micId, quality) {
  const preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS["480"];
  const constraints = {
    video: {
      deviceId: cameraId ? { exact: cameraId } : undefined,
      width: { ideal: preset.width },
      height: { ideal: preset.height },
    },
    audio: {
      deviceId: micId ? { exact: micId } : undefined,
      // Not exposed as settings. Both were tried as user-facing toggles;
      // autoGainControl:false was actively harmful (real testing showed some
      // mics went quiet enough that Whisper transcribed nothing at all), and
      // noiseSuppression:false is a niche trade-off that doesn't suit this
      // app's actual use case - someone rehearsing alone, in a room they've
      // already chosen to be quiet. Hardcoded on for both. Don't reintroduce
      // either as a toggle without a real, demonstrated need.
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

// The camera never turns on out of nowhere on its own - the only paths in
// here are the toggle button, and initRecorder() restoring a state the user
// already chose (and already granted permission for) in a previous session.
// A first-time user, with no prior state to restore, still only ever sees
// the permission prompt after clicking the toggle themselves.
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
    saveRecordingSettings({ cameraEnabled: true });
    startWaveformMonitoring();
  } catch (err) {
    viewfinderEmptyEl.textContent = "Camera access denied or unavailable.";
    viewfinderEmptyEl.hidden = false;
    console.error("Failed to access camera/microphone", err);
  }
  updateCameraToggleUI();
  updateRecordButtonState();
}

function disableCamera() {
  stopWaveformMonitoring();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  previewEl.srcObject = null;
  cameraEnabled = false;
  saveRecordingSettings({ cameraEnabled: false });
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

  // The analyser is bound to the old stream's source node, so it has to be
  // torn down and rebuilt against the replacement stream.
  stopWaveformMonitoring();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }

  stream = await acquireStream(cameraId, micId, quality);
  previewEl.srcObject = stream;
  viewfinderEmptyEl.hidden = true;
  startWaveformMonitoring();
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
// Downsampled to a handful of points, not one per raw sample (2048 of
// them) - fewer points drawn as a smoothed curve reads as a soft, "cute"
// wave rather than a jagged oscilloscope trace of the literal signal.
const WAVEFORM_POINTS = 28;
const WAVEFORM_FPS = 30;
let waveformLastDrawTs = 0;

function sizeWaveformCanvas() {
  // Backing size is set explicitly (rather than relying on CSS size) so the
  // line draws crisply instead of being stretched.
  const dpr = window.devicePixelRatio || 1;
  waveformCanvasEl.width = waveformCanvasEl.clientWidth * dpr;
  waveformCanvasEl.height = waveformCanvasEl.clientHeight * dpr;
}

function strokeWaveformPoints(points) {
  const { width, height } = waveformCanvasEl;
  waveformCtx.clearRect(0, 0, width, height);
  waveformCtx.beginPath();
  waveformCtx.moveTo(points[0].x, points[0].y);
  // Quadratic-curve through the midpoint of each pair of points, rather
  // than straight lineTo segments between them - that's what actually
  // softens the line into a smooth curve instead of a jagged zig-zag.
  for (let i = 0; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    waveformCtx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  waveformCtx.quadraticCurveTo(last.x, last.y, last.x, last.y);

  waveformCtx.strokeStyle = waveformStrokeStyle;
  waveformCtx.lineWidth = 2;
  waveformCtx.lineJoin = "round";
  waveformCtx.lineCap = "round";
  waveformCtx.stroke();
}

function drawIdleWaveform() {
  const { width, height } = waveformCanvasEl;
  const points = [];
  for (let i = 0; i < WAVEFORM_POINTS; i++) {
    points.push({ x: (i / (WAVEFORM_POINTS - 1)) * width, y: height / 2 });
  }
  strokeWaveformPoints(points);
}

function drawWaveform() {
  const { width, height } = waveformCanvasEl;
  const bucketSize = Math.floor(volumeData.length / WAVEFORM_POINTS) || 1;
  const points = [];
  for (let i = 0; i < WAVEFORM_POINTS; i++) {
    // Peak-per-bucket, keeping its sign - preserves the wave's up/down
    // shape instead of collapsing to a one-sided envelope.
    let peak = 0;
    const start = i * bucketSize;
    const end = Math.min(start + bucketSize, volumeData.length);
    for (let j = start; j < end; j++) {
      if (Math.abs(volumeData[j]) > Math.abs(peak)) peak = volumeData[j];
    }
    const amplified = Math.max(-1, Math.min(1, peak * WAVEFORM_GAIN));
    points.push({ x: (i / (WAVEFORM_POINTS - 1)) * width, y: (0.5 + amplified * 0.5) * height });
  }
  strokeWaveformPoints(points);
}

function isRecordingActive() {
  return Boolean(mediaRecorder && mediaRecorder.state === "recording");
}

function pollVolume(timestamp) {
  volumeRafId = requestAnimationFrame(pollVolume);

  // Throttled below the display refresh rate. This loop runs the whole time
  // the camera is on (not just while recording), so redrawing every frame
  // burns CPU indefinitely for a visual that reads identically at 30fps -
  // same reasoning as the watermark compositor's own throttle.
  if (timestamp - waveformLastDrawTs < 1000 / WAVEFORM_FPS) return;
  waveformLastDrawTs = timestamp;

  analyser.getFloatTimeDomainData(volumeData);
  drawWaveform();

  const rms = computeRms();
  // Tracked whenever the mic is live, not only while recording, so the floor
  // is already settled by the time Record is pressed - otherwise the first
  // couple of seconds of every attempt would be measured against nothing.
  trackNoiseFloor(rms);

  // Everything below is relative to an actual recording's start time. The
  // analyser itself runs continuously whenever the camera/mic is on, well
  // before (and after) any given recording.
  if (!isRecordingActive()) return;

  const now = Date.now();
  const speaking = rms > speechRmsThreshold();

  if (responseDelayMs === null) {
    if (speaking) {
      if (speechAboveThresholdSinceTs === null) {
        speechAboveThresholdSinceTs = now;
      } else if (now - speechAboveThresholdSinceTs >= SPEECH_SUSTAIN_MS) {
        responseDelayMs = speechAboveThresholdSinceTs - recordStartTs;
        readoutDelayEl.textContent = formatResponseDelay(responseDelayMs);
      }
    } else {
      speechAboveThresholdSinceTs = null;
    }
  }

  trackPauses(speaking, now);
}

function computeRms() {
  let sumSquares = 0;
  for (let i = 0; i < volumeData.length; i++) {
    sumSquares += volumeData[i] * volumeData[i];
  }
  return Math.sqrt(sumSquares / volumeData.length);
}

// Drops quickly but climbs very slowly, so moving somewhere quieter is picked
// up within a second or two while sustained speech can never drag the floor
// up to meet itself and silence the detector.
function trackNoiseFloor(rms) {
  if (noiseFloorRms === null) noiseFloorRms = rms;
  else if (rms < noiseFloorRms) noiseFloorRms = noiseFloorRms * 0.8 + rms * 0.2;
  else noiseFloorRms = noiseFloorRms * 0.999 + rms * 0.001;
}

function speechRmsThreshold() {
  return Math.max((noiseFloorRms ?? 0) * SPEECH_NOISE_MULTIPLIER, SPEECH_RMS_FLOOR);
}

// RMS dips between syllables, so a bare threshold crossing would register
// dozens of "pauses" per sentence. Speech is treated as continuing until the
// level has stayed down for SILENCE_HOLD_MS, and the pause is measured from
// where it actually went quiet rather than from where we noticed.
function trackPauses(speaking, now) {
  // Only after the first word. The gap before it is the response delay,
  // already measured on its own - counting it here too would make it the
  // longest pause of nearly every attempt.
  if (responseDelayMs === null) return;

  if (speaking) {
    belowThresholdSinceTs = null;
    if (!isSpeaking) {
      if (lastSpeechEndTs !== null) {
        const gap = now - lastSpeechEndTs;
        if (gap >= PAUSE_MIN_MS) {
          pauseCount++;
          longestPauseMs = Math.max(longestPauseMs, gap);
          // A real pause ends the current unbroken run. Shorter gaps don't -
          // that's the difference between drawing breath and stopping.
          closeCurrentStretch(lastSpeechEndTs);
        }
      }
      isSpeaking = true;
      speechStartTs = now;
      if (stretchStartTs === null) stretchStartTs = now;
    }
    return;
  }

  if (!isSpeaking) return;
  if (belowThresholdSinceTs === null) {
    belowThresholdSinceTs = now;
    return;
  }
  if (now - belowThresholdSinceTs < SILENCE_HOLD_MS) return;

  isSpeaking = false;
  speakingMs += belowThresholdSinceTs - speechStartTs;
  speechIntervals.push([speechStartTs - recordStartTs, belowThresholdSinceTs - recordStartTs]);
  lastSpeechEndTs = belowThresholdSinceTs;
  belowThresholdSinceTs = null;
}

function closeCurrentStretch(endTs) {
  if (stretchStartTs === null) return;
  longestStretchMs = Math.max(longestStretchMs, endTs - stretchStartTs);
  stretchStartTs = null;
}

function resetSpeechAnalysis() {
  isSpeaking = false;
  speechStartTs = null;
  lastSpeechEndTs = null;
  belowThresholdSinceTs = null;
  speakingMs = 0;
  pauseCount = 0;
  longestPauseMs = 0;
  longestStretchMs = 0;
  stretchStartTs = null;
  speechIntervals = [];
}

// Closes off a run of speech still open when the recording stopped, so the
// last sentence counts towards speaking time like every other one.
function finaliseSpeechAnalysis() {
  const now = Date.now();
  if (isSpeaking && speechStartTs !== null) {
    speakingMs += now - speechStartTs;
    speechIntervals.push([speechStartTs - recordStartTs, now - recordStartTs]);
    isSpeaking = false;
  }
  closeCurrentStretch(now);
}

// Tied to the camera/mic being on, not to active recording - the waveform
// should react to your voice as soon as the mic is live, not just once you
// hit Record.
function startWaveformMonitoring() {
  // Idempotent - re-entering without a teardown would leak the previous
  // AudioContext and leave two rAF loops drawing over each other.
  stopWaveformMonitoring();
  sizeWaveformCanvas();
  waveformStrokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4c7cf6";

  // A different mic (or the same one without AGC) sits at a completely
  // different level, so the old floor would be meaningless here.
  noiseFloorRms = null;

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  volumeData = new Float32Array(analyser.fftSize);
  source.connect(analyser);

  // Scheduled rather than called directly so the first invocation gets a
  // real rAF timestamp to throttle against.
  waveformLastDrawTs = 0;
  volumeRafId = requestAnimationFrame(pollVolume);
}

function stopWaveformMonitoring() {
  if (volumeRafId !== null) {
    cancelAnimationFrame(volumeRafId);
    volumeRafId = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  drawIdleWaveform();
}

function resetResponseDelayTracking() {
  responseDelayMs = null;
  speechAboveThresholdSinceTs = null;
  readoutDelayEl.textContent = "delay —";
  resetSpeechAnalysis();
}

// MP4/H.264/AAC first, on every platform. It's the only combination all
// three target webviews can *play*, and the library folder is meant to be
// portable - a WebM recorded on Windows won't open after the folder is
// copied to a Mac, which defeats the point. Chromium gained MP4 recording
// support, so this is no longer a Safari-only option.
//
// Profile order is High -> Main -> Baseline: High is ~10% more efficient and
// every decoder from the last decade handles it, but not every *encoder*
// will emit it. Audio must be AAC (mp4a.40.2) - Chromium will happily put
// Opus in an MP4 and Safari won't play it back.
//
// WebM stays on the end as a genuine fallback for an engine with no H.264
// encoder at all.
const RECORDING_FORMAT_CANDIDATES = [
  // Hex digits uppercase - that's the convention in the spec's own examples,
  // and not every engine's parser is case-insensitive about it.
  { mimeType: "video/mp4;codecs=avc1.640028,mp4a.40.2", extension: "mp4" },
  { mimeType: "video/mp4;codecs=avc1.4D401F,mp4a.40.2", extension: "mp4" },
  { mimeType: "video/mp4;codecs=avc1.42E01F,mp4a.40.2", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

const BLIND_FALLBACK_FORMAT = { mimeType: "", extension: "webm" };

// Walks the ladder by *construction*, not by asking isTypeSupported, which
// is not trustworthy: WebKitGTK answers false for every type there is,
// including ones it records perfectly well. Whether the constructor accepts
// the type is the only probe that reflects what the engine will really do.
function createRecorder(recordingStream, options) {
  for (const candidate of RECORDING_FORMAT_CANDIDATES) {
    try {
      return {
        recorder: new MediaRecorder(recordingStream, { ...options, mimeType: candidate.mimeType }),
        extension: candidate.extension,
      };
    } catch (err) {
      // NotSupportedError - try the next one down the ladder.
    }
  }
  // Nothing explicit was accepted. Let the engine pick its own default, and
  // rely on reading back what it chose once it's actually running.
  return { recorder: new MediaRecorder(recordingStream, options), extension: BLIND_FALLBACK_FORMAT.extension };
}

// The extension has to describe what's really in the file, not what we asked
// for - a .webm that's actually an MP4 breaks playback everywhere and makes
// the portable library folder worse, not better.
function extensionForMimeType(mimeType, fallback) {
  if (!mimeType) return fallback;
  const type = mimeType.toLowerCase();
  if (type.startsWith("video/mp4")) return "mp4";
  if (type.startsWith("video/webm")) return "webm";
  if (type.startsWith("video/x-matroska")) return "mkv";
  return fallback;
}

let currentRecordingFormat = null;

// Burns the date/timer into the saved video, camcorder-style - the on-screen
// badge is a UI overlay only and was never part of the recorded pixels.
// Composites the live preview frame onto a hidden canvas each tick and
// records THAT canvas's stream (recombined with the mic's audio track)
// instead of the raw camera stream.
// 24, not 30. Gesture and fidgeting are what you're reading back on the
// video side, and 24 carries those fine while needing ~15% fewer bits.
// Don't drop it further - below 24 the delivery starts to look stilted,
// which is the opposite of useful when you're judging your own cadence.
const WATERMARK_FPS = 24;
const WATERMARK_FONT = 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, "Liberation Mono", monospace';
const watermarkCanvas = document.createElement("canvas");
const watermarkCtx = watermarkCanvas.getContext("2d");
let watermarkStream = null;
let watermarkRafId = null;
let watermarkLastDrawTs = 0;

// Centre-crops the source frame to the canvas's shape instead of stretching
// it, matching the preview's object-fit: cover. Only bites when the camera's
// own aspect ratio isn't 16:9 (a 4:3 webcam loses a sliver off each side).
function drawCoverFrame(ctx, source, width, height) {
  const srcW = source.videoWidth;
  const srcH = source.videoHeight;
  if (!srcW || !srcH) return;

  const dstAspect = width / height;
  let sw = srcW;
  let sh = srcW / dstAspect;
  if (sh > srcH) {
    sh = srcH;
    sw = srcH * dstAspect;
  }
  ctx.drawImage(source, (srcW - sw) / 2, (srcH - sh) / 2, sw, sh, 0, 0, width, height);
}

function drawWatermarkFrame(timestamp) {
  watermarkRafId = requestAnimationFrame(drawWatermarkFrame);
  // Throttled below the display refresh rate - captureStream re-sends the
  // last drawn frame on its own schedule, so redrawing less often than that
  // saves CPU without dropping frames from the actual recording.
  if (timestamp - watermarkLastDrawTs < 1000 / WATERMARK_FPS) return;
  watermarkLastDrawTs = timestamp;

  const { width, height } = watermarkCanvas;
  drawCoverFrame(watermarkCtx, previewEl, width, height);

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

// The preset is a ceiling the recording is actually held to, not a hint.
// This used to size the canvas off the camera's negotiated resolution, which
// meant a webcam with no 480p mode handed back 720p and we recorded 720p
// pixels against a 480p bitrate - worse picture than either setting, and the
// quality control silently did nothing. Cropping (not stretching) is handled
// by drawCoverFrame, and the source still caps it, so we never upscale.
function computeRecordingSize(preset) {
  const srcW = previewEl.videoWidth || preset.width;
  const srcH = previewEl.videoHeight || preset.height;

  // The tallest 16:9 region this camera can actually fill.
  const availableHeight = Math.min(srcH, srcW / VIEWFINDER_ASPECT);
  const height = Math.min(preset.height, Math.floor(availableHeight));
  const width = Math.round(height * VIEWFINDER_ASPECT);

  // H.264 encoders reject odd dimensions.
  return { width: width - (width % 2), height: height - (height % 2) };
}

function startWatermarkCompositing() {
  const size = computeRecordingSize(getQualityPreset());
  watermarkCanvas.width = size.width;
  watermarkCanvas.height = size.height;
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
  // Set before starting the watermark loop - it reads recordStartTs on its
  // very first drawn frame, which would otherwise show a garbage elapsed
  // time computed against the stale value from the previous recording.
  recordStartTs = Date.now();
  const recordingStream = startWatermarkCompositing();
  const { recorder, extension } = createRecorder(recordingStream, {
    videoBitsPerSecond: getQualityPreset().bitrate,
    audioBitsPerSecond: 128_000,
  });
  mediaRecorder = recorder;
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  mediaRecorder.onstop = handleStop;
  mediaRecorder.start();

  // Read back only after start() - some engines leave mimeType empty until
  // the encoder is actually running, and it's the authoritative answer for
  // what the file should be called.
  const negotiated = mediaRecorder.mimeType;
  currentRecordingFormat = {
    mimeType: negotiated || "",
    extension: extensionForMimeType(negotiated, extension),
  };

  recDotEl.hidden = false;
  recLabelEl.hidden = false;
  timerEl.textContent = "00:00.0";
  timerInterval = setInterval(updateTimer, 100);
  recordBtn.textContent = "Stop";
  recordBtn.classList.add("recording");
  viewfinderEl.classList.add("recording");

  liveReadoutsEl.hidden = false;
  updatePrepNotesVisibility();
  resetResponseDelayTracking();
  updateCameraToggleUI();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

async function handleStop() {
  clearInterval(timerInterval);
  stopWatermarkCompositing();
  recDotEl.hidden = true;
  recLabelEl.hidden = true;
  liveReadoutsEl.hidden = true;
  updatePrepNotesVisibility();
  timerEl.textContent = "00:00.0";
  recordBtn.textContent = "Record";
  recordBtn.classList.remove("recording");
  viewfinderEl.classList.remove("recording");
  updateRecordButtonState();
  updateCameraToggleUI();

  const durationMs = Date.now() - recordStartTs;
  finaliseSpeechAnalysis();
  const format = currentRecordingFormat ?? BLIND_FALLBACK_FORMAT;
  const blob = new Blob(chunks, { type: format.mimeType || `video/${format.extension}` });
  const question = getSelectedQuestion();
  if (question) {
    await onRecordingComplete({
      blob,
      extension: format.extension,
      durationMs,
      question,
      responseDelayMs,
      pauseCount,
      longestPauseMs,
      longestStretchMs,
      // Voiced time over total time. Measured from mic level, so it works on
      // every platform - unlike anything derived from a transcript.
      speakingRatio: durationMs > 0 ? Math.min(1, speakingMs / durationMs) : null,
      // Not stored on the attempt - only used to sanity-check transcription
      // against times the mic actually heard something.
      speechIntervals,
      // Always null at this point - transcription happens after the file is
      // written, not during the recording. saveAttempt() kicks it off in the
      // background and patches the attempt when it lands.
      wpm: null,
      transcript: null,
      needsWhisperTranscription: wpmEnabled,
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

// Renamed from setRecordEnabled(enabled) - now also carries the question
// itself, so its prep notes can be shown alongside enabling the button.
export function setActiveQuestion(question) {
  hasSelection = Boolean(question);
  updateRecordButtonState();

  currentQuestion = question;
  prepNotesInput.value = question?.prepNotes ?? "";
  updatePrepNotesVisibility();
}

function updatePrepNotesVisibility() {
  // Shown whenever a question is picked, including while recording - only
  // reviewing hides it (that has its own separate, after-the-fact notes
  // field instead).
  prepNotesRow.hidden = !currentQuestion || isReviewing;
  // The drawer's own visibility changes how much height the player gets.
  updateViewfinderSize();
}

function renderReviewStars(attemptId, score) {
  renderStars(viewfinderMetaStarsEl, score, (newScore) => {
    onScoreChange(attemptId, newScore);
    renderReviewStars(attemptId, newScore);
  });
}

// Renders label/values pairs straight into the grid, no wrapper elements -
// the two columns are what keep the labels aligned across rows. A group with
// nothing measured is skipped entirely rather than showing a bare label.
function renderReviewStats(groups) {
  reviewStatsRow.innerHTML = "";
  let rendered = 0;

  for (const group of groups) {
    const values = group.values.filter(Boolean);
    if (values.length === 0) continue;

    const label = document.createElement("span");
    label.className = "review-stat-label";
    label.textContent = group.label;

    const text = document.createElement("span");
    text.textContent = values.join(" · ");

    reviewStatsRow.append(label, text);
    rendered++;
  }

  reviewStatsRow.hidden = rendered === 0;
}

export async function enterReviewMode(attempt, attemptNumber) {
  if (mediaRecorder && mediaRecorder.state === "recording") return;

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
  stopWaveformMonitoring();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  cameraEnabled = false;

  // srcObject has to be cleared before src is set - per spec srcObject wins
  // when both are present, so assigning src first would rely on clearing it
  // afterwards to re-trigger resource selection.
  previewEl.srcObject = null;
  // convertFileSrc lets the webview stream the file directly off disk
  // through Tauri's asset protocol, rather than reading the whole video
  // into memory as a Blob first (the previous approach) - for a long
  // recording that upfront full-file read across the IPC boundary was
  // exactly why review playback took a noticeable moment to start.
  previewEl.src = convertFileSrc(await resolveVideoPath(attempt.videoRelativePath));
  previewEl.muted = false;
  previewEl.controls = true;
  previewEl.play().catch(() => {});

  viewfinderEmptyEl.hidden = true;
  viewfinderEl.classList.add("reviewing");
  reviewIndicatorEl.hidden = false;
  recIndicatorEl.hidden = true;
  recordBtn.hidden = true;
  backToLiveBtn.hidden = false;
  updatePrepNotesVisibility();
  currentQuestionEl.textContent = `Reviewing: “${attempt.questionText}”`;

  const dateLabel = new Date(attempt.date).toLocaleDateString("en-GB");
  viewfinderMetaInfoEl.textContent = `Attempt ${attemptNumber} · ${dateLabel} · ${attempt.category} · Duration: ${formatDuration(attempt.durationMs)}`;
  renderReviewStars(attempt.id, attempt.score);
  viewfinderMetaEl.hidden = false;

  renderReviewDetails(attempt);

  reviewNotesRow.hidden = false;
  reviewNotesInput.value = attempt.notes;
  autosizeTextarea(reviewNotesInput);
  reviewNotesInput.onblur = () => onNotesChange(attempt.id, reviewNotesInput.value);
  reviewNotesInput.oninput = () => autosizeTextarea(reviewNotesInput);

  updateRecordButtonState();
  updateCameraToggleUI();
  updateViewfinderSize();
}

// Everything in the review pane that comes from the attempt record rather
// than the video file. Split out from enterReviewMode so transcription
// landing can refresh it in place - re-entering review would reload the
// video element and yank playback back to the start.
export function renderReviewDetails(attempt) {
  if (!isReviewing) return;

  // Delay keeps its own slot next to the button. It's the one figure here
  // that isn't about how you spoke - it measures the gap before you started.
  const delayText = formatResponseDelay(attempt.responseDelayMs);
  reviewDelayEl.textContent = delayText ?? "";
  reviewDelayEl.hidden = !delayText;

  renderReviewStats([
    // Ordered by what actually changes how you'd practise. Speaking too fast
    // is the classic interview problem, a pace that drifts catches rushing
    // the ending, and fillers are the single most common piece of feedback
    // anyone gets.
    {
      label: "Speech",
      values: [
        formatWpm(attempt.wpm),
        formatPaceRange(attempt.paceMinWpm, attempt.paceMaxWpm),
        // Only worth showing when there's a transcript to have counted it
        // from - "0 fillers" against no transcript reads as a result rather
        // than an absence of one.
        attempt.transcript ? formatFillers(countFillers(attempt.transcript)) : null,
      ],
    },
    // Diagnostic rather than directly actionable: a long unbroken run points
    // at rambling and the pause figures at hesitation, but they're read
    // alongside the video rather than acted on by themselves. Talking ratio
    // is the weakest of the lot and sits last for that reason.
    {
      label: "Rhythm",
      values: [
        formatLongestStretch(attempt.longestStretchMs),
        formatPauses(attempt.pauseCount),
        formatLongestPause(attempt.longestPauseMs),
        formatSpeakingRatio(attempt.speakingRatio),
      ],
    },
  ]);

  reviewTranscriptRow.hidden = false;
  if (attempt.transcript) {
    reviewTranscriptText.hidden = false;
    reviewTranscriptEmpty.hidden = true;
    reviewTranscriptText.value = attempt.transcript;
    autosizeTextarea(reviewTranscriptText);
  } else {
    reviewTranscriptText.hidden = true;
    reviewTranscriptEmpty.hidden = false;
    // Three different reasons there's no transcript, and only one of them is
    // fixed by opening Settings. Transcription is still running (wait), it
    // ran and heard nothing (nothing to do), or WPM was off for this attempt
    // (turn it on) - telling someone to enable a setting that's already on,
    // or that's mid-download, is the wrong advice twice over.
    if (attempt.transcribing) {
      reviewTranscriptEmptyText.textContent = "Transcribing on this device…";
      reviewTranscriptSettingsBtn.hidden = true;
    } else if (attempt.transcript === "") {
      reviewTranscriptEmptyText.textContent = "No speech detected in this recording.";
      reviewTranscriptSettingsBtn.hidden = true;
    } else {
      reviewTranscriptEmptyText.textContent =
        "No transcript for this attempt. Turn on Speech pace (WPM) to capture one for your next recording.";
      reviewTranscriptSettingsBtn.hidden = false;
    }
    // Static text on a job with no progress to report reads as stalled. The
    // pulsing dot is the only thing telling you it's still working.
    reviewTranscriptEmpty.classList.toggle("transcribing", Boolean(attempt.transcribing));
  }

  // The stats block grows when transcription lands (the Speech row picks up
  // wpm, pace and fillers), and that block is part of the player's height
  // budget - without this the video would keep its old size and the panel
  // would start scrolling.
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

  viewfinderEmptyEl.hidden = Boolean(stream);
  viewfinderEl.classList.remove("reviewing");
  reviewIndicatorEl.hidden = true;
  recIndicatorEl.hidden = false;
  recordBtn.hidden = false;
  backToLiveBtn.hidden = true;
  updatePrepNotesVisibility();

  reviewStatsRow.hidden = true;
  reviewDelayEl.hidden = true;
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

// Prep notes is resizable and, unlike the transcript/review notes, is meant
// to compete with the player for space (that's the point of resizing it) -
// these keep that trade sane at both ends.
const MIN_VIDEO_HEIGHT = 160;
const PREP_NOTES_DEFAULT_HEIGHT = 90;
const PREP_NOTES_MIN_HEIGHT = 48;

// Shaved off the final computed height in updateViewfinderSize, not here -
// see the comment there for why an exact-fit computation is worth padding.
const LAYOUT_SAFETY_MARGIN = 2;

// recorderPanelEl.clientHeight is stable regardless of content - it has
// overflow-y: auto, so overflowing children scroll instead of growing the
// box. This is the space left over for the player and the notes drawer
// combined, after the chrome that should always stay visible alongside
// them. Transcript and review notes are deliberately left out here: unlike
// prep notes, they're meant to scroll with the rest of the panel instead of
// competing with the player for space.
function computeAvailableHeightForVideoAndNotes() {
  const panelStyle = getComputedStyle(recorderPanelEl);
  const verticalPadding = parseFloat(panelStyle.paddingTop) + parseFloat(panelStyle.paddingBottom);
  const gap = parseFloat(panelStyle.rowGap) || 0;

  // liveReadoutsEl isn't listed separately - it renders inline inside
  // recordControlsEl (next to the record button) rather than as its own
  // stacked row, so its height is already covered by recordControlsEl's.
  // reviewStatsRow *is* its own row, and a wrapping one, so it has to be
  // measured - it's only present in review mode, which the hidden filter
  // below handles.
  const alwaysVisible = [
    viewfinderMetaEl,
    cameraToggleRowEl,
    currentQuestionEl,
    recordControlsEl,
    reviewStatsRow,
  ].filter((el) => !el.hidden);
  // offsetHeight covers padding and border but not margin, so a margin on
  // any of these would go unbudgeted and quietly oversize the player - the
  // same mistake that let the notes drawer push the record button off-panel.
  // Measured explicitly rather than relying on nobody ever adding one.
  const chromeHeight = alwaysVisible.reduce((sum, el) => {
    const style = getComputedStyle(el);
    return sum + el.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
  }, 0);
  const gapsCount = alwaysVisible.length; // one gap between each always-visible element and the player
  return recorderPanelEl.clientHeight - verticalPadding - chromeHeight - gapsCount * gap;
}

// The drawer's fixed parts (resize handle + "Prep notes" bar), excluding the
// resizable body. Subtracting the body's live height cancels out whatever the
// collapse transition happens to be animating it to at this instant, so this
// stays correct mid-animation.
function prepNotesChromeHeight() {
  return prepNotesRow.offsetHeight - prepNotesBodyEl.offsetHeight;
}

// How tall the drawer is *going* to be, not how tall it is right now.
// .prep-notes-body transitions its height, and applyPrepNotesCollapsed()
// recalculates the layout the moment it changes it - so reading offsetHeight
// off the DOM there measures the value being animated away from. Collapsing
// read the drawer as still open and left dead space under the video;
// re-expanding read it as still collapsed, oversized the video, and pushed
// the question and record button clean out of the panel.
function prepNotesDrawerHeight() {
  if (prepNotesRow.hidden) return 0;
  return prepNotesChromeHeight() + (prepNotesCollapsed ? 0 : prepNotesHeight);
}

function updateViewfinderSize() {
  viewfinderEl.style.flex = "0 0 auto";

  const panelStyle = getComputedStyle(recorderPanelEl);
  const horizontalPadding = parseFloat(panelStyle.paddingLeft) + parseFloat(panelStyle.paddingRight);
  const gap = parseFloat(panelStyle.rowGap) || 0;
  const availableWidth = recorderPanelEl.clientWidth - horizontalPadding;

  reconcilePrepNotesHeight();

  let availableHeight = computeAvailableHeightForVideoAndNotes();
  if (!prepNotesRow.hidden) {
    // One more gap between the player/controls and the drawer itself.
    availableHeight -= prepNotesDrawerHeight() + gap;
  }
  // This sizes the video to exactly fill what's left, and .recorder-panel's
  // overflow-y:auto turns any positive overflow into a real scrollbar - even
  // a fraction of a pixel. getComputedStyle/offsetHeight can round slightly
  // differently between rendering engines (WebView2 vs WebKitGTK vs
  // WKWebView), so an exact-fit computation that holds on one can overflow
  // by a hair on another. A small deliberate margin costs nothing visible
  // and removes that whole class of engine-dependent scrollbar.
  availableHeight -= LAYOUT_SAFETY_MARGIN;

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

  // Keep the review-mode info bar, and the camera toggle/waveform row,
  // the same width as the player itself - otherwise they stretch to the
  // panel's full width (via .recorder-panel's flex stretch) and drift away
  // from the video's actual left edge whenever the panel is wider than the
  // aspect-ratio-locked, centered video (e.g. with both side panels
  // retracted).
  viewfinderMetaEl.style.width = `${finalWidth}px`;
  cameraToggleRowEl.style.width = `${finalWidth}px`;
}

function initViewfinderSizing() {
  updateViewfinderSize();
  new ResizeObserver(updateViewfinderSize).observe(recorderPanelEl);
}

function syncPrepNotesBodyHeight() {
  if (prepNotesCollapsed) return;
  prepNotesBodyEl.style.height = `${prepNotesHeight}px`;
  prepNotesBodyEl.style.maxHeight = `${prepNotesHeight}px`;
}

function applyPrepNotesCollapsed() {
  prepNotesRow.classList.toggle("collapsed", prepNotesCollapsed);
  if (prepNotesCollapsed) {
    prepNotesBodyEl.style.height = "0px";
    prepNotesBodyEl.style.maxHeight = "0px";
  } else {
    syncPrepNotesBodyHeight();
  }
  // Collapsing/expanding changes how much of the panel the drawer takes up.
  updateViewfinderSize();
}

async function initPrepNotesToggle() {
  prepNotesCollapsed = await getPrepNotesCollapsed();
  applyPrepNotesCollapsed();

  prepNotesToggleBtn.addEventListener("click", () => {
    prepNotesCollapsed = !prepNotesCollapsed;
    applyPrepNotesCollapsed();
    setPrepNotesCollapsed(prepNotesCollapsed);
  });
}

// How tall the notes drawer is allowed to grow: whatever's left in the panel
// after the always-visible chrome, minus enough to keep the player at a
// sane minimum size - resizing notes shouldn't be able to squeeze the video
// down to nothing.
function computeMaxPrepNotesHeight() {
  const available = computeAvailableHeightForVideoAndNotes();
  const gap = parseFloat(getComputedStyle(recorderPanelEl).rowGap) || 0;
  const maxForBody = available - MIN_VIDEO_HEIGHT - gap - prepNotesChromeHeight();
  return Math.max(PREP_NOTES_MIN_HEIGHT, maxForBody);
}

// The saved/dragged height is only ever checked against available space
// while actively dragging - reshrinking the window afterwards (or loading a
// height saved on a bigger window) left it stale, overflowing the panel and
// pushing the record button out of view instead of shrinking to fit. Called
// on every size recalculation so it can never go stale again. Doesn't
// persist the clamp - that would overwrite the user's real preference just
// because the window happened to be small at the time.
function reconcilePrepNotesHeight() {
  if (prepNotesRow.hidden || prepNotesCollapsed) return;
  const max = computeMaxPrepNotesHeight();
  if (prepNotesHeight > max) {
    prepNotesHeight = max;
    syncPrepNotesBodyHeight();
  }
}

async function initPrepNotesResize() {
  // initPrepNotesToggle runs right after this and applies it (collapsed or
  // not), so there's no need to touch the DOM with it here too.
  prepNotesHeight = (await getPrepNotesHeight()) ?? PREP_NOTES_DEFAULT_HEIGHT;

  prepNotesResizeHandleEl.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = prepNotesBodyEl.offsetHeight;
    prepNotesResizeHandleEl.classList.add("dragging");
    prepNotesBodyEl.classList.add("resizing");

    function onMove(moveEvent) {
      const deltaY = startY - moveEvent.clientY; // dragging up grows the drawer
      const max = computeMaxPrepNotesHeight();
      prepNotesHeight = Math.min(max, Math.max(PREP_NOTES_MIN_HEIGHT, startHeight + deltaY));
      syncPrepNotesBodyHeight();
      updateViewfinderSize();
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      prepNotesResizeHandleEl.classList.remove("dragging");
      prepNotesBodyEl.classList.remove("resizing");
      setPrepNotesHeight(prepNotesHeight);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

const WHISPER_WPM_HINT =
  "Off by default. When on, your recording is transcribed on this device after you stop it, to measure words per minute and save a transcript you can review afterward.";

async function initWpmToggle() {
  wpmToggleHint.textContent = WHISPER_WPM_HINT;
  wpmEnabled = await getWpmEnabled();
  wpmToggleInput.checked = wpmEnabled;

  wpmToggleInput.addEventListener("change", async () => {
    const turningOn = wpmToggleInput.checked;
    if (turningOn && !(await getWhisperModelDownloaded())) {
      // Settings and the confirm dialog share the same overlay styling/
      // z-index, so with Settings still open the confirm dialog would be
      // fully covered by it (and unclickable) - close Settings out of the
      // way first, then bring the confirm prompt forward on its own.
      document.getElementById("settings-overlay").hidden = true;
      // keepOpenOnConfirm: true - clicking Download carries this same
      // dialog through into the progress state below, rather than closing
      // it and leaving the only feedback a hint line in Settings (which is
      // exactly where the user isn't looking, since Settings just closed).
      const confirmed = await showConfirm({
        title: "Download speech model?",
        message:
          "Speech pace (WPM) needs a one-time ~60MB download (a local speech-to-text model). After that, it runs fully on this device - nothing is uploaded per recording.",
        confirmLabel: "Download",
        keepOpenOnConfirm: true,
      });
      if (!confirmed) {
        wpmToggleInput.checked = false;
        return;
      }

      wpmToggleInput.disabled = true;
      wpmToggleHint.textContent = "Downloading speech model…";
      setModalProgress({
        title: "Downloading speech model…",
        message: "This happens once. It'll run fully on this device from now on.",
        percent: 0,
      });

      const unlisten = await listen("whisper-download-progress", (event) => {
        const { downloaded, total } = event.payload;
        const percent = total ? Math.round((downloaded / total) * 100) : null;
        setModalProgress({
          percent,
          detail: total ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : formatBytes(downloaded),
        });
      });

      try {
        await invoke("download_whisper_model");
        await setWhisperModelDownloaded(true);
        // Waited on, not fire-and-forget - the user asked to be told
        // explicitly that the download finished, not have the dialog just
        // vanish and leave them to notice the toggle is now enabled.
        await finishModal({
          title: "Speech model downloaded",
          message: "Speech pace (WPM) is ready to use.",
        });
      } catch (err) {
        console.error("Failed to download speech model", err);
        // showAlert() reconfigures the same still-open dialog (title,
        // message, buttons, hides the progress bar) rather than needing a
        // separate close step first.
        await showAlert({ title: "Download failed", message: String(err?.message ?? err) });
        wpmToggleInput.checked = false;
        wpmToggleInput.disabled = false;
        wpmToggleHint.textContent = WHISPER_WPM_HINT;
        unlisten();
        return;
      }
      unlisten();
      wpmToggleInput.disabled = false;
      wpmToggleHint.textContent = WHISPER_WPM_HINT;
    }
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
  onPrepNotesChange = options.onPrepNotesChange ?? (() => {});

  recordBtn.addEventListener("click", toggleRecording);
  backToLiveBtn.addEventListener("click", exitReviewMode);
  reviewTranscriptSettingsBtn.addEventListener("click", onOpenSettings);
  cameraToggleBtn.addEventListener("click", toggleCamera);
  prepNotesInput.addEventListener("blur", () => {
    if (currentQuestion) onPrepNotesChange(currentQuestion.id, prepNotesInput.value);
  });
  enableTabIndent(prepNotesInput);
  enableTabIndent(reviewNotesInput);
  updateCameraToggleUI();
  initViewfinderSizing();
  sizeWaveformCanvas();
  waveformStrokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || waveformStrokeStyle;
  drawIdleWaveform();
  new ResizeObserver(() => {
    sizeWaveformCanvas();
    if (!mediaRecorder || mediaRecorder.state !== "recording") drawIdleWaveform();
  }).observe(waveformCanvasEl);
  await initWpmToggle();
  await initPrepNotesResize();
  await initPrepNotesToggle();

  // Restore last session's camera state - but only ever from here, once, at
  // startup. Every other path to the camera turning on is still the toggle
  // button itself, so this can only ever resume a state the user themselves
  // already chose (and already granted permission for), never surprise a
  // first-time user with a cold permission prompt.
  if (options.cameraEnabled) {
    enableCamera();
  }
}
