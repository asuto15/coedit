use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use tracing::error;

use crate::{
    auth::{extract_password_from_headers, is_authorized},
    state::{AppState, get_or_load_doc},
    storage::{hash_password, persist_password_hash},
    types::SnapshotResp,
};

#[derive(Deserialize)]
pub struct SnapshotQuery {
    pub slug: String,
    pub password: Option<String>,
}

#[derive(Deserialize)]
pub struct PasswordUpdateReq {
    pub slug: String,
    pub current_password: Option<String>,
    pub new_password: Option<String>,
}

pub async fn health() -> &'static str {
    "ok"
}

pub async fn update_password(
    State(state): State<AppState>,
    Json(req): Json<PasswordUpdateReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    let slug = req.slug;
    let current = req.current_password.unwrap_or_default();
    let new_password = req.new_password.unwrap_or_default();
    let doc = get_or_load_doc(&state, &slug).await.map_err(|err| {
        error!("invalid slug '{}': {:#}", slug, err);
        (StatusCode::BAD_REQUEST, "invalid slug".to_string())
    })?;
    let new_hash = {
        let mut d = doc.write();
        if let Some(expected) = d.password_hash.clone() {
            if hash_password(&current) != expected {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    "invalid current password".to_string(),
                ));
            }
        } else if !current.is_empty() {
            return Err((
                StatusCode::UNAUTHORIZED,
                "invalid current password".to_string(),
            ));
        }
        let new_hash_opt = if new_password.is_empty() {
            None
        } else {
            Some(hash_password(&new_password))
        };
        d.password_hash = new_hash_opt.clone();
        new_hash_opt
    };
    if let Err(err) = persist_password_hash(&state, &slug, new_hash.as_deref()) {
        error!("failed to persist password: {:#}", err);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to persist password".to_string(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_snapshot(
    State(state): State<AppState>,
    Query(q): Query<SnapshotQuery>,
    headers: HeaderMap,
) -> Result<Json<SnapshotResp>, (StatusCode, &'static str)> {
    let SnapshotQuery { slug, password } = q;
    let doc = get_or_load_doc(&state, &slug).await.map_err(|err| {
        error!("invalid slug '{}': {:#}", slug, err);
        (StatusCode::BAD_REQUEST, "invalid slug")
    })?;
    let provided = password.or_else(|| extract_password_from_headers(&headers, &slug));
    {
        let d = doc.read();
        if !is_authorized(&d, provided.as_deref()) {
            return Err((StatusCode::UNAUTHORIZED, "unauthorized"));
        }
        Ok(Json(SnapshotResp {
            slug,
            rev: d.rev,
            content: d.content.clone(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::Doc;
    use crate::state::AppState;
    use axum::extract::State as StateExtractor;
    use axum::http::HeaderValue;
    use base64::Engine;
    use parking_lot::RwLock;
    use std::fs;
    use std::sync::Arc;
    use uuid::Uuid;

    fn mk_state(tmp: &std::path::Path) -> AppState {
        let wal_dir = tmp.join("wal");
        let snap_dir = tmp.join("snapshots");
        fs::create_dir_all(&wal_dir).unwrap();
        fs::create_dir_all(&snap_dir).unwrap();
        AppState::new(wal_dir, snap_dir, 1_000, 128, true, Vec::new())
    }

    #[tokio::test]
    async fn health_endpoint_returns_ok() {
        assert_eq!(health().await, "ok");
    }

    #[tokio::test]
    async fn get_snapshot_enforces_password() {
        let base = std::env::temp_dir().join(format!("http-snapshot-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "secure";
        let mut doc = Doc::default();
        doc.content = "secret text".into();
        doc.password_hash = Some(hash_password("pw"));
        state
            .docs
            .write()
            .insert(slug.into(), Arc::new(RwLock::new(doc)));

        let headers = HeaderMap::new();
        let result = get_snapshot(
            StateExtractor(state.clone()),
            Query(SnapshotQuery {
                slug: slug.into(),
                password: None,
            }),
            headers,
        )
        .await;
        assert!(matches!(result, Err((StatusCode::UNAUTHORIZED, _))));

        let mut headers = HeaderMap::new();
        let token = base64::engine::general_purpose::STANDARD.encode("secure:pw");
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Basic {}", token)).unwrap(),
        );
        let ok = get_snapshot(
            StateExtractor(state.clone()),
            Query(SnapshotQuery {
                slug: slug.into(),
                password: None,
            }),
            headers,
        )
        .await
        .expect("authorized");

        assert_eq!(ok.0.slug, "secure");
        assert_eq!(ok.0.content, "secret text");
    }

    #[tokio::test]
    async fn update_password_validates_current_password() {
        let base = std::env::temp_dir().join(format!("http-update-password-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "pw-doc";
        let mut doc = Doc::default();
        doc.password_hash = Some(hash_password("old"));
        state
            .docs
            .write()
            .insert(slug.into(), Arc::new(RwLock::new(doc)));

        let resp = update_password(
            StateExtractor(state.clone()),
            Json(PasswordUpdateReq {
                slug: slug.into(),
                current_password: Some("wrong".into()),
                new_password: Some("new".into()),
            }),
        )
        .await;
        assert!(matches!(resp, Err((StatusCode::UNAUTHORIZED, _))));

        let resp = update_password(
            StateExtractor(state.clone()),
            Json(PasswordUpdateReq {
                slug: slug.into(),
                current_password: Some("old".into()),
                new_password: Some("new".into()),
            }),
        )
        .await
        .expect("password updated");
        assert_eq!(resp, StatusCode::NO_CONTENT);

        let doc_arc = state.docs.read().get(slug).unwrap().clone();
        let guard = doc_arc.read();
        let expected = hash_password("new");
        assert_eq!(guard.password_hash.as_deref(), Some(expected.as_str()));
        drop(guard);
        let path = crate::storage::password_path(&state, slug).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), expected);
    }

    #[tokio::test]
    async fn get_snapshot_accepts_query_password() {
        let base = std::env::temp_dir().join(format!("http-snapshot-q-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let state = mk_state(&base);
        let slug = "secure";
        let mut doc = Doc::default();
        doc.content = "secret text".into();
        doc.password_hash = Some(hash_password("pw"));
        state
            .docs
            .write()
            .insert(slug.into(), Arc::new(RwLock::new(doc)));

        let headers = HeaderMap::new();
        let ok = get_snapshot(
            StateExtractor(state.clone()),
            Query(SnapshotQuery {
                slug: slug.into(),
                password: Some("pw".into()),
            }),
            headers,
        )
        .await
        .expect("authorized");

        assert_eq!(ok.0.slug, "secure");
        assert_eq!(ok.0.content, "secret text");
    }
}
