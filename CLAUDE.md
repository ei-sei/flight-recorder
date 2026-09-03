# Flight Recorder

A local desktop app for practising job interviews on webcam. Built with Tauri. Runs fully on the user's machine — video, notes and speech-to-text alike. Nothing about a recording is ever uploaded, on any platform.

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
- Response delay: measures time from record start to first speech. Uses mic volume. Fully local. Works in any browser/webview. The threshold is *adaptive* — it tracks the room's noise floor (`trackNoiseFloor`) and requires speech to sit `SPEECH_NOISE_MULTIPLIER`× above it, because auto gain control is deliberately off (see below) and raw mic levels differ enormously between a headset and a laptop array. A fixed threshold would miss a quiet speaker or trip on room hum.
- Speech analysis in review: pause count, longest pause, and talking ratio. All derived from the same mic-level loop as response delay, *not* from a transcript — so it works identically on every platform, including Windows, and needs no speech recognition turned on. Pauses only count after the first word (the gap before it is the response delay, measured separately) and need `PAUSE_MIN_MS` of quiet; `SILENCE_HOLD_MS` of hysteresis stops the dips between syllables registering as pauses.
- Filler-word count: shown only when a transcript exists. Best-effort by nature — Whisper keeps fillers far better than a browser speech API did, but still inconsistently, since it transcribes for readability rather than stenographic accuracy. A zero means "none survived transcription", not "none said". The pause figures are the trustworthy signal; treat fillers as a bonus and don't build anything load-bearing on them.
- Auto gain control is off (`autoGainControl: false`). AGC normalises volume in real time, so quiet hesitant speech gets boosted to sound confident and projection gets pulled down — it flattens exactly the dynamic range the user is here to review. Noise suppression is a user setting instead of a hardcoded `true`: it helps in a noisy room and helps transcription, but trims breaths and quiet trailing words. Both constraints bake in at `getUserMedia` time, so changing either has to reacquire the stream.
- Speech pace (WPM): word-per-minute estimate plus a transcript, shown read-only during review when present. One backend on every platform — a local Whisper model (`whisper-rs`/whisper.cpp, see `src-tauri/src/whisper.rs`), run after the recording stops. The model (~60MB) downloads once, on first use, to the OS app-data directory (not the portable `Videos/flight-recorder` folder - it's app infrastructure, not user data), gated behind an explicit confirmation dialog before it fetches anything. Windows used to use the browser's `SpeechRecognition` API instead, live during recording; that was dropped deliberately. It was the only thing in the app that sent audio off-device, it produced different WPM numbers from Whisper for identical speech (useless in an app about tracking progress), and it silently stripped filler words, which broke the filler count. Live updating was the only thing lost, and you're talking rather than reading a counter while it would have mattered. **Don't reintroduce a second backend** — the cost of two is exactly what this removed.

## Data rules
- Video files write straight to disk, in a folder structure like `videos/{category}/{date}_{question-slug}.mp4`. Recording targets **MP4/H.264/AAC on every platform** — it's the only container/codec combination all three target webviews can play back, which the portable library folder depends on (a WebM recorded on Windows won't open once the folder is copied to a Mac). `RECORDING_FORMAT_CANDIDATES` in `recorder.js` tries H.264 High → Main → Baseline profiles, then generic MP4, and only falls back to WebM/VP9 on an engine with no H.264 encoder at all. Audio must stay AAC (`mp4a.40.2`) — Chromium will put Opus in an MP4 and Safari won't play it. The extension is still whatever `MediaRecorder` actually negotiated, so never assume one when reading a video path back.
- Recording is held to the quality preset, not to whatever the camera happens to hand back. `getUserMedia` constraints are `ideal`, so a webcam with no 480p mode returns 720p; `computeRecordingSize()` sizes the watermark canvas to the preset (capped by the source, never upscaling) and `drawCoverFrame()` centre-crops rather than stretching a non-16:9 camera. Sizing off the camera's native resolution instead would silently record more pixels than the chosen bitrate can carry.
- Bitrates assume a low-motion talking head in H.264 at 24fps (`WATERMARK_FPS`). Audio stays at 128k — for an app about reviewing your own speech and cadence, audio is the primary signal and isn't where to save space. Don't drop the frame rate below 24 either; gesture and delivery are what the video half is actually for.
- Metadata (questions, scores, notes, delay, WPM, transcript) saves via `tauri-plugin-store` to `library.json`, deliberately placed *inside* `Videos/flight-recorder/` (next to the video files it describes) rather than the OS-hidden app-data directory. The whole `flight-recorder` folder is meant to be one portable, self-contained unit — copy it to a different machine (even a different OS) and it just works, no export/import step. This only holds if `attempt.videoRelativePath` stays relative to that folder (never store an absolute path there) - `resolveVideoPath()` in `attempts.js` is the only place that turns it back into a real path, resolved against wherever the *current* machine's Videos folder is.
- Nothing is ever deleted automatically. Recordings accumulate indefinitely (roughly 34GB/year at daily 10-minute practice), which is a deliberate choice — the user wants old clips around to see how far they've come. Settings shows the folder's total size (`get_library_size`) so the number is at least visible. If auto-pruning is ever revisited, it must keep the first attempt at each question, since that's the actual benchmark being compared against.
- Nothing about a recording ever leaves the machine. Not video, not audio, not transcripts. The app touches the network in exactly two places: the one-off Whisper model download (opt-in, behind a confirmation dialog) and update checks. That's the whole list, and it's what the footer and About modal now claim unconditionally — so never add a third without flagging it first and changing that copy to match.

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
- Every platform needs CMake, a C++ toolchain, and libclang to build `whisper-rs` (local speech-to-text) — its build script compiles whisper.cpp, and bindgen needs libclang. Already wired into `ci.yml`/`release.yml`. Two platform-specific gotchas, both already handled, both of which cost a failed release to find: macOS needs `CMAKE_OSX_DEPLOYMENT_TARGET` (not `MACOSX_DEPLOYMENT_TARGET` — `whisper-rs-sys`'s build.rs only forwards `CMAKE_`-prefixed env vars), and Windows needs `LIBCLANG_PATH` set explicitly with a pinned LLVM, because bindgen doesn't find libclang on GitHub's runner image by itself and the image's LLVM version drifts between runs.

## How to work in this project
- Extend the existing code. Don't rewrite from scratch unless asked.
- If a feature needs something beyond Tauri/webview capability, say so plainly. Don't fake it.
- Keep responses in short, simple sentences.
