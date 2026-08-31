# Flight Recorder

A local desktop app for practicing job interviews on webcam. Built with Tauri. Runs fully on the user's machine. No cloud storage of video or data, except for live speech-to-text (see below).

## Stack
- Tauri (Rust backend, native OS webview frontend).
- Frontend is plain HTML/CSS/JS. No React or Vue.
- `tauri-plugin-store` for questions, scores, notes, and attempt metadata (real local JSON file, not browser storage).
- `tauri-plugin-fs` for saving video files to disk. No manual downloads.
- `tauri-plugin-dialog` and `tauri-plugin-opener` as optional extras (native save dialogs, "show in folder").

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
Aviation instrumentation. Dark cockpit palette. Amber for recording/active states. Teal for positive/save actions. Monospace timer and data readouts. Sentence-case labels. Hairline dividers, not rounded shadow cards. Keep this consistent across new features.

## How to work in this project
- Extend the existing code. Don't rewrite from scratch unless asked.
- If a feature needs something beyond Tauri/webview capability, say so plainly. Don't fake it.
- Keep responses in short, simple sentences.
