use tauri::Manager;

#[tauri::command]
fn get_commit_sha() -> &'static str {
    env!("GIT_COMMIT_SHA")
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
        .invoke_handler(tauri::generate_handler![get_commit_sha])
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
