import { initQuestions, getSelectedQuestion } from "./questions.js";
import { initRecorder, setRecordEnabled } from "./recorder.js";
import { initAttempts, saveAttempt } from "./attempts.js";

const clockEl = document.getElementById("clock");
const currentQuestionEl = document.getElementById("current-question");

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
}

function handleQuestionSelectionChange(question) {
  currentQuestionEl.textContent = question ? question.text : "Select a question to begin.";
  setRecordEnabled(Boolean(question));
}

async function init() {
  tickClock();
  setInterval(tickClock, 1000);

  await initAttempts();
  await initQuestions({ onSelectionChange: handleQuestionSelectionChange });
  await initRecorder({
    getSelectedQuestion,
    onRecordingComplete: saveAttempt,
  });
}

init();
