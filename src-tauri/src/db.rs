use rusqlite::Connection;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const SCHEMA_VERSION: i64 = 1;

#[derive(Serialize, Clone)]
pub struct Note {
    pub id: i64,
    pub content: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        fs::create_dir_all(&app_data_dir)?;

        let db_path = app_data_dir.join("notes.db");
        let conn = Connection::open(&db_path)?;

        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        migrate_schema(&conn)?;

        // Ensure at least one note exists
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap_or(0);

        if count == 0 {
            conn.execute("INSERT INTO notes (content, position) VALUES ('', 0)", [])?;
        }

        println!("Database initialized at: {:?}", db_path);

        Ok(Database {
            conn: Mutex::new(conn),
        })
    }

    pub fn get_note(&self, id: i64) -> Result<Note, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, content, position, created_at, updated_at FROM notes WHERE id = ?1",
            [id],
            |row| {
                Ok(Note {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    position: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())
    }

    pub fn list_notes(&self) -> Result<Vec<Note>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, content, position, created_at, updated_at FROM notes ORDER BY position ASC")
            .map_err(|e| e.to_string())?;

        let notes = stmt
            .query_map([], |row| {
                Ok(Note {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    position: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok(notes)
    }

    pub fn create_note(&self) -> Result<Note, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // Get max position
        let max_pos: i64 = conn
            .query_row("SELECT COALESCE(MAX(position), -1) FROM notes", [], |row| {
                row.get(0)
            })
            .unwrap_or(-1);

        let new_pos = max_pos + 1;

        conn.execute(
            "INSERT INTO notes (content, position) VALUES ('', ?1)",
            rusqlite::params![new_pos],
        )
        .map_err(|e| e.to_string())?;

        let id = conn.last_insert_rowid();

        drop(conn); // release lock before calling get_note
        self.get_note(id)
    }

    pub fn save_note(&self, id: i64, content: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let updated = conn
            .execute(
                "UPDATE notes SET content = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                rusqlite::params![content, id],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err(format!("Note {id} does not exist."));
        }
        Ok(())
    }

    pub fn delete_note(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // Get the position of the note being deleted
        let deleted_pos: i64 = conn
            .query_row("SELECT position FROM notes WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?;

        conn.execute("DELETE FROM notes WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;

        // Shift positions down for notes after the deleted one
        conn.execute(
            "UPDATE notes SET position = position - 1 WHERE position > ?1",
            [deleted_pos],
        )
        .map_err(|e| e.to_string())?;

        // Ensure at least one note always exists
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap_or(0);

        if count == 0 {
            conn.execute("INSERT INTO notes (content, position) VALUES ('', 0)", [])
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }
}

fn migrate_schema(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if !notes_table_exists(conn)? {
        conn.execute_batch(
            "CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL DEFAULT '',
                position INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );",
        )?;
    }

    if user_version < 1 {
        if !notes_has_position(conn) {
            conn.execute_batch(
                "ALTER TABLE notes ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
                 UPDATE notes SET position = id - 1;",
            )?;
        }
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }

    Ok(())
}

fn notes_table_exists(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notes'",
        [],
        |row| Ok(row.get::<_, i64>(0)? > 0),
    )
}

fn notes_has_position(conn: &Connection) -> bool {
    conn.prepare("SELECT position FROM notes LIMIT 0").is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_app_data_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("noted-{name}-{unique}"))
    }

    #[test]
    fn fresh_database_starts_with_one_empty_note() {
        let dir = temp_app_data_dir("fresh");
        let db = Database::new(dir.clone()).expect("database should initialize");

        let notes = db.list_notes().expect("notes should list");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].content, "");
        assert_eq!(notes[0].position, 0);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn create_and_delete_notes_preserves_contiguous_positions() {
        let dir = temp_app_data_dir("positions");
        let db = Database::new(dir.clone()).expect("database should initialize");

        let first_id = db.list_notes().expect("notes should list")[0].id;
        let second = db.create_note().expect("second note should create");
        let third = db.create_note().expect("third note should create");

        db.save_note(second.id, "middle").expect("note should save");
        db.delete_note(first_id).expect("first note should delete");

        let notes = db.list_notes().expect("notes should list");
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].id, second.id);
        assert_eq!(notes[0].position, 0);
        assert_eq!(notes[0].content, "middle");
        assert_eq!(notes[1].id, third.id);
        assert_eq!(notes[1].position, 1);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_missing_note_returns_error() {
        let dir = temp_app_data_dir("missing-save");
        let db = Database::new(dir.clone()).expect("database should initialize");

        let error = db
            .save_note(999_999, "missing")
            .expect_err("saving a missing note should fail");
        assert!(error.contains("does not exist"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn old_schema_without_position_is_migrated() {
        let dir = temp_app_data_dir("migration");
        fs::create_dir_all(&dir).expect("temp dir should create");
        let old_db_path = dir.join("notes.db");
        {
            let conn = Connection::open(&old_db_path).expect("old db should open");
            conn.execute_batch(
                "CREATE TABLE notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL DEFAULT '',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO notes (content) VALUES ('first'), ('second');",
            )
            .expect("old schema should seed");
        }

        let db = Database::new(dir.clone()).expect("database should migrate");
        let notes = db.list_notes().expect("notes should list");
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].content, "first");
        assert_eq!(notes[0].position, 0);
        assert_eq!(notes[1].content, "second");
        assert_eq!(notes[1].position, 1);

        let conn = db.conn.lock().expect("database lock should be available");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should read");
        assert_eq!(version, SCHEMA_VERSION);
        drop(conn);

        let _ = fs::remove_dir_all(dir);
    }
}
