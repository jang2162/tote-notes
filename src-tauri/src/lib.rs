pub mod app;
pub mod appdata;
pub mod cli;
pub mod persist;
pub mod session;
pub mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "ws-scaffold",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("tote")
            .inner_size(1100.0, 760.0)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tote");
}
