# Flight Recorder

A local desktop app for practicing job interviews on webcam. Built with Tauri. Runs fully on the user's machine. No cloud storage of video or data, except for live speech-to-text (see below).

## Stack
- Tauri (Rust backend, native OS webview frontend).
- Frontend is plain HTML/CSS/JS. No React or Vue.
- `tauri-plugin-store` for questions, scores, notes, and attempt metadata (real local JSON file, not browser storage).
- `tauri-plugin-fs` for saving video files to disk. No manual downloads.
- `tauri-plugin-opener` for "show in folder".
- `tauri-plugin-window-state` to remember window size/position across launches.
- Confirmation prompts (delete question/attempt) are an in-app modal, not the native OS dialog — keeps the UI visually consistent with the rest of the app.

## Core features
- Question bank, organized by category (Behavioral, Technical, Case). User can add and remove questions.
- Live webcam viewfinder using `getUserMedia`. Record/stop tied to the selected question.
- Each recording becomes a logged attempt. Captures question, category, date, and duration automatically.
- User adds a star score and notes after reviewing.
- Filter tabs over the attempt log (All / Behavioral / Technical / Case).
- Response delay: measures time from record start to first speech. Uses mic volume. Fully local. Works in any browser/webview.
- Speech pace (WPM): live word-per-minute estimate using the browser's built-in speech recognition. Only works in Chrome/Edge-based webviews. Sends audio to Google's servers for this feature only. Everything else stays local.

## Data rules
- Video files write straight to disk, in a folder structure like `videos/{category}/{date}_{question-slug}.webm`.
- Metadata (questions, scores, notes, delay, WPM, transcript) saves via `tauri-plugin-store`.
- Be upfront about the one feature that isn't fully local: WPM. Never silently expand what talks to the internet without flagging it first.

## Design language
(Revised — supersedes the original hairline-cockpit direction below.)
Dark, sleek, card-based. Near-black navy base with rounded panel cards (soft shadows, not hairline dividers). Blue/indigo as the primary accent (buttons, active tabs, selection, focus rings). Red for recording state and destructive actions. Gold for star ratings only. Segmented pill-style filter tabs. Generous padding/whitespace. Monospace for timers and numeric readouts. Sentence-case labels. Smooth transitions and soft glow effects on hover/active states rather than hard color swaps.

Do not fabricate decorative metrics or visualizations for capabilities the app doesn't have (e.g. no fake "eye contact" or "clarity" score charts) — only real data (response delay, WPM, star score, notes) gets shown.

<details>
<summary>Original design language (superseded)</summary>

Aviation instrumentation. Dark cockpit palette. Amber for recording/active states. Teal for positive/save actions. Monospace timer and data readouts. Sentence-case labels. Hairline dividers, not rounded shadow cards.

</details>

## How to work in this project
- Extend the existing code. Don't rewrite from scratch unless asked.
- If a feature needs something beyond Tauri/webview capability, say so plainly. Don't fake it.
- Keep responses in short, simple sentences.
