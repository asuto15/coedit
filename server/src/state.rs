use parking_lot::RwLock;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::mpsc;
use tracing::warn;
use uuid::Uuid;

use crate::{
    document::{Doc, apply_ops, transform_ops},
    presence::update_presence_cursor,
    storage::{
        flush_snapshot_if_needed, password_path, slug_to_rel_path, snapshot_path, wal_append_event,
        wal_path,
    },
    types::{DocEvent, Edit, ServerMsg, WalLine},
};

#[derive(Debug, Default)]
pub struct DocPresence {
    pub clients: HashMap<Uuid, crate::types::PresenceState>,
}

#[derive(Clone)]
pub struct AppState {
    pub docs: Arc<RwLock<HashMap<String, Arc<RwLock<Doc>>>>>,
    pub subs: Arc<RwLock<HashMap<String, Vec<mpsc::UnboundedSender<ServerMsg>>>>>,
    pub presence: Arc<RwLock<HashMap<String, DocPresence>>>,
    pub wal_dir: PathBuf,
    pub snap_dir: PathBuf,
    pub flush_idle_ms: u64,
    pub flush_max_ops: usize,
    pub app_env_dev: bool,
    pub recent_ops: Arc<RwLock<HashMap<String, RecentOps>>>,
    pub allowed_origins: Vec<String>,
}

impl AppState {
    pub fn new(
        wal_dir: PathBuf,
        snap_dir: PathBuf,
        flush_idle_ms: u64,
        flush_max_ops: usize,
        app_env_dev: bool,
        allowed_origins: Vec<String>,
    ) -> Self {
        Self {
            docs: Arc::new(RwLock::new(HashMap::new())),
            subs: Arc::new(RwLock::new(HashMap::new())),
            presence: Arc::new(RwLock::new(HashMap::new())),
            wal_dir,
            snap_dir,
            flush_idle_ms,
            flush_max_ops,
            app_env_dev,
            recent_ops: Arc::new(RwLock::new(HashMap::new())),
            allowed_origins,
        }
    }
}

#[derive(Default)]
pub struct RecentOps {
    set: HashSet<Uuid>,
    order: VecDeque<Uuid>,
    cap: usize,
}

pub const RECENT_OPS_CAP: usize = 4096;

impl RecentOps {
    pub fn new(cap: usize) -> Self {
        Self {
            set: HashSet::new(),
            order: VecDeque::new(),
            cap,
        }
    }

    pub fn contains(&self, id: &Uuid) -> bool {
        self.set.contains(id)
    }

    pub fn insert(&mut self, id: Uuid) -> bool {
        if self.set.insert(id) {
            self.order.push_back(id);
            while self.order.len() > self.cap {
                match self.order.pop_front() {
                    Some(old) => {
                        self.set.remove(&old);
                    }
                    None => break,
                }
            }
            true
        } else {
            false
        }
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}

pub fn broadcast(state: &AppState, slug: &str, msg: ServerMsg) {
    let mut subs = state.subs.write();
    if let Some(list) = subs.get_mut(slug) {
        let mut i = 0;
        while i < list.len() {
            let ok = list[i].send(msg.clone()).is_ok();
            if ok {
                i += 1;
            } else {
                list.remove(i);
            }
        }
    }
}

pub fn op_id_seen(state: &AppState, slug: &str, op_id: &Uuid) -> bool {
    let map = state.recent_ops.read();
    if let Some(ro) = map.get(slug) {
        ro.contains(op_id)
    } else {
        false
    }
}

pub fn remember_op_id(state: &AppState, slug: &str, op_id: Uuid) -> bool {
    let mut map = state.recent_ops.write();
    let ro = map
        .entry(slug.to_string())
        .or_insert_with(|| RecentOps::new(RECENT_OPS_CAP));
    ro.insert(op_id)
}

pub async fn get_or_load_doc(state: &AppState, slug: &str) -> anyhow::Result<Arc<RwLock<Doc>>> {
    slug_to_rel_path(slug)?;
    if let Some(d) = state.docs.read().get(slug).cloned() {
        return Ok(d);
    }
    let mut docs = state.docs.write();
    if let Some(d) = docs.get(slug).cloned() {
        return Ok(d);
    }

    let mut doc = Doc::default();
    let mut wal_edit_count = 0usize;
    let mut wal_last_ts = 0u64;
    let snap_path = snapshot_path(state, slug)?;
    if let Ok(content) = fs::read_to_string(&snap_path) {
        doc.content = content;
    }
    let wal_path = wal_path(state, slug)?;
    if let Ok(data) = fs::read_to_string(&wal_path) {
        let mut seen: HashSet<Uuid> = HashSet::new();
        for line in data.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<WalLine>(trimmed) {
                Ok(WalLine::V2(entry)) => match entry.event {
                    DocEvent::Edit { mut edit } => {
                        if edit.ts.is_none() {
                            edit.ts = Some(entry.ts);
                        }
                        if let Some(id) = edit.op_id {
                            if seen.contains(&id) {
                                continue;
                            } else {
                                seen.insert(id);
                            }
                        }
                        let ops2 = transform_ops(&doc, &edit);
                        apply_ops(&mut doc, &ops2);
                        doc.rev += 1;
                        doc.log.push(ops2);
                        wal_edit_count += 1;
                        wal_last_ts = wal_last_ts.max(entry.ts);
                    }
                    DocEvent::Cursor { op_id, .. } | DocEvent::Ime { op_id, .. } => {
                        if let Some(id) = op_id {
                            seen.insert(id);
                        }
                    }
                },
                Ok(WalLine::V1(edit)) => {
                    let legacy = edit;
                    if let Some(id) = legacy.op_id {
                        if seen.contains(&id) {
                            continue;
                        } else {
                            seen.insert(id);
                        }
                    }
                    let ops2 = transform_ops(&doc, &legacy);
                    apply_ops(&mut doc, &ops2);
                    doc.rev += 1;
                    doc.log.push(ops2);
                    wal_edit_count += 1;
                    if let Some(ts) = legacy.ts {
                        wal_last_ts = wal_last_ts.max(ts);
                    }
                }
                Err(err) => {
                    warn!("failed to parse wal entry for slug '{}': {:#}", slug, err);
                }
            }
        }
        if wal_edit_count > 0 && wal_last_ts == 0 {
            wal_last_ts = now_millis();
        }
        if !seen.is_empty() {
            let mut map = state.recent_ops.write();
            let ro = map
                .entry(slug.to_string())
                .or_insert_with(|| RecentOps::new(RECENT_OPS_CAP));
            for id in seen {
                ro.insert(id);
            }
        }
    }
    if wal_edit_count > 0 {
        doc.since_flush = wal_edit_count;
        doc.last_edit_ts = wal_last_ts;
    }
    let pwd_path = password_path(state, slug)?;
    if let Ok(hash) = fs::read_to_string(&pwd_path) {
        doc.password_hash = Some(hash.trim().to_string());
    }
    let d = Arc::new(RwLock::new(doc));
    docs.insert(slug.to_string(), d.clone());
    Ok(d)
}

pub async fn apply_edit(state: &AppState, slug: &str, mut edit: Edit) -> anyhow::Result<()> {
    let ts = edit.ts.unwrap_or_else(now_millis);
    edit.ts = Some(ts);
    let doc_arc = get_or_load_doc(state, slug).await?;
    if let Some(op_id) = edit.op_id
        && op_id_seen(state, slug, &op_id)
    {
        let d = doc_arc.read();
        broadcast(
            state,
            slug,
            ServerMsg::Applied {
                slug: slug.to_string(),
                rev: d.rev,
                ops: vec![],
                client_id: edit.client_id,
                op_id: Some(op_id),
                ts,
            },
        );
        return Ok(());
    }

    let to_broadcast = {
        let mut d = doc_arc.write();
        let ops2 = transform_ops(&d, &edit);
        if !ops2.is_empty() {
            apply_ops(&mut d, &ops2);
            d.rev += 1;
            d.log.push(ops2.clone());
            d.since_flush += 1;
            d.last_edit_ts = ts;
            (d.rev, ops2, edit.client_id)
        } else {
            (d.rev, vec![], edit.client_id)
        }
    };

    wal_append_event(state, slug, &DocEvent::Edit { edit: edit.clone() }, ts)?;
    let _ = flush_snapshot_if_needed(state, slug).await?;

    if let Some(op_id) = edit.op_id {
        remember_op_id(state, slug, op_id);
    }

    let (rev, ops, cid) = to_broadcast;
    broadcast(
        state,
        slug,
        ServerMsg::Applied {
            slug: slug.to_string(),
            rev,
            ops,
            client_id: cid,
            op_id: edit.op_id,
            ts,
        },
    );

    propagate_presence_after_edit(state, slug, &edit, ts);
    Ok(())
}

fn propagate_presence_after_edit(state: &AppState, slug: &str, edit: &Edit, ts: u64) {
    if let (Some(cid), Some(cursor_after)) = (edit.client_id, edit.cursor_after.clone()) {
        let server_now = now_millis();
        if let Some(updated) =
            update_presence_cursor(state, slug, cid, cursor_after.clone(), server_now)
        {
            broadcast(
                state,
                slug,
                ServerMsg::Cursor {
                    slug: slug.to_string(),
                    client_id: cid,
                    cursor: cursor_after,
                    op_id: edit.op_id,
                    ts,
                },
            );
            broadcast(
                state,
                slug,
                ServerMsg::PresenceDiff {
                    slug: slug.to_string(),
                    added: vec![],
                    updated: vec![updated],
                    removed: vec![],
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CursorState, DocEvent, Edit, ImeEvent, OpKind, TextRange};
    use std::{io::Write, path::Path};

    fn mk_state(tmp: &Path) -> AppState {
        let wal_dir = tmp.join("wal");
        let snap_dir = tmp.join("snapshots");
        fs::create_dir_all(&wal_dir).unwrap();
        fs::create_dir_all(&snap_dir).unwrap();
        AppState::new(wal_dir, snap_dir, 10_000, 1_000_000, true, Vec::new())
    }

    #[tokio::test]
    async fn dedup_same_op_id_applies_once() {
        let base = std::env::temp_dir().join(format!("srvtest-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "t1";

        let op_id = Uuid::new_v4();
        let e = Edit {
            base_rev: 0,
            ops: vec![OpKind::Insert {
                pos: 0,
                text: "a".into(),
            }],
            client_id: None,
            op_id: Some(op_id),
            cursor_before: None,
            cursor_after: None,
            ts: None,
        };
        apply_edit(&state, slug, e.clone()).await.unwrap();
        let d = get_or_load_doc(&state, slug).await.unwrap();
        assert_eq!(d.read().rev, 1);
        assert_eq!(d.read().content, "a");

        apply_edit(&state, slug, e.clone()).await.unwrap();
        let d = get_or_load_doc(&state, slug).await.unwrap();
        assert_eq!(d.read().rev, 1);
        assert_eq!(d.read().content, "a");

        let e2 = Edit {
            base_rev: 1,
            ops: vec![OpKind::Insert {
                pos: 1,
                text: "b".into(),
            }],
            client_id: None,
            op_id: Some(Uuid::new_v4()),
            cursor_before: None,
            cursor_after: None,
            ts: None,
        };
        apply_edit(&state, slug, e2).await.unwrap();
        let d = get_or_load_doc(&state, slug).await.unwrap();
        assert_eq!(d.read().rev, 2);
        assert_eq!(d.read().content, "ab");
    }

    #[tokio::test]
    async fn load_wal_skips_duplicate_op_ids() {
        let base = std::env::temp_dir().join(format!("srvtest-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "t2";
        let wal = crate::storage::wal_path(&state, slug).unwrap();
        let id = Uuid::new_v4();
        let e1 = Edit {
            base_rev: 0,
            ops: vec![OpKind::Insert {
                pos: 0,
                text: "x".into(),
            }],
            client_id: None,
            op_id: Some(id),
            cursor_before: None,
            cursor_after: None,
            ts: None,
        };
        let e2 = Edit {
            base_rev: 1,
            ops: vec![OpKind::Insert {
                pos: 1,
                text: "y".into(),
            }],
            client_id: None,
            op_id: Some(Uuid::new_v4()),
            cursor_before: None,
            cursor_after: None,
            ts: None,
        };
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&wal)
            .unwrap();
        serde_json::to_writer(&mut f, &e1).unwrap();
        f.write_all(b"\n").unwrap();
        serde_json::to_writer(&mut f, &e1).unwrap();
        f.write_all(b"\n").unwrap();
        serde_json::to_writer(&mut f, &e2).unwrap();
        f.write_all(b"\n").unwrap();

        let d = get_or_load_doc(&state, slug).await.unwrap();
        let dr = d.read();
        assert_eq!(dr.rev, 2);
        assert_eq!(dr.content, "xy");
    }

    #[tokio::test]
    async fn wal_load_marks_pending_flush_and_last_edit_ts() {
        let base = std::env::temp_dir().join(format!("srvtest-pending-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "pending";

        let mk_edit = |text: &str| Edit {
            base_rev: 0,
            ops: vec![OpKind::Insert {
                pos: 0,
                text: text.into(),
            }],
            client_id: None,
            op_id: Some(Uuid::new_v4()),
            cursor_before: None,
            cursor_after: None,
            ts: None,
        };

        crate::storage::wal_append_event(&state, slug, &DocEvent::Edit { edit: mk_edit("a") }, 111)
            .unwrap();
        crate::storage::wal_append_event(&state, slug, &DocEvent::Edit { edit: mk_edit("b") }, 222)
            .unwrap();

        let doc = get_or_load_doc(&state, slug).await.unwrap();
        let d = doc.read();
        assert_eq!(d.since_flush, 2);
        assert!(d.last_edit_ts >= 222);
    }

    #[tokio::test]
    async fn nested_slug_creates_nested_files() {
        let base = std::env::temp_dir().join(format!("srvtest-nested-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let mut state = mk_state(&base);
        state.flush_max_ops = 1;
        let slug = "dir/sub/doc";

        let edit = Edit {
            base_rev: 0,
            ops: vec![OpKind::Insert {
                pos: 0,
                text: "nested".into(),
            }],
            client_id: None,
            op_id: Some(Uuid::new_v4()),
            cursor_before: None,
            cursor_after: None,
            ts: None,
        };
        apply_edit(&state, slug, edit).await.unwrap();

        let snap = crate::storage::snapshot_path(&state, slug).unwrap();
        assert!(snap.exists());
        assert!(snap.to_string_lossy().contains("dir/sub/doc.md"));

        let wal = crate::storage::wal_path(&state, slug).unwrap();
        assert!(wal.exists());

        crate::storage::persist_password_hash(&state, slug, Some("hash")).unwrap();
        let pwd = crate::storage::password_path(&state, slug).unwrap();
        assert!(pwd.exists());
    }

    #[tokio::test]
    async fn wal_v2_events_preserve_content_and_track_ids() {
        let base = std::env::temp_dir().join(format!("srvtest-wal-v2-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "timeline";

        let edit = Edit {
            base_rev: 0,
            ops: vec![OpKind::Insert {
                pos: 0,
                text: "log".into(),
            }],
            client_id: None,
            op_id: Some(Uuid::new_v4()),
            cursor_before: None,
            cursor_after: None,
            ts: None,
        };
        apply_edit(&state, slug, edit).await.unwrap();

        let cursor_id = Uuid::new_v4();
        let ime_id = Uuid::new_v4();
        crate::storage::wal_append_event(
            &state,
            slug,
            &DocEvent::Cursor {
                client_id: Uuid::new_v4(),
                op_id: Some(cursor_id),
                cursor: CursorState {
                    position: 1,
                    anchor: None,
                    selection_direction: None,
                },
            },
            1234,
        )
        .unwrap();
        crate::storage::wal_append_event(
            &state,
            slug,
            &DocEvent::Ime {
                client_id: Uuid::new_v4(),
                op_id: Some(ime_id),
                ime: ImeEvent::Start {
                    range: TextRange { start: 1, end: 1 },
                },
            },
            5678,
        )
        .unwrap();

        state.docs.write().remove(slug);
        state.recent_ops.write().remove(slug);

        let doc = get_or_load_doc(&state, slug).await.unwrap();
        let dr = doc.read();
        assert_eq!(dr.rev, 1);
        assert_eq!(dr.content, "log");
        drop(dr);

        let rec = state.recent_ops.read();
        let ro = rec.get(slug).expect("recent ops populated");
        assert!(ro.contains(&cursor_id));
        assert!(ro.contains(&ime_id));
    }

    #[tokio::test]
    async fn slug_with_parent_component_is_rejected() {
        let base = std::env::temp_dir().join(format!("srvtest-invalid-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        assert!(crate::storage::slug_to_rel_path("../secret").is_err());
        assert!(get_or_load_doc(&state, "../secret").await.is_err());
    }
}
