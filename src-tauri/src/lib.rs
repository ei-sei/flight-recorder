use tauri::Manager;

mod whisper;
use whisper::{download_whisper_model, transcribe_recording};

#[tauri::command]
fn get_commit_sha() -> &'static str {
    env!("GIT_COMMIT_SHA")
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

#[tauri::command]
fn get_library_size(app: tauri::AppHandle) -> Result<u64, String> {
    let video_dir = app
        .path()
        .video_dir()
        .map_err(|err| format!("Couldn't locate the Videos folder: {err}"))?;
    Ok(directory_size(&video_dir.join("flight-recorder")))
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
            open_devtools,
            get_library_size,
            download_whisper_model,
            transcribe_recording
        ])
        .setup(|app| {
            // GTK on Linux doesn't pick up the bundle icon at runtime (that's
            // packaging-only), so the taskbar/window icon needs setting explicitly.
            if let Some(window) = app.get_webview_window("main") {
                let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
                window.set_icon(icon)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
