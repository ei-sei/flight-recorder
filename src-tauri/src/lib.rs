use tauri::Manager;

mod whisper;
use whisper::{download_whisper_model, transcribe_recording, whisper_model_present};

#[tauri::command]
fn get_commit_sha() -> &'static str {
    env!("GIT_COMMIT_SHA")
}

#[tauri::command]
fn get_rust_version() -> &'static str {
    env!("RUSTC_VERSION")
}

// The webview's own "Inspect element" comes with a native menu full of
// browser entries that don't apply to a packaged app, so that menu is
// suppressed and this backs the app's own two-item replacement instead.
// Works in release builds too - tauri's "devtools" feature is enabled in
// Cargo.toml, not just inherited from debug_assertions.
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

// Recordings accumulate indefinitely - nothing prunes them - so the only
// honest thing to do is make the number visible rather than let it grow
// unnoticed. Walked in Rust because it's one IPC call instead of one per
// file, and the folder is a few hundred entries deep by year two.
fn directory_size(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => directory_size(&entry.path()),
            Ok(file_type) if file_type.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            // Symlinks are skipped rather than followed - a link pointing back
            // up the tree would recurse until the stack gave out.
            _ => 0,
        })
        .sum()
}

// Deliberately `command(async)`. Tauri runs a plain sync command on the main
// thread, so walking a library folder with a few hundred recordings in it
// there froze the window for as long as the walk took - which is exactly the
// case this command exists to measure.
#[tauri::command(async)]
fn get_library_size(app: tauri::AppHandle) -> Result<u64, String> {
    let video_dir = app
        .path()
        .video_dir()
        .map_err(|err| format!("Couldn't locate the Videos folder: {err}"))?;
    Ok(directory_size(&video_dir.join("flight-recorder")))
}

// WebKitGTK has no built-in camera/mic consent dialog the way WebView2
// (Windows) and WKWebView (macOS) do - those trigger their platform's own
// permission prompt automatically before getUserMedia() can succeed. On
// Linux, WebKitGTK instead asks the embedding app to answer this itself, via
// the "permission-request" signal on the raw webview widget - a signal
// Tauri's own cross-platform API has no way to reach. An app that never
// connects to it gets WebKit's own default, which is to deny outright: no
// dialog, no error dialog, just a bare NotAllowedError in the frontend. The
// "camera access denied" failure on Linux was never a device, driver or
// codec problem - nothing here had ever answered the question WebKit was
// asking.
//
// There's no better native UI to build in its place - GTK has no standard
// per-permission consent widget - and the app already only touches the
// camera/mic when the user presses the camera toggle or Record button
// themselves, which is the same trust boundary the other two platforms
// apply automatically via their own OS-level prompts. So UserMedia requests
// are allowed unconditionally here; anything else (e.g. notifications, which
// this app never asks for) falls through to WebKit's own default deny.
#[cfg(target_os = "linux")]
fn allow_camera_and_mic_permission(webview: &webkit2gtk::WebView) {
    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};

    // Both off by default in WebKitGTK. Media stream backs getUserMedia()
    // itself; WebAudio backs extractPcmForTranscription()'s
    // OfflineAudioContext, which decodes the recording for Whisper - without
    // this, Speech pace (WPM) would silently fail to transcribe on Linux
    // even once the camera/mic themselves worked.
    if let Some(settings) = WebViewExt::settings(webview) {
        settings.set_enable_media_stream(true);
        settings.set_enable_webaudio(true);
    }

    webview.connect_permission_request(|_webview, request| {
        use webkit2gtk::glib::Cast;
        if request
            .downcast_ref::<webkit2gtk::UserMediaPermissionRequest>()
            .is_some()
        {
            request.allow();
            true
        } else {
            // Not ours to decide - fall through to WebKit's own default for
            // anything else it might ask.
            false
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first - it needs to intercept the app launch
        // before anything else runs, to redirect a second launch into
        // focusing the already-running window instead of starting a
        // separate, independent instance (which could otherwise both write
        // to the same store file and camera at once).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_commit_sha,
            get_rust_version,
            open_devtools,
            get_library_size,
            download_whisper_model,
            whisper_model_present,
            transcribe_recording
        ])
        .setup(|app| {
            // GTK on Linux doesn't pick up the bundle icon at runtime (that's
            // packaging-only), so the taskbar/window icon needs setting explicitly.
            if let Some(window) = app.get_webview_window("main") {
                let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
                window.set_icon(icon)?;

                #[cfg(target_os = "linux")]
                window.with_webview(|webview| {
                    allow_camera_and_mic_permission(&webview.inner());
                })?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
