import { initQuestions, getSelectedQuestion, selectQuestionById } from "./questions.js";
import { initRecorder, setRecordEnabled, enterReviewMode, exitReviewMode } from "./recorder.js";
import {
  initAttempts,
  saveAttempt,
  clearReviewing,
  setSelectedQuestion,
  updateAttemptNotes,
  updateAttemptScore,
} from "./attempts.js";

const clockEl = document.getElementById("clock");
const currentQuestionEl = document.getElementById("current-question");

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
}

function handleQuestionSelectionChange(question) {
  currentQuestionEl.textContent = question ? question.text : "Select a question to begin.";
  setRecordEnabled(Boolean(question));
  setSelectedQuestion(question);
}

function initWindowControls() {
  const { getCurrentWindow } = window.__TAURI__.window;
  const appWindow = getCurrentWindow();

  document.getElementById("win-minimize").addEventListener("click", () => appWindow.minimize());
  document.getElementById("win-maximize").addEventListener("click", () => appWindow.toggleMaximize());
  document.getElementById("win-close").addEventListener("click", () => appWindow.close());

  for (const handle of document.querySelectorAll(".resize-handle")) {
    handle.addEventListener("mousedown", (event) => {
      if (event.buttons === 1) {
        appWindow.startResizeDragging(handle.dataset.resizeDir);
      }
    });
  }
}

async function init() {
  tickClock();
  setInterval(tickClock, 1000);
  initWindowControls();

  await initAttempts({
    onPlay: (attempt, attemptNumber) => {
      selectQuestionById(attempt.questionId);
      enterReviewMode(attempt, attemptNumber);
    },
    onExitReview: exitReviewMode,
  });
  await initQuestions({ onSelectionChange: handleQuestionSelectionChange });
  await initRecorder({
    getSelectedQuestion,
    onRecordingComplete: saveAttempt,
    onExitReview: () => {
      handleQuestionSelectionChange(getSelectedQuestion());
      clearReviewing();
    },
    onNotesChange: updateAttemptNotes,
    onScoreChange: updateAttemptScore,
  });
}

init();
