import { initQuestions } from "./questions.js";

const clockEl = document.getElementById("clock");
const currentQuestionEl = document.getElementById("current-question");

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
}

function handleQuestionSelectionChange(question) {
  currentQuestionEl.textContent = question ? question.text : "Select a question to begin.";
}

async function init() {
  tickClock();
  setInterval(tickClock, 1000);

  await initQuestions({ onSelectionChange: handleQuestionSelectionChange });
}

init();
