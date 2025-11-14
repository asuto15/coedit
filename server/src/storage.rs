use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Component, Path, PathBuf},
};

use crate::{
    state::{AppState, get_or_load_doc, now_millis},
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

enum FlushMode {
    Opportunistic,
    Forced,
}

pub async fn flush_snapshot_if_needed(state: &AppState, slug: &str) -> anyhow::Result<bool> {
    flush_snapshot(state, slug, FlushMode::Opportunistic).await
}

pub async fn flush_snapshot_force(state: &AppState, slug: &str) -> anyhow::Result<bool> {
    flush_snapshot(state, slug, FlushMode::Forced).await
}

pub async fn flush_all_wals_to_snapshots(state: &AppState) -> anyhow::Result<usize> {
    let slugs = collect_pending_wal_slugs(&state.wal_dir)?;
    let mut flushed = 0usize;
    for slug in slugs {
        if flush_snapshot_force(state, &slug).await? {
            flushed += 1;
        }
    }
    Ok(flushed)
}

async fn flush_snapshot(state: &AppState, slug: &str, mode: FlushMode) -> anyhow::Result<bool> {
    let doc_arc = get_or_load_doc(state, slug).await?;
    let now = now_millis();
    let should_flush = {
        let d = doc_arc.read();
        match mode {
            FlushMode::Opportunistic => {
                let due_to_ops = d.since_flush >= state.flush_max_ops;
                let due_to_idle = d.since_flush > 0
                    && d.last_edit_ts > 0
                    && now.saturating_sub(d.last_edit_ts) >= state.flush_idle_ms;
                due_to_ops || due_to_idle
            }
            FlushMode::Forced => d.since_flush > 0,
        }
    };
    if !should_flush {
        return Ok(false);
    }

    let content;
    {
        let mut d = doc_arc.write();
        if d.since_flush == 0 {
            return Ok(false);
        }
        content = d.content.clone();
        d.since_flush = 0;
    }
    let snap_path = snapshot_path(state, slug)?;
    if let Some(parent) = snap_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(snap_path, content)?;
    Ok(true)
}

fn collect_pending_wal_slugs(base: &Path) -> anyhow::Result<Vec<String>> {
    fn visit(base: &Path, dir: &Path, acc: &mut Vec<String>) -> anyhow::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                visit(base, &path, acc)?;
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if fs::metadata(&path)?.len() == 0 {
                    continue;
                }
                let rel = path.strip_prefix(base)?;
                let mut rel_slug = rel.to_path_buf();
                rel_slug.set_extension("");
                let slug = rel_slug.to_string_lossy().replace('\\', "/");
                acc.push(slug);
            }
        }
        Ok(())
    }

    let mut slugs = Vec::new();
    if base.exists() {
        visit(base, base, &mut slugs)?;
    }
    Ok(slugs)
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
    use crate::state::{AppState, now_millis};
    use crate::types::{DocEvent, Edit, OpKind};
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

        let flushed = flush_snapshot_if_needed(&state, slug).await.unwrap();
        assert!(flushed);

        let path = snapshot_path(&state, slug).unwrap();
        let stored = fs::read_to_string(path).unwrap();
        assert_eq!(stored, "hello");

        let doc_arc = state.docs.read().get(slug).unwrap().clone();
        assert_eq!(doc_arc.read().since_flush, 0);
    }

    #[tokio::test]
    async fn flush_snapshot_if_needed_respects_idle_time() {
        let base = std::env::temp_dir().join(format!("storage-idle-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "idle-doc";
        let mut doc = Doc::default();
        doc.content = "idle".into();
        doc.rev = 2;
        doc.since_flush = 1;
        doc.last_edit_ts = now_millis().saturating_sub(state.flush_idle_ms + 5);
        state
            .docs
            .write()
            .insert(slug.into(), Arc::new(RwLock::new(doc)));

        let flushed = flush_snapshot_if_needed(&state, slug).await.unwrap();
        assert!(flushed, "idle threshold should trigger flush");
    }

    #[tokio::test]
    async fn flush_snapshot_force_ignores_idle_threshold() {
        let base = std::env::temp_dir().join(format!("storage-force-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "force-doc";
        let mut doc = Doc::default();
        doc.content = "force".into();
        doc.rev = 3;
        doc.since_flush = 1;
        doc.last_edit_ts = now_millis();
        state
            .docs
            .write()
            .insert(slug.into(), Arc::new(RwLock::new(doc)));

        let flushed = flush_snapshot_force(&state, slug).await.unwrap();
        assert!(flushed, "force flush should ignore idle window");
    }

    #[tokio::test]
    async fn flush_all_wals_to_snapshots_processes_pending_files() {
        let base = std::env::temp_dir().join(format!("storage-bulk-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug_a = "bulk/a";
        let slug_b = "bulk/b";

        let mk_edit = |text: &str| Edit {
            base_rev: 0,
            ops: vec![OpKind::Insert {
                pos: 0,
                text: text.into(),
            }],
            client_id: None,
            op_id: None,
            cursor_before: None,
            cursor_after: None,
            ts: None,
        };

        wal_append_event(
            &state,
            slug_a,
            &DocEvent::Edit {
                edit: mk_edit("alpha"),
            },
            100,
        )
        .unwrap();
        wal_append_event(
            &state,
            slug_b,
            &DocEvent::Edit {
                edit: mk_edit("beta"),
            },
            200,
        )
        .unwrap();

        let flushed = flush_all_wals_to_snapshots(&state).await.unwrap();
        assert_eq!(flushed, 2);

        let snap_a = snapshot_path(&state, slug_a).unwrap();
        let snap_b = snapshot_path(&state, slug_b).unwrap();
        assert_eq!(fs::read_to_string(snap_a).unwrap().trim(), "alpha");
        assert_eq!(fs::read_to_string(snap_b).unwrap().trim(), "beta");
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
