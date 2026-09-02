# Flight Recorder

A local desktop app for practising job interviews on webcam. Built with Tauri. Runs fully on the user's machine. No cloud storage of video or data, except for live speech-to-text (see below).

## Stack
- Tauri (Rust backend, native OS webview frontend).
- Frontend is plain HTML/CSS/JS. No React or Vue.
- `tauri-plugin-store` for questions, scores, notes, and attempt metadata (real local JSON file, not browser storage).
- `tauri-plugin-fs` for saving video files to disk. No manual downloads.
- `tauri-plugin-opener` for "show in folder".
- `tauri-plugin-window-state` to remember window size/position across launches.
- Confirmation prompts (delete question/attempt) are an in-app modal, not the native OS dialog — keeps the UI visually consistent with the rest of the app.

## Core features
- Question bank, organised by category (Behavioural, Technical, Case). User can add and remove questions.
- Live webcam viewfinder using `getUserMedia`. Record/stop tied to the selected question.
- Each recording becomes a logged attempt. Captures question, category, date, and duration automatically.
- User adds a star score and notes after reviewing.
- Filter tabs over the attempt log (All / Behavioural / Technical / Case).
- Response delay: measures time from record start to first speech. Uses mic volume. Fully local. Works in any browser/webview.
- Speech pace (WPM): live word-per-minute estimate using the browser's built-in speech recognition. Only works in Chrome/Edge-based webviews. Sends audio to Google's servers for this feature only. Everything else stays local. Also saves the resulting transcript, shown read-only during review when present, and the recogniser's average confidence across the recording, shown as "X% confidence" alongside delay/WPM in review — a real signal from the same recogniser already in use, not a fabricated score.

## Data rules
- Video files write straight to disk, in a folder structure like `videos/{category}/{date}_{question-slug}.webm`. Actual extension is whatever the webview's `MediaRecorder` can support — `.webm` (VP8/VP9+Opus) on Chromium/WebKitGTK, falling back to `.mp4` (H.264) on engines that don't support WebM recording (historically Safari/WKWebView). Never assume `.webm` when reading a video path back.
- Metadata (questions, scores, notes, delay, WPM, transcript, speech confidence) saves via `tauri-plugin-store`.
- Be upfront about the one feature that isn't fully local: WPM. Never silently expand what talks to the internet without flagging it first.

## Design language
(Revised again — supersedes the card-based direction below.)
Dark, sleek, flat editor-style chrome. Near-black navy base. Panels are tightly packed with a small (6px) gap between them, each with its own complete hairline border — no shared/single-line dividers, no rounded corners, no drop shadows. A permanent left activity rail (icon strip) selects sidebar content. Blue/indigo as the primary accent (buttons, active tabs, selection, focus rings). Red for recording state and destructive actions. Gold for star ratings only. Segmented pill-style filter tabs are the one deliberately rounded/card-like control, kept as an accent against the otherwise flat chrome. Efficient, compact padding — not generous whitespace. Monospace for timers and numeric readouts. Sentence-case labels. Smooth transitions and soft glow effects on hover/active states rather than hard colour swaps.

Do not fabricate decorative metrics or visualizations for capabilities the app doesn't have (e.g. no fake "eye contact" or "clarity" score charts) — only real data (response delay, WPM, transcript, speech recognition confidence, star score, notes) gets shown.

<details>
<summary>Card-based design language (superseded)</summary>

Dark, sleek, card-based. Near-black navy base with rounded panel cards (soft shadows, not hairline dividers). Generous padding/whitespace. Otherwise same accent colors as current.

</details>

<details>
<summary>Original design language (superseded)</summary>

Aviation instrumentation. Dark cockpit palette. Amber for recording/active states. Teal for positive/save actions. Monospace timer and data readouts. Sentence-case labels. Hairline dividers, not rounded shadow cards.

</details>

## Cross-platform packaging notes
- Camera/mic access uses standard `getUserMedia`/`MediaRecorder` — works natively on all three target webviews (WebView2/Windows, WebKitGTK/Linux, WKWebView/macOS). No plugin needed for capture itself.
- macOS requires privacy usage descriptions or `getUserMedia` is blocked outright in a packaged app (not just prompt-less — actually fails). `src-tauri/Info.plist` declares `NSCameraUsageDescription` and `NSMicrophoneUsageDescription`, which Tauri merges into the bundle automatically. This hasn't been verified end-to-end on real macOS hardware yet — do that before shipping a Mac build.
- Windows: WebView2 triggers the OS-level camera/mic privacy prompt automatically, no extra manifest entries needed.
- Linux: access depends on the user being in the right device group (e.g. `video`) and the distro's desktop environment; no extra packaging step needed on our side.

## How to work in this project
- Extend the existing code. Don't rewrite from scratch unless asked.
- If a feature needs something beyond Tauri/webview capability, say so plainly. Don't fake it.
- Keep responses in short, simple sentences.
