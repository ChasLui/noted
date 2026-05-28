use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

mod db;

#[derive(Clone)]
struct AppPaths {
    themes_dir: PathBuf,
}

#[derive(Serialize)]
struct ThemeFile {
    name: String,
    json: String,
}

fn safe_theme_filename(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    let safe = if safe.is_empty() {
        "theme".to_string()
    } else {
        safe
    };
    let hash = stable_name_hash(name);
    format!("{safe}-{hash:016x}.json")
}

fn stable_name_hash(name: &str) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    name.as_bytes().iter().fold(FNV_OFFSET, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME)
    })
}

fn validate_theme_payload(expected_name: &str, json: &str) -> Result<(), String> {
    let value = serde_json::from_str::<Value>(json).map_err(|e| e.to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "Theme must be a JSON object.".to_string())?;

    let theme_name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "Theme is missing a string \"name\" field.".to_string())?;

    if theme_name != expected_name {
        return Err("Theme name does not match save request.".to_string());
    }

    if !object.get("isDarkTheme").and_then(Value::as_bool).is_some() {
        return Err("Theme field \"isDarkTheme\" must be a boolean.".to_string());
    }

    for &key in THEME_COLOR_KEYS {
        let color = object
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Theme field \"{key}\" must be a hex color."))?;
        if !is_hex_color(color) {
            return Err(format!("Theme field \"{key}\" must be a hex color."));
        }
    }

    for key in ["gridEnabled", "isTranslucent"] {
        if object.get(key).is_some() && object.get(key).and_then(Value::as_bool).is_none() {
            return Err(format!("Theme field \"{key}\" must be a boolean."));
        }
    }

    Ok(())
}

const THEME_COLOR_KEYS: &[&str] = &[
    "background",
    "backgroundFade",
    "typeMain",
    "typeSubtle",
    "typeSubtlePlus",
    "typeHighlight",
    "typeLight",
    "typeSuperlight",
    "typeHyperLight",
    "typeReverse",
    "accent1Main",
    "accent1Secondary",
    "accent1Tertiary",
    "accent2Main",
    "accent2Secondary",
    "accent3Main",
    "accent3Secondary",
    "accent4Main",
    "accent4Secondary",
    "accent5Main",
    "accent5Secondary",
    "gridSuperlight",
    "gridClear",
    "gridBold",
];

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.first() != Some(&b'#') || !(bytes.len() == 7 || bytes.len() == 9) {
        return false;
    }
    bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

#[tauri::command]
fn list_notes(state: tauri::State<'_, db::Database>) -> Result<Vec<db::Note>, String> {
    state.list_notes()
}

#[tauri::command]
fn create_note(state: tauri::State<'_, db::Database>) -> Result<db::Note, String> {
    state.create_note()
}

#[tauri::command]
fn save_note(
    id: i64,
    content: String,
    state: tauri::State<'_, db::Database>,
) -> Result<(), String> {
    state.save_note(id, &content)
}

#[tauri::command]
fn delete_note(id: i64, state: tauri::State<'_, db::Database>) -> Result<(), String> {
    state.delete_note(id)
}

#[tauri::command]
fn list_theme_files(paths: tauri::State<'_, AppPaths>) -> Result<Vec<ThemeFile>, String> {
    fs::create_dir_all(&paths.themes_dir).map_err(|e| e.to_string())?;

    let mut themes = Vec::new();
    for entry in fs::read_dir(&paths.themes_dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!("Could not read theme directory entry: {error}");
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let json = match fs::read_to_string(&path) {
            Ok(json) => json,
            Err(error) => {
                eprintln!("Could not read theme file {:?}: {error}", path);
                continue;
            }
        };
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("theme")
            .to_string();
        themes.push(ThemeFile { name, json });
    }

    Ok(themes)
}

#[tauri::command]
fn save_theme_file(
    name: String,
    json: String,
    paths: tauri::State<'_, AppPaths>,
) -> Result<(), String> {
    save_theme_json(&paths.themes_dir, &name, &json)
}

fn save_theme_json(themes_dir: &PathBuf, name: &str, json: &str) -> Result<(), String> {
    validate_theme_payload(&name, &json)?;
    fs::create_dir_all(themes_dir).map_err(|e| e.to_string())?;

    let path = themes_dir.join(safe_theme_filename(name));
    let tmp_path = path.with_extension(format!("json.tmp.{}", std::process::id()));
    fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        e.to_string()
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(
            tauri_plugin_single_instance::Builder::new()
                .dbus_id("com.khurram.noted")
                .callback(|app, args, _cwd| {
                    if let Some(window) = app.get_webview_window("main") {
                        if args.iter().any(|arg| arg == "--toggle") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(),
        );
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir");
            fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");

            let themes_dir = app_data_dir.join("themes");
            fs::create_dir_all(&themes_dir).expect("failed to create themes dir");

            let database = db::Database::new(app_data_dir).expect("failed to initialize database");
            app.manage(database);
            app.manage(AppPaths { themes_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_notes,
            create_note,
            save_note,
            delete_note,
            list_theme_files,
            save_theme_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("noted-theme-{name}-{unique}"))
    }

    fn valid_theme_json(name: &str) -> String {
        format!(
            r##"{{
                "name": "{name}",
                "isDarkTheme": false,
                "background": "#ffffff",
                "backgroundFade": "#f4f4f4",
                "typeMain": "#242424",
                "typeSubtle": "#6d6d6d",
                "typeSubtlePlus": "#4f7d9d",
                "typeHighlight": "#e9e9e9",
                "typeLight": "#a0a0a0",
                "typeSuperlight": "#dddddd",
                "typeHyperLight": "#f6f6f6",
                "typeReverse": "#ffffff",
                "accent1Main": "#7d7d7d",
                "accent1Secondary": "#666666",
                "accent1Tertiary": "#555555",
                "accent2Main": "#7b61a8",
                "accent2Secondary": "#684f93",
                "accent3Main": "#5c8a55",
                "accent3Secondary": "#477240",
                "accent4Main": "#b97835",
                "accent4Secondary": "#965d24",
                "accent5Main": "#c75d55",
                "accent5Secondary": "#9f443d",
                "gridSuperlight": "#00000000",
                "gridClear": "#00000000",
                "gridBold": "#00000000",
                "gridEnabled": false,
                "isTranslucent": false
            }}"##
        )
    }

    #[test]
    fn theme_filename_includes_stable_hash_to_avoid_collisions() {
        let slash = safe_theme_filename("A/B");
        let colon = safe_theme_filename("A:B");

        assert_ne!(slash, colon);
        assert!(slash.ends_with(".json"));
        assert!(colon.ends_with(".json"));
    }

    #[test]
    fn theme_payload_validation_rejects_invalid_schema() {
        let invalid = r##"{"name":"Broken","isDarkTheme":false,"background":"white"}"##;

        assert!(validate_theme_payload("Broken", invalid).is_err());
    }

    #[test]
    fn theme_payload_validation_rejects_name_mismatch() {
        let json = valid_theme_json("Saved Name");

        assert!(validate_theme_payload("Other Name", &json).is_err());
    }

    #[test]
    fn save_theme_json_writes_validated_payload_and_cleans_temp_file() {
        let dir = temp_dir("save");
        let json = valid_theme_json("My Theme");

        save_theme_json(&dir, "My Theme", &json).expect("theme should save");

        let path = dir.join(safe_theme_filename("My Theme"));
        assert_eq!(
            fs::read_to_string(path).expect("theme file should read"),
            json
        );
        let temp_files = fs::read_dir(&dir)
            .expect("theme dir should read")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) != Some("json"))
            .count();
        assert_eq!(temp_files, 0);

        let _ = fs::remove_dir_all(dir);
    }
}
