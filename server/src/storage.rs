use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Component, Path, PathBuf},
};

use crate::{
    state::AppState,
    state::get_or_load_doc,
    types::{CURRENT_WAL_VERSION, DocEvent, WalEntryV2},
};
use anyhow::bail;
use sha2::{Digest, Sha256};

pub fn slug_to_rel_path(slug: &str) -> anyhow::Result<PathBuf> {
    let trimmed = slug.trim_matches('/');
    if trimmed.is_empty() {
        bail!("slug must not be empty");
    }
    let mut rel = PathBuf::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(part) => rel.push(part),
            _ => bail!("slug contains invalid path segments"),
        }
    }
    Ok(rel)
}

fn slug_path_with_extension(base: &Path, slug: &str, ext: &str) -> anyhow::Result<PathBuf> {
    let mut rel = slug_to_rel_path(slug)?;
    rel.set_extension(ext);
    Ok(base.join(rel))
}

pub fn snapshot_path(state: &AppState, slug: &str) -> anyhow::Result<PathBuf> {
    slug_path_with_extension(&state.snap_dir, slug, "md")
}

pub fn password_path(state: &AppState, slug: &str) -> anyhow::Result<PathBuf> {
    slug_path_with_extension(&state.snap_dir, slug, "pwd")
}

pub fn wal_path(state: &AppState, slug: &str) -> anyhow::Result<PathBuf> {
    slug_path_with_extension(&state.wal_dir, slug, "jsonl")
}

pub fn wal_append_event(
    state: &AppState,
    slug: &str,
    event: &DocEvent,
    ts: u64,
) -> anyhow::Result<()> {
    let path = wal_path(state, slug)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    let entry = WalEntryV2 {
        version: CURRENT_WAL_VERSION,
        ts,
        event: event.clone(),
    };
    serde_json::to_writer(&mut f, &entry)?;
    f.write_all(b"\n")?;
    Ok(())
}

pub async fn flush_snapshot_if_needed(state: &AppState, slug: &str) -> anyhow::Result<()> {
    let doc_arc = get_or_load_doc(state, slug).await?;
    let should_flush;
    {
        let d = doc_arc.read();
        should_flush = d.since_flush >= state.flush_max_ops;
    }
    if !should_flush {
        return Ok(());
    }

    let (content, _rev);
    {
        let mut d = doc_arc.write();
        content = d.content.clone();
        _rev = d.rev;
        d.since_flush = 0;
    }
    let snap_path = snapshot_path(state, slug)?;
    if let Some(parent) = snap_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(snap_path, content)?;
    Ok(())
}

pub fn hash_password(password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn persist_password_hash(
    state: &AppState,
    slug: &str,
    hash: Option<&str>,
) -> anyhow::Result<()> {
    let path = password_path(state, slug)?;
    match hash {
        Some(h) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, h)?;
        }
        None => {
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::Doc;
    use crate::state::AppState;
    use crate::types::DocEvent;
    use parking_lot::RwLock;
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use uuid::Uuid;

    fn mk_state(tmp: &Path) -> AppState {
        let wal_dir = tmp.join("wal");
        let snap_dir = tmp.join("snapshots");
        fs::create_dir_all(&wal_dir).unwrap();
        fs::create_dir_all(&snap_dir).unwrap();
        AppState::new(wal_dir, snap_dir, 10, 1, true, Vec::new())
    }

    #[test]
    fn slug_to_rel_path_rejects_invalid_segments() {
        assert!(slug_to_rel_path("valid/path").is_ok());
        assert!(slug_to_rel_path("../secret").is_err());
        assert!(slug_to_rel_path("").is_err());
    }

    #[tokio::test]
    async fn flush_snapshot_if_needed_writes_snapshot() {
        let base = std::env::temp_dir().join(format!("storage-flush-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "doc";
        let mut doc = Doc::default();
        doc.content = "hello".into();
        doc.rev = 1;
        doc.since_flush = 1;
        state
            .docs
            .write()
            .insert(slug.into(), Arc::new(RwLock::new(doc)));

        flush_snapshot_if_needed(&state, slug).await.unwrap();

        let path = snapshot_path(&state, slug).unwrap();
        let stored = fs::read_to_string(path).unwrap();
        assert_eq!(stored, "hello");

        let doc_arc = state.docs.read().get(slug).unwrap().clone();
        assert_eq!(doc_arc.read().since_flush, 0);
    }

    #[tokio::test]
    async fn wal_append_event_appends_json_lines() {
        let base = std::env::temp_dir().join(format!("storage-wal-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "wal-doc";
        wal_append_event(
            &state,
            slug,
            &DocEvent::Cursor {
                client_id: Uuid::new_v4(),
                op_id: None,
                cursor: crate::types::CursorState {
                    position: 0,
                    anchor: None,
                    selection_direction: None,
                },
            },
            123,
        )
        .unwrap();
        wal_append_event(
            &state,
            slug,
            &DocEvent::Ime {
                client_id: Uuid::new_v4(),
                op_id: None,
                ime: crate::types::ImeEvent::Cancel {
                    range: crate::types::TextRange { start: 0, end: 0 },
                },
            },
            456,
        )
        .unwrap();

        let path = wal_path(&state, slug).unwrap();
        let contents = fs::read_to_string(path).unwrap();
        let lines: Vec<_> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        for line in lines {
            serde_json::from_str::<crate::types::WalEntryV2>(line).expect("valid json");
        }
    }

    #[test]
    fn persist_password_hash_writes_and_removes_file() {
        let base = std::env::temp_dir().join(format!("storage-pwd-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "pwd";
        persist_password_hash(&state, slug, Some("hash")).unwrap();
        let path = password_path(&state, slug).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hash");

        persist_password_hash(&state, slug, None).unwrap();
        assert!(!path.exists());
    }
}
