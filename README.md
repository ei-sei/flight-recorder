# Flight recorder

A local desktop app for practising job interviews on webcam. Built with Electron. Runs fully on your machine - video, notes and speech-to-text alike. Nothing about a recording is ever uploaded.

| Recording | Reviewing |
| --- | --- |
| ![Recording view](screenshots/record.png) | ![Review view with transcript](screenshots/review.png) |

## Download

Grab the latest installer from the [Releases page](https://github.com/ei-sei/flight-recorder/releases/latest) - no build step needed.

- **Windows**: download `flight-recorder-<version>-setup.exe` and run it, then launch "Flight recorder" from the Start menu. The installer isn't code-signed yet, so Windows SmartScreen may say it "protected your PC" - choose **More info → Run anyway**.
- **macOS** (13 Ventura or later): download the `-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel), open it, and drag the app into Applications. It isn't notarised by Apple yet, so the first launch is blocked: open **System Settings → Privacy & Security** and choose **Open Anyway**. Not yet verified on real Mac hardware.
- **Linux**: download whichever matches your distro - `.rpm` (Fedora and friends), `.deb` (Debian, Ubuntu), or `.AppImage` (most distros, nothing to install; it doesn't need FUSE). On Fedora: `sudo dnf install ./flight-recorder-<version>.x86_64.rpm`.

Once installed, updates are handled in-app: Help → Check for updates, or the bell icon in the bottom-right footer when one's available. On macOS that opens the download page, since installing in place needs an Apple-signed app.

## Features

- **Question bank** organised by category (Behavioural, Technical, Case). Add, remove and drag to reorder your own questions.
- **Webcam recorder** with a live viewfinder, record/stop tied to the selected question, and adjustable camera/microphone/quality (480p or 720p) in Settings. Captured at 24fps to MP4/H.264, so a library copied between machines still opens. A date/timer watermark is burned into the saved recording itself (not just shown live), and a live voice waveform is shown while recording.
- **Prep notes** per question, in a collapsible drawer you can resize, kept visible while you record.
- **Attempt log** - every recording is captured automatically with question, category, date, duration, and a per-question attempt number. Review any past attempt's video, rate it (1-5 stars), and add notes.
- **Filter tabs** over the attempt log (All / Behavioural / Technical / Case), and a per-question view when you select a question in the bank.
- **Response delay** - time from record start to your first word, from local mic-level analysis. The threshold adapts to your room's noise floor rather than assuming one fixed level, since raw mic sensitivity varies a lot between devices.
- **Delivery metrics** - pause count, longest pause, longest unbroken run, and talking ratio, all measured from mic level. No transcription needed, so they work on every platform with nothing enabled.
- **Speech pace (WPM)** - words-per-minute plus a transcript, transcribed on your machine by a local Whisper model after you stop recording. Off by default; the model is a one-time ~60MB download, behind a confirmation dialog. WPM counts from your first word to your last, so thinking time before answering doesn't read as slow speaking. Shows a **pace spread** (your rate in each stretch between pauses) alongside the average, which is what catches rushing the end of an answer, and a **filler-word count** from the transcript.
- **Light/dark theme**, a custom frameless window with its own titlebar, and a File/View/Help menu bar.
- **Debug info** (Help menu) - a plain-text report of the app's version, this computer's setup (graphics, display, camera and microphone) and its recent errors, ready to paste into an issue. Nothing is sent anywhere, and it leaves out transcripts, notes and questions. Help → Report an issue copies it for you.
- **Check for updates** (Help menu) checks the project's GitHub Releases for a newer version and can download, install, and restart into it. Every update is checked against a signed manifest before it's downloaded.

## Tech stack

- **[Electron](https://www.electronjs.org)** - the same bundled Chromium on every platform, so recording and playback behave identically on Windows, macOS and Linux, with nothing to install from the distro. The main process (`electron/`) is small: file access confined to the library folder, window handling, the model download and updates. The UI runs sandboxed with no Node access.
- **Frontend**: plain HTML/CSS/JS - no React, Vue, or bundler. ES modules loaded directly, served over an `app://` protocol. `src/js/platform.js` is the one file that talks to the main process.
- Camera/mic capture and recording use standard `getUserMedia`/`MediaRecorder` Web APIs. Review playback streams from disk over a `media://` protocol with seeking.
- **Speech-to-text**: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) via [`whisper-rs`](https://github.com/tazz4843/whisper-rs), built as a small separate program (`native/`, `fr-whisper`) that the app runs after each recording. Being its own process, a crash there is a failed transcription rather than a closed app. The recording's audio is decoded to 16kHz mono PCM in the app itself (via `decodeAudioData`) and handed over as a file; the helper never touches the network.
- **Packaging and updates**: [electron-builder](https://www.electron.build) and electron-updater.

## Project structure

```
flight-recorder/
├── src/                    UI (plain HTML/CSS/JS)
│   ├── index.html
│   ├── style.css
│   └── js/
│       ├── main.js          App init, menu bar, window controls, update bell
│       ├── platform.js      Everything the UI asks of the main process
│       ├── recorder.js       Webcam capture, recording, live viewfinder
│       ├── attempts.js       Attempt log, video file I/O, transcription
│       ├── questions.js      Question bank CRUD
│       ├── store.js          library.json: questions, attempts, settings
│       ├── modal.js          Confirm/alert dialogs
│       ├── contextmenu.js    Custom right-click and menu-bar dropdowns
│       └── util.js           Formatting, slugify, filenames, transcript analysis
├── electron/               Main process
│   ├── main.js               Startup, window, protocols
│   ├── library.js            File access, confined to Videos/flight-recorder
│   ├── protocols.js          app:// (the UI) and media:// (review playback)
│   ├── security.js           Permissions, navigation and network lockdown
│   ├── whisper.js            Model download and running fr-whisper
│   ├── updater.js            Updates, checked against the signed manifest
│   └── preload.cjs           The bridge the UI sees
├── native/                 fr-whisper, the speech-to-text helper (Rust)
├── build/                  App icons for every platform
├── scripts/                Dev launcher, helper build, update manifest
├── test/e2e/               End-to-end test through the real UI
├── screenshots/            Images used in this README
└── .github/
    ├── workflows/              CI, security scanning, release builds
    └── dependabot.yml
```

## Prerequisites

- **Node.js** (LTS).
- **Rust** - install via [rustup](https://rustup.rs). Only for the speech helper.
- **CMake and libclang**, for the speech helper on every platform: it compiles whisper.cpp from source, and its bindings are generated by `bindgen`, which needs libclang. Build-time only - nothing extra is needed to *run* the app.
  - **Linux**: `sudo apt install cmake build-essential libclang-dev` (Debian/Ubuntu) or `sudo dnf install cmake gcc-c++ clang-devel` (Fedora). Building the `.deb`/`.rpm` locally also needs `rpm`, and on Fedora `libxcrypt-compat`.
  - **Windows**: the MSVC C++ build tools, CMake, and LLVM. `bindgen` doesn't reliably find libclang on Windows by itself - set `LIBCLANG_PATH` to your LLVM `bin` directory (e.g. `C:\Program Files\LLVM\bin`) if the build fails looking for it.
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`) and CMake (`brew install cmake`).

## Develop

```
npm install
npm run build:helper   # the speech helper; only needed for Speech pace (WPM)
npm start
```

`npm run dev` runs it with its own library under `.dev/` (seeded with sample questions), so it can run next to an installed copy without touching your real recordings. `npm test` runs the unit tests; `npm run test:e2e` records a take through the real UI with a fake camera and microphone (set `FR_E2E_MODEL` to a model file to include transcription).

## Build installers

```
npm run build:helper
npm run dist
```

Produces this platform's installers under `dist/`.

## Releasing & auto-updates

Pushing a version tag (`git tag v2.0.0 && git push origin v2.0.0`) triggers `.github/workflows/release.yml`, which builds installers for Windows, macOS (Intel + Apple Silicon), and Linux, and uploads them to a **draft** GitHub Release along with the updater's `latest*.yml` files and a signed `update-manifest.json`.

You need to publish that draft manually (Releases → the draft → Publish) before it's live - this is intentional, so you can review the build first. Once published, the app's updater (Help → Check for updates) offers to download, install, and restart when a newer version is available.

The installers themselves aren't code-signed yet (no Authenticode or Apple Developer ID). Updates are protected separately: `update-manifest.json` lists every installer's SHA-512 and is signed with a minisign key (the private key is only the `TAURI_SIGNING_PRIVATE_KEY` repo secret, never committed); the app refuses any update whose files don't match it.

## CI & security

- **`.github/workflows/ci.yml`** - on every push/PR to `main`: syntax and unit tests, `cargo fmt`/`clippy` and a build of the speech helper (checked for AVX-512 instructions, which crashed older CPUs), and an end-to-end test that records, transcribes and plays back a take through the real UI and checks nothing touched the network. The end-to-end test also runs on Windows and macOS, where it checks recordings come out as H.264 + AAC.
- **`.github/workflows/security.yml`** - `cargo audit` (RustSec advisories) and `npm audit`, on every push/PR plus a weekly schedule so newly-disclosed advisories against unchanged dependencies still get caught.
- **`.github/dependabot.yml`** - weekly automated update PRs for Cargo, npm (including Electron, which ships Chromium and only gets security fixes for its latest three versions), and GitHub Actions.

## Data & privacy

- **Video recordings** are written straight to disk under your OS "Videos" folder: `Videos/flight-recorder/{category}/{YYMMDD}-{HHMM}-{question id}.mp4` - e.g. `260901-1405-3f9a1c2b.mp4` for a take recorded at 14:05 on 1 September 2026. The name holds nothing that can change later, so renaming a question or deleting an attempt never leaves a file misnamed. Recordings are MP4/H.264 on every platform, with AAC audio on Windows and macOS and Opus on Linux (Chromium on Linux has no AAC encoder). Both play back in the app on every platform; a Linux recording may not open in QuickTime outside it. WebM/VP9 remains a fallback for an engine without an H.264 encoder, and the extension always follows what was actually recorded. A date/timer watermark (British DD/MM/YYYY format) is composited into the video itself before it's saved, camcorder-style. Nothing about video ever leaves the machine.
- **Metadata** - the question bank, and each attempt's question, category, date, duration, score, notes, response delay, pause figures, talking ratio, WPM, pace spread and transcript - is persisted locally in `library.json` inside that same `Videos/flight-recorder/` folder (not a hidden app-data directory).
- **Nothing is deleted automatically.** Recordings accumulate for as long as you keep them - roughly 39GB a year at a daily ten-minute session, at the default 480p quality. Settings shows the folder's current size so the number isn't invisible.
- **Moving to a different computer** - `Videos/flight-recorder/` is a single, self-contained, portable folder: videos and metadata together. Copy it to a new machine (even a different OS) and launch the app - it reads `library.json` from that same location, so it just picks up where you left off. No export/import step, and it works across OSes because each attempt's video path is stored relative to that folder, not as an absolute path tied to one machine.
- **Speech pace (WPM)** transcribes on your machine, on every platform. It's **off by default**. Turning it on downloads a Whisper model once (~60MB, behind a confirmation dialog, checked against a pinned SHA-256) to your OS app-data directory - deliberately *not* the portable `Videos/flight-recorder` folder, since it's app infrastructure rather than your data. After that, transcription runs locally after each recording stops. Earlier versions used the browser's speech recognition API on Windows, which streamed audio to Google; that's been removed. The app now touches the network in exactly two places: that one-off model download, and update checks.
- Deleting an attempt removes both its metadata entry and its video file from disk.
- Deleting a question also deletes every attempt (and video file) recorded under it - the confirmation prompt tells you how many before you commit.

## Design language

Dark, sleek, flat editor-style chrome: panels are tightly packed with a small gap and each has its own complete hairline border (no shared dividers, no rounded corners, no drop shadows), with a permanent left activity rail selecting sidebar content. Blue/indigo as the primary accent, red for recording/destructive actions, gold for star ratings, segmented pill-style filter tabs as the one deliberately rounded control, monospace timers and numeric readouts, sentence-case labels, compact/efficient spacing.

## License

[MIT](LICENSE)

## Acknowledgments

Built with [Claude Code](https://claude.com/claude-code)'s assistance.
