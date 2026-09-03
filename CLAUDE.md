# Flight Recorder

A local desktop app for practising job interviews on webcam. Built with Tauri. Runs fully on the user's machine. No cloud storage of video or data, except for speech-to-text on Windows (see below) - macOS/Linux transcribe locally instead.

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
- Speech pace (WPM): word-per-minute estimate plus a transcript, shown read-only during review when present. Two backends depending on platform: Windows uses the browser's built-in speech recognition, live during recording - this is the one thing that sends audio off-device (to Google's servers), disclosed in Settings and the footer. macOS/Linux instead run a local Whisper model (`whisper-rs`/whisper.cpp, see `src-tauri/src/whisper.rs`) after the recording stops - fully on-device, at the cost of not updating live. The model (~60MB) downloads once, on first use, to the OS app-data directory (not the portable `Videos/flight-recorder` folder - it's app infrastructure, not user data), gated behind an explicit confirmation dialog before it fetches anything.

## Data rules
- Video files write straight to disk, in a folder structure like `videos/{category}/{date}_{question-slug}.mp4`. Recording targets **MP4/H.264/AAC on every platform** — it's the only container/codec combination all three target webviews can play back, which the portable library folder depends on (a WebM recorded on Windows won't open once the folder is copied to a Mac). `RECORDING_FORMAT_CANDIDATES` in `recorder.js` tries H.264 High → Main → Baseline profiles, then generic MP4, and only falls back to WebM/VP9 on an engine with no H.264 encoder at all. Audio must stay AAC (`mp4a.40.2`) — Chromium will put Opus in an MP4 and Safari won't play it. The extension is still whatever `MediaRecorder` actually negotiated, so never assume one when reading a video path back.
- Recording is held to the quality preset, not to whatever the camera happens to hand back. `getUserMedia` constraints are `ideal`, so a webcam with no 480p mode returns 720p; `computeRecordingSize()` sizes the watermark canvas to the preset (capped by the source, never upscaling) and `drawCoverFrame()` centre-crops rather than stretching a non-16:9 camera. Sizing off the camera's native resolution instead would silently record more pixels than the chosen bitrate can carry.
- Bitrates assume a low-motion talking head in H.264 at 24fps (`WATERMARK_FPS`). Audio stays at 128k — for an app about reviewing your own speech and cadence, audio is the primary signal and isn't where to save space. Don't drop the frame rate below 24 either; gesture and delivery are what the video half is actually for.
- Metadata (questions, scores, notes, delay, WPM, transcript) saves via `tauri-plugin-store` to `library.json`, deliberately placed *inside* `Videos/flight-recorder/` (next to the video files it describes) rather than the OS-hidden app-data directory. The whole `flight-recorder` folder is meant to be one portable, self-contained unit — copy it to a different machine (even a different OS) and it just works, no export/import step. This only holds if `attempt.videoRelativePath` stays relative to that folder (never store an absolute path there) - `resolveVideoPath()` in `attempts.js` is the only place that turns it back into a real path, resolved against wherever the *current* machine's Videos folder is.
- Be upfront about the one feature that isn't fully local: WPM. On Windows that's an ongoing per-recording exception (audio to Google); on macOS/Linux it's a one-time model download, gated behind an explicit confirmation dialog before it fetches anything. Never silently expand what talks to the internet without flagging it first.

## Design language
(Revised again — supersedes the card-based direction below.)
Dark, sleek, flat editor-style chrome. Near-black navy base. Panels are tightly packed with a small (6px) gap between them, each with its own complete hairline border — no shared/single-line dividers, no rounded corners, no drop shadows. A permanent left activity rail (icon strip) selects sidebar content. Blue/indigo as the primary accent (buttons, active tabs, selection, focus rings). Red for recording state and destructive actions. Gold for star ratings only. Segmented pill-style filter tabs are the one deliberately rounded/card-like control, kept as an accent against the otherwise flat chrome. Efficient, compact padding — not generous whitespace. Monospace for timers and numeric readouts. Sentence-case labels. Smooth transitions and soft glow effects on hover/active states rather than hard colour swaps.

Do not fabricate decorative metrics or visualizations for capabilities the app doesn't have (e.g. no fake "eye contact" or "clarity" score charts) — only real data (response delay, WPM, transcript, star score, notes) gets shown.

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
- macOS/Linux builds only (see `src-tauri/Cargo.toml`'s `cfg(not(target_os = "windows"))` dependencies) need CMake, a C++ toolchain, and libclang installed to build `whisper-rs` (local speech-to-text) - already wired into `ci.yml`/`release.yml`. Windows never compiles this dependency at all, so its build/install size is untouched.

## How to work in this project
- Extend the existing code. Don't rewrite from scratch unless asked.
- If a feature needs something beyond Tauri/webview capability, say so plainly. Don't fake it.
- Keep responses in short, simple sentences.
