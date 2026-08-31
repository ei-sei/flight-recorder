# Flight recorder

A local desktop app for practicing job interviews on webcam. Built with Tauri. Runs fully on your machine — no cloud storage of video or data, except for the optional, opt-in speech-pace (WPM) feature.

## Prerequisites

- **Rust** — install via [rustup](https://rustup.rs).
- **Node.js** (LTS) — for the Tauri CLI (`npm install`).
- **Platform system dependencies** (build-time on every OS; also a *runtime* dependency on Linux):
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `patchelf`, `build-essential`, `libssl-dev`, `libayatana-appindicator3-dev`, `libsoup-3.0-dev`. On Debian/Ubuntu:
    ```
    sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf build-essential curl wget file libssl-dev libayatana-appindicator3-dev libsoup-3.0-dev
    ```
    If you package as a `.deb`/`.rpm`, `libwebkit2gtk-4.1` is declared as a dependency so it installs automatically for end users. If you package as an AppImage, it does **not** bundle webkit2gtk — it must already be present on the target machine.
  - **Windows**: [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on virtually all Windows 10/11 machines; Tauri's installer fetches it if missing) and the MSVC C++ build tools.
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`). WKWebView is part of the OS.

## Develop

```
npm install
npm run tauri dev
```

## Build a release bundle

```
npm run tauri build
```

Produces a platform-native installer/bundle under `src-tauri/target/release/bundle/`.

## Data & privacy

- **Video recordings** are written straight to disk as `.webm` files under your OS "Videos" folder: `Videos/flight-recorder/{category}/{date}_{question-slug}.webm`. Nothing about video ever leaves the machine.
- **Metadata** — the question bank, and each attempt's question/category/date/duration/score/notes/response-delay — is persisted locally via `tauri-plugin-store`, a JSON file in the app's local data directory.
- **Speech pace (WPM)** is the one feature that isn't fully local. It's **off by default**. When you explicitly turn it on, live audio is sent to the webview's built-in speech recognition (Google's servers, on Chromium-based webviews) while recording, to estimate words-per-minute. It's only available on Chromium-based webviews (in practice: Windows/WebView2) — WebKitGTK (Linux) and WKWebView (macOS) don't implement the Web Speech API, so the toggle is disabled there.
- Deleting an attempt removes both its metadata entry and its video file from disk.

## Design language

Aviation instrumentation, not a generic SaaS dashboard: dark cockpit palette, amber for recording/active states, teal for positive/save actions, monospace timers and data readouts, sentence-case labels, hairline dividers instead of card shadows.
