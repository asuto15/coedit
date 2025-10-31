use uuid::Uuid;

use crate::{
    state::{AppState, DocPresence},
    types::{CursorState, ImeEvent, ImeSnapshot, PresenceState},
};

pub fn with_doc_presence<R, F>(state: &AppState, slug: &str, f: F) -> R
where
    F: FnOnce(&mut DocPresence) -> R,
{
    let mut map = state.presence.write();
    let entry = map.entry(slug.to_string()).or_default();
    f(entry)
}

pub fn register_presence(
    state: &AppState,
    slug: &str,
    client_id: Uuid,
    label: Option<String>,
    color: Option<String>,
    now: u64,
) -> (Vec<PresenceState>, PresenceState) {
    with_doc_presence(state, slug, |doc| {
        let presence = PresenceState {
            client_id,
            label: sanitize_label(label),
            color: sanitize_color(color),
            cursor: None,
            ime: None,
            last_seen: now,
        };
        doc.clients.insert(client_id, presence.clone());
        let snapshot = doc.clients.values().cloned().collect();
        (snapshot, presence)
    })
}

pub fn touch_presence(state: &AppState, slug: &str, client_id: &Uuid, now: u64) {
    with_doc_presence(state, slug, |doc| {
        if let Some(p) = doc.clients.get_mut(client_id) {
            p.last_seen = now;
        }
    });
}

pub fn update_presence_cursor(
    state: &AppState,
    slug: &str,
    client_id: Uuid,
    cursor: CursorState,
    now: u64,
) -> Option<PresenceState> {
    with_doc_presence(state, slug, |doc| {
        if let Some(p) = doc.clients.get_mut(&client_id) {
            p.cursor = Some(cursor);
            p.last_seen = now;
            Some(p.clone())
        } else {
            None
        }
    })
}

fn ime_event_snapshot(event: &ImeEvent) -> Option<ImeSnapshot> {
    match event {
        ImeEvent::Start { range } => Some(ImeSnapshot {
            phase: "start".to_string(),
            range: Some(range.clone()),
            text: None,
        }),
        ImeEvent::Update { range, text } => Some(ImeSnapshot {
            phase: "update".to_string(),
            range: Some(range.clone()),
            text: Some(text.clone()),
        }),
        ImeEvent::Commit {
            replace_range,
            text,
        } => Some(ImeSnapshot {
            phase: "commit".to_string(),
            range: Some(replace_range.clone()),
            text: Some(text.clone()),
        }),
        ImeEvent::Cancel { range } => Some(ImeSnapshot {
            phase: "cancel".to_string(),
            range: Some(range.clone()),
            text: None,
        }),
    }
}

pub fn update_presence_ime(
    state: &AppState,
    slug: &str,
    client_id: Uuid,
    ime: &ImeEvent,
    now: u64,
) -> Option<PresenceState> {
    let snapshot = ime_event_snapshot(ime);
    with_doc_presence(state, slug, |doc| {
        if let Some(p) = doc.clients.get_mut(&client_id) {
            p.last_seen = now;
            p.ime = snapshot.clone();
            Some(p.clone())
        } else {
            None
        }
    })
}

pub fn remove_presence(state: &AppState, slug: &str, client_id: &Uuid) -> Option<PresenceState> {
    let mut map = state.presence.write();
    if let std::collections::hash_map::Entry::Occupied(mut entry) = map.entry(slug.to_string()) {
        let doc = entry.get_mut();
        let removed = doc.clients.remove(client_id);
        if doc.clients.is_empty() {
            entry.remove();
        }
        removed
    } else {
        None
    }
}

pub fn update_presence_profile(
    state: &AppState,
    slug: &str,
    client_id: Uuid,
    label: Option<String>,
    color: Option<String>,
    now: u64,
) -> Option<PresenceState> {
    with_doc_presence(state, slug, |doc| {
        if let Some(p) = doc.clients.get_mut(&client_id) {
            if let Some(label_norm) = sanitize_label(label.clone()) {
                p.label = Some(label_norm);
            } else if label.is_some() {
                p.label = None;
            }
            if let Some(color_norm) = sanitize_color(color.clone()) {
                p.color = Some(color_norm);
            } else if color.is_some() {
                p.color = None;
            }
            p.last_seen = now;
            Some(p.clone())
        } else {
            None
        }
    })
}

fn sanitize_label(label: Option<String>) -> Option<String> {
    label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .map(|l| l.chars().take(64).collect())
}

fn sanitize_color(color: Option<String>) -> Option<String> {
    color
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .map(|c| c.chars().take(32).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::types::CursorState;
    use std::{fs, path::Path};

    fn mk_state(tmp: &Path) -> AppState {
        let wal_dir = tmp.join("wal");
        let snap_dir = tmp.join("snapshots");
        fs::create_dir_all(&wal_dir).unwrap();
        fs::create_dir_all(&snap_dir).unwrap();
        AppState::new(wal_dir, snap_dir, 1_000, 128, true, Vec::new())
    }

    #[test]
    fn register_presence_sanitizes_profile_fields() {
        let base = std::env::temp_dir().join(format!("presence-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "doc";
        let long_label = "   ".to_string() + &"a".repeat(80);
        let long_color = " #123456 ".repeat(5);
        let client = uuid::Uuid::new_v4();

        let (_snapshot, presence) =
            register_presence(&state, slug, client, Some(long_label), Some(long_color), 10);

        assert_eq!(presence.client_id, client);
        assert_eq!(presence.label.as_ref().unwrap().len(), 64);
        assert!(presence.label.as_ref().unwrap().starts_with('a'));
        assert_eq!(presence.color.as_ref().unwrap().len(), 32);
        assert_eq!(presence.last_seen, 10);
    }

    #[test]
    fn update_presence_cursor_returns_updated_state() {
        let base = std::env::temp_dir().join(format!("presence-cursor-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "cursor";
        let client = uuid::Uuid::new_v4();
        register_presence(&state, slug, client, None, None, 5);

        let cursor = CursorState {
            position: 3,
            anchor: Some(1),
            selection_direction: None,
        };
        let updated = update_presence_cursor(&state, slug, client, cursor.clone(), 20)
            .expect("presence updated");

        assert_eq!(updated.cursor.as_ref(), Some(&cursor));
        assert_eq!(updated.last_seen, 20);
    }

    #[test]
    fn remove_presence_drops_empty_document_entry() {
        let base = std::env::temp_dir().join(format!("presence-remove-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "remove";
        let client = uuid::Uuid::new_v4();
        register_presence(&state, slug, client, None, None, 1);

        let removed = remove_presence(&state, slug, &client).expect("presence removed");
        assert_eq!(removed.client_id, client);
        let map = state.presence.read();
        assert!(
            !map.contains_key(slug),
            "doc entry should be dropped when empty"
        );
    }

    #[test]
    fn update_presence_profile_handles_invalid_inputs() {
        let base = std::env::temp_dir().join(format!("presence-profile-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "profile";
        let client = uuid::Uuid::new_v4();
        register_presence(
            &state,
            slug,
            client,
            Some("label".into()),
            Some("#abc".into()),
            0,
        );

        let updated = update_presence_profile(
            &state,
            slug,
            client,
            Some("   ".into()),
            Some("".into()),
            30,
        )
        .expect("presence updated");

        assert_eq!(updated.label, None);
        assert_eq!(updated.color, None);
        assert_eq!(updated.last_seen, 30);
    }
}
