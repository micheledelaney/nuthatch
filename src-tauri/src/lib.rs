use std::fs;
use std::path::{Component, Path};

#[derive(serde::Deserialize)]
struct ExportFile {
  name: String,
  content: String,
}

/// Write the "Export for AI" files into `<dir>/<folder>/`, creating the folder
/// if needed and overwriting earlier exports. `dir` comes from the folder
/// picker; `folder` and file names must be plain names (no separators or `..`)
/// so nothing can be written outside the chosen folder. Returns the full path.
#[tauri::command]
fn write_ai_export(dir: String, folder: String, files: Vec<ExportFile>) -> Result<String, String> {
  if !is_plain_name(&folder) {
    return Err(format!("Invalid export folder name: {folder}"));
  }
  if let Some(bad) = files.iter().find(|f| !is_plain_name(&f.name)) {
    return Err(format!("Invalid export file name: {}", bad.name));
  }
  let target = Path::new(&dir).join(&folder);
  fs::create_dir_all(&target).map_err(|e| format!("Could not create {}: {e}", target.display()))?;
  for file in &files {
    let path = target.join(&file.name);
    fs::write(&path, &file.content).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
  }
  Ok(target.display().to_string())
}

fn is_plain_name(name: &str) -> bool {
  let mut components = Path::new(name).components();
  matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![write_ai_export])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
