import { formatTimer } from "./util.js";

const previewEl = document.getElementById("preview");
const viewfinderEmptyEl = document.getElementById("viewfinder-empty");
const recIndicatorEl = document.getElementById("rec-indicator");
const timerEl = document.getElementById("timer");
const recordBtn = document.getElementById("record-btn");

let stream = null;
let mediaRecorder = null;
let chunks = [];
let recordStartTs = 0;
let timerInterval = null;
let hasSelection = false;
let onRecordingComplete = () => {};
let getSelectedQuestion = () => null;

async function initCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    previewEl.srcObject = stream;
    viewfinderEmptyEl.hidden = true;
  } catch (err) {
    viewfinderEmptyEl.textContent = "Camera access denied or unavailable.";
    console.error("Failed to access camera/microphone", err);
  }
  updateRecordButtonState();
}

function updateRecordButtonState() {
  const recording = mediaRecorder && mediaRecorder.state === "recording";
  recordBtn.disabled = !recording && (!hasSelection || !stream);
}

function updateTimer() {
  timerEl.textContent = formatTimer(Date.now() - recordStartTs);
}

function startRecording() {
  if (!stream) return;

  chunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm" });
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
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

async function handleStop() {
  clearInterval(timerInterval);
  recIndicatorEl.hidden = true;
  timerEl.textContent = "00:00.0";
  recordBtn.textContent = "Record";
  recordBtn.classList.remove("recording");
  updateRecordButtonState();

  const durationMs = Date.now() - recordStartTs;
  const blob = new Blob(chunks, { type: "video/webm" });
  const question = getSelectedQuestion();
  if (question) {
    await onRecordingComplete({ blob, durationMs, question });
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

export async function initRecorder(options = {}) {
  onRecordingComplete = options.onRecordingComplete ?? (() => {});
  getSelectedQuestion = options.getSelectedQuestion ?? (() => null);

  recordBtn.addEventListener("click", toggleRecording);
  await initCamera();
}
