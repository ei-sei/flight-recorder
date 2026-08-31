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
import { showContextMenu } from "./contextmenu.js";
import { showAlert } from "./modal.js";

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

function initHelpMenu() {
  const helpBtn = document.getElementById("help-btn");

  helpBtn.addEventListener("click", () => {
    const rect = helpBtn.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4, [
      {
        label: "Updates",
        onClick: async () => {
          const { getVersion } = window.__TAURI__.app;
          const version = await getVersion();
          showAlert({
            title: "Updates",
            message: `You're on version ${version}. Automatic update checking isn't set up yet.`,
          });
        },
      },
      {
        label: "About",
        onClick: async () => {
          const { getVersion } = window.__TAURI__.app;
          const version = await getVersion();
          showAlert({
            title: "About Flight recorder",
            message: `Version ${version}. A local practice tool for interview questions on webcam — video and data stay on this device except for the opt-in speech-pace (WPM) feature.`,
          });
        },
      },
    ]);
  });
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
  initHelpMenu();

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
