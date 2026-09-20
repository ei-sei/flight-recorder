// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// GTK3 (which this app's Linux webview sits on top of) crashes outright on
// some native Wayland compositors with "Error 71 (Protocol error) dispatching
// to Wayland display" - see https://github.com/tauri-apps/tauri/issues/8541.
// XWayland doesn't hit it, so forcing GDK's X11 backend is the fix, and it
// has to happen before GTK/GDK initialise - by the time tauri::Builder::run()
// returns, it's too late.
//
// The AppImage build already worked around this in its own launch script
// (apprun-hooks/linuxdeploy-plugin-gtk.sh sets GDK_BACKEND=x11), but that
// script is AppImage-specific - the .deb and .rpm builds shipped without it
// and crash on launch under Wayland. Setting it here instead covers every
// packaging format the same way, and makes that AppImage-side workaround
// redundant (though harmless to leave in place).
//
// Guarded so an explicit GDK_BACKEND from the environment - a developer
// deliberately testing under Wayland, say - isn't clobbered.
#[cfg(target_os = "linux")]
fn force_x11_backend() {
    if std::env::var_os("GDK_BACKEND").is_none() {
        // SAFETY: called at the very top of main(), before any other thread
        // exists and before GTK reads the environment during initialisation.
        unsafe { std::env::set_var("GDK_BACKEND", "x11") };
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    force_x11_backend();

    flight_recorder_lib::run()
}
