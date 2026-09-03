# Flight recorder

A local desktop app for practising job interviews on webcam. Built with Tauri. Runs fully on your machine - video, notes and speech-to-text alike. Nothing about a recording is ever uploaded.

| Recording | Reviewing |
| --- | --- |
| ![Recording view](screenshots/record.png) | ![Review view with transcript](screenshots/review.png) |

## Download

Grab the latest installer from the [Releases page](https://github.com/ei-sei/flight-recorder/releases/latest) - no build step needed.

- **Windows**: download `flight-recorder_<version>_x64-setup.exe` (or the `_x64_en-US.msi`), run it, then launch "Flight recorder" from the Start menu.
- **macOS**: download `flight-recorder_<version>_x64.dmg` (Intel) or `_aarch64.dmg` (Apple Silicon), open it, and drag the app into Applications.
- **Linux**: download whichever matches your distro - `.deb`, `.rpm` (e.g. Fedora), or `.AppImage` (works on most distros without installing anything).

Once installed, updates are handled in-app: Help → Check for updates, or the bell icon in the bottom-right footer when one's available.

## Features

- **Question bank** organised by category (Behavioural, Technical, Case). Add and remove your own questions.
- **Webcam recorder** with a live viewfinder, record/stop tied to the selected question, and adjustable camera/microphone/quality (480p or 720p) in Settings. Captured at 24fps to MP4/H.264, which is the one format every platform can play back - so a library copied between machines still opens. A date/timer watermark is burned into the saved recording itself (not just shown live), and a live voice waveform is shown while recording.
- **Prep notes** per question, in a collapsible drawer you can resize, kept visible while you record.
- **Attempt log** - every recording is captured automatically with question, category, date, duration, and a per-question attempt number. Review any past attempt's video, rate it (1-5 stars), and add notes.
- **Filter tabs** over the attempt log (All / Behavioural / Technical / Case), and a per-question view when you select a question in the bank.
- **Response delay** - time from record start to your first word, from local mic-level analysis. The threshold adapts to your room's noise floor rather than assuming a fixed level, because auto gain control is deliberately switched off (see below).
- **Delivery metrics** - pause count, longest pause, longest unbroken run, and talking ratio, all measured from mic level. No transcription needed, so they work on every platform with nothing enabled.
- **Speech pace (WPM)** - words-per-minute plus a transcript, transcribed on your machine by a local Whisper model after you stop recording. Off by default; the model is a one-time ~60MB download, behind a confirmation dialog. Shows a **pace spread** (per-segment rate) alongside the average, which is what catches rushing the end of an answer, and a **filler-word count** from the transcript.
- **Audio tuned for review, not for calls** - auto gain control is off, so you hear your own dynamics rather than a flattened, normalised version of them. Noise suppression is a setting: it helps in a noisy room but trims breaths and quiet trailing words.
- **Light/dark theme**, a custom frameless window with its own titlebar and resize handles, and a File/View/Help menu bar.
- **Check for updates** (Help menu) checks the project's GitHub Releases for a newer version and can download, install, and restart into it.

## Tech stack

- **[Tauri](https://tauri.app)** (v2) - Rust backend, paired with each OS's native webview (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS) instead of bundling Chromium, which keeps the install small.
- **Frontend**: plain HTML/CSS/JS - no React, Vue, or bundler. ES modules loaded directly by the webview.
- **Plugins**: `tauri-plugin-store` (question/attempt/settings persistence), `tauri-plugin-fs` (video files), `tauri-plugin-opener` (reveal-in-folder, external links), `tauri-plugin-window-state`, `tauri-plugin-updater` + `tauri-plugin-process` (auto-updates).
- Camera/mic capture and recording use standard `getUserMedia`/`MediaRecorder` Web APIs - no native plugin needed for that part.
- **Speech-to-text**: [`whisper-rs`](https://github.com/tazz4843/whisper-rs) (whisper.cpp bindings) running locally, with [`symphonia`](https://github.com/pdeljanov/Symphonia) to decode the recording's audio track and [`rubato`](https://github.com/HEnquist/rubato) to resample it to the 16kHz mono Whisper expects. All pure Rust - no ffmpeg dependency.

## Project structure

```
flight-recorder/
├── src/                    Frontend (plain HTML/CSS/JS)
│   ├── index.html
│   ├── style.css
│   └── js/
│       ├── main.js          App init, menu bar, window controls, update bell
│       ├── recorder.js       Webcam capture, recording, live viewfinder
│       ├── attempts.js       Attempt log, video file I/O
│       ├── questions.js      Question bank CRUD
│       ├── store.js          tauri-plugin-store wrapper
│       ├── modal.js          Confirm/alert dialogs
│       ├── contextmenu.js    Custom right-click and menu-bar dropdowns
│       └── util.js           Formatting, slugify, filenames, transcript analysis
├── src-tauri/              Rust backend
│   ├── src/
│   │   ├── lib.rs            Plugin registration, window icon, commands
│   │   ├── whisper.rs        Local speech-to-text: model download, decode, transcribe
│   │   └── main.rs
│   ├── capabilities/          Permission scoping (default.json)
│   ├── icons/                 App icon set for every platform
│   ├── Info.plist             macOS camera/mic usage descriptions
│   ├── build.rs                Embeds the git commit SHA at compile time
│   └── tauri.conf.json
├── screenshots/             Images used in this README
└── .github/
    ├── workflows/              CI, security scanning, release builds
    └── dependabot.yml
```

## Prerequisites

- **Rust** - install via [rustup](https://rustup.rs).
- **Node.js** (LTS) - for the Tauri CLI (`npm install`).
- **CMake and libclang**, on every platform. `whisper-rs` compiles whisper.cpp from source, and its bindings are generated by `bindgen`, which needs libclang. This is a build-time requirement only - nothing extra is needed to *run* the app.
- **Platform system dependencies** (build-time on every OS; also a *runtime* dependency on Linux):
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `patchelf`, `build-essential`, `libssl-dev`, `libayatana-appindicator3-dev`, `libsoup-3.0-dev`, plus `cmake` and `libclang-dev`. On Debian/Ubuntu:
    ```
    sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf build-essential curl wget file libssl-dev libayatana-appindicator3-dev libsoup-3.0-dev cmake libclang-dev
    ```
    If you package as a `.deb`/`.rpm`, `libwebkit2gtk-4.1` is declared as a dependency so it installs automatically for end users. If you package as an AppImage, it does **not** bundle webkit2gtk - it must already be present on the target machine.
  - **Windows**: [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on virtually all Windows 10/11 machines; Tauri's installer fetches it if missing), the MSVC C++ build tools, CMake, and LLVM. `bindgen` doesn't reliably find libclang on Windows by itself - set `LIBCLANG_PATH` to your LLVM `bin` directory (e.g. `C:\Program Files\LLVM\bin`) if the build fails looking for it.
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`) and CMake (`brew install cmake`). WKWebView is part of the OS. Camera/mic privacy usage descriptions are declared in `src-tauri/Info.plist` - required or `getUserMedia` fails outright in a packaged build. This hasn't been verified end-to-end on real macOS hardware yet. Note the release workflow sets `CMAKE_OSX_DEPLOYMENT_TARGET=10.15`; without it whisper.cpp's use of `std::filesystem` fails to compile against Apple's libc++.

## Develop

```
npm install
npm run tauri dev
```

Under WSL/WSLg, use `npm run dev:wsl` instead - it sets the software-rendering env vars WSLg needs to show a window at all.

## Build a release bundle

```
npm run tauri build
```

Produces a platform-native installer/bundle under `src-tauri/target/release/bundle/`.

## Releasing & auto-updates

Pushing a version tag (`git tag v0.1.0 && git push origin v0.1.0`) triggers `.github/workflows/release.yml`, which builds signed installers for Windows, macOS (Intel + Apple Silicon), and Linux via [tauri-action](https://github.com/tauri-apps/tauri-action), and publishes them as a **draft** GitHub Release along with a `latest.json` manifest.

You need to publish that draft manually (Releases → the draft → Publish) before it's live - this is intentional, so you can review the build first. Once published, the app's in-app updater (Help → Check for updates) polls `releases/latest/download/latest.json` on this repo and offers to download, install, and restart when a newer version is available.

Releases are signed with a minisign-style keypair (`tauri signer generate`); the public key lives in `src-tauri/tauri.conf.json`, and the private key is stored only as the `TAURI_SIGNING_PRIVATE_KEY` repo secret - never committed.

## CI & security

- **`.github/workflows/ci.yml`** - on every push/PR to `main`: a `node --check` syntax pass over `src/js/`, then `cargo fmt --check`, `cargo clippy -D warnings`, `cargo build` on Ubuntu, plus a separate Windows build job. Windows gets its own job because whisper.cpp's build is the one part of this repo that breaks differently per platform, and it used to only be exercised at release time - which is a bad place to discover a toolchain problem.
- **`.github/workflows/security.yml`** - `cargo audit` (RustSec advisories) and `npm audit`, on every push/PR plus a weekly schedule so newly-disclosed advisories against unchanged dependencies still get caught.
- **`.github/dependabot.yml`** - weekly automated update PRs for Cargo, npm, and GitHub Actions dependencies.

## Data & privacy

- **Video recordings** are written straight to disk under your OS "Videos" folder: `Videos/flight-recorder/{category}/{YYMMDD}-a{attempt number}-{question abbreviation}-{question id}.mp4` - e.g. `260901-a2-tmatydwt-3f9a1c2b.mp4` for the second attempt at "Tell me about a time you disagreed with a teammate." Recording targets MP4/H.264/AAC on every platform, because that's the only container/codec combination all three webviews can play back - a WebM recorded on Windows wouldn't open after copying the folder to a Mac. WebM/VP9 remains a fallback for any engine without an H.264 encoder, and the extension always follows what was actually recorded. A date/timer watermark (British DD/MM/YYYY format) is composited into the video itself before it's saved, camcorder-style. Nothing about video ever leaves the machine.
- **Metadata** - the question bank, and each attempt's question, category, date, duration, score, notes, response delay, pause figures, talking ratio, WPM, pace spread and transcript - is persisted locally via `tauri-plugin-store`, in `library.json` inside that same `Videos/flight-recorder/` folder (not a hidden app-data directory).
- **Nothing is deleted automatically.** Recordings accumulate for as long as you keep them - roughly 39GB a year at a daily ten-minute session, at the default 480p quality. Settings shows the folder's current size so the number isn't invisible.
- **Moving to a different computer** - `Videos/flight-recorder/` is a single, self-contained, portable folder: videos and metadata together. Copy it to a new machine (even a different OS) and launch the app - it reads `library.json` from that same location, so it just picks up where you left off. No export/import step, and it works across OSes because each attempt's video path is stored relative to that folder, not as an absolute path tied to one machine.
- **Speech pace (WPM)** transcribes on your machine, on every platform. It's **off by default**. Turning it on downloads a Whisper model once (~60MB, behind a confirmation dialog) to your OS app-data directory - deliberately *not* the portable `Videos/flight-recorder` folder, since it's app infrastructure rather than your data. After that, transcription runs locally after each recording stops. Earlier versions used the browser's speech recognition API on Windows, which streamed audio to Google; that's been removed. The app now touches the network in exactly two places: that one-off model download, and update checks.
- Deleting an attempt removes both its metadata entry and its video file from disk.
- Deleting a question also deletes every attempt (and video file) recorded under it - the confirmation prompt tells you how many before you commit.

## Design language

Dark, sleek, flat editor-style chrome: panels are tightly packed with a small gap and each has its own complete hairline border (no shared dividers, no rounded corners, no drop shadows), with a permanent left activity rail selecting sidebar content. Blue/indigo as the primary accent, red for recording/destructive actions, gold for star ratings, segmented pill-style filter tabs as the one deliberately rounded control, monospace timers and numeric readouts, sentence-case labels, compact/efficient spacing.

## Acknowledgments

Built with [Claude Code](https://claude.com/claude-code)'s assistance.
