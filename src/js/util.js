export function slugify(text) {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "question";
}

export function shortDateStamp(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

export function watermarkDateStamp(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy}`;
}

// Initials of each word, dropping single-letter words (like "a"/"I") so
// short connective words don't drown out the words that actually carry the
// question's meaning - "Describe a project you're proud of and why." becomes
// "dpypoaw" rather than a long slugified sentence.
export function abbreviateQuestion(text) {
  const initials = text
    .split(/\s+/)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((word) => word.length > 1)
    .map((word) => word[0])
    .join("");
  return initials.toLowerCase() || "q";
}

export function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatTimer(ms) {
  const totalTenths = Math.floor(ms / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function formatResponseDelay(ms) {
  if (ms === null || ms === undefined) return null;
  return `delay ${(ms / 1000).toFixed(1)}s`;
}

export function formatWpm(wpm) {
  if (wpm === null || wpm === undefined) return null;
  return `${Math.round(wpm)} wpm`;
}

export function formatConfidence(confidence) {
  if (confidence === null || confidence === undefined) return null;
  return `${Math.round(confidence * 100)}% confidence`;
}

export function autosizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function renderStars(container, score, onChange, readOnly = false) {
  container.innerHTML = "";
  container.classList.toggle("readonly", readOnly);
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("button");
    star.type = "button";
    star.className = "star" + (i <= score ? " filled" : "");
    star.textContent = i <= score ? "★" : "☆";
    star.title = `${i} star${i === 1 ? "" : "s"}`;
    if (readOnly) {
      star.disabled = true;
    } else {
      star.addEventListener("click", () => onChange(i === score ? 0 : i));
    }
    container.appendChild(star);
  }
}
