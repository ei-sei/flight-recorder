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
