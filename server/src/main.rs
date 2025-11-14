mod auth;
mod document;
mod handlers;
mod presence;
mod state;
mod storage;
mod types;

use std::{fs, path::Path, time::Duration};

use axum::{
    Router,
    routing::{get, post},
};
#[cfg(unix)]
use tokio::signal::unix::{SignalKind, signal as unix_signal};
use tokio::{
    signal,
    sync::{oneshot, watch},
    time::sleep,
};
use tracing::{error, info};

use crate::{
    handlers::{http, ws},
    state::AppState,
    storage::{flush_all_wals_to_snapshots, flush_snapshot_force, flush_snapshot_if_needed},
};

fn build_router(state: &AppState) -> Router {
    Router::new()
        .route("/api/snapshot", get(http::get_snapshot))
        .route("/api/password", post(http::update_password))
        .route("/api/health", get(http::health))
        .route("/api/ws", get(ws::ws_handler))
        .with_state(state.clone())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let data_dir = std::env::var("DATA_DIR").unwrap_or_else(|_| "/vault".to_string());
    let wal_dir = Path::new(&data_dir).join("wal");
    let snap_dir = Path::new(&data_dir).join("snapshots");
    fs::create_dir_all(&wal_dir)?;
    fs::create_dir_all(&snap_dir)?;

    let flush_idle_ms = std::env::var("FLUSH_IDLE_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1500);
    let flush_max_ops = std::env::var("FLUSH_MAX_OPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);
    let app_env_dev = std::env::var("APP_ENV").unwrap_or_else(|_| "dev".into()) == "dev";
    let app_domain = std::env::var("APP_DOMAIN").ok();
    let allowed_origins = std::env::var("APP_ALLOWED_ORIGINS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        })
        .filter(|list| !list.is_empty())
        .or_else(|| {
            app_domain
                .as_ref()
                .map(|domain| vec![format!("https://{}", domain)])
        })
        .unwrap_or_default();

    let state = AppState::new(
        wal_dir,
        snap_dir,
        flush_idle_ms,
        flush_max_ops,
        app_env_dev,
        allowed_origins,
    );

    let hydrated = flush_all_wals_to_snapshots(&state).await?;
    info!(
        slugs = hydrated,
        "replayed pending WAL entries into snapshots"
    );

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let periodic_handle = tokio::spawn(run_periodic_snapshot_flush(state.clone(), shutdown_rx));

    let (signal_tx, signal_rx) = oneshot::channel();
    tokio::spawn(listen_for_shutdown_signal(shutdown_tx.clone(), signal_tx));

    let app = build_router(&state);

    let addr = "0.0.0.0:9000";
    info!("listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = signal_rx.await;
        })
        .await?;

    let _ = shutdown_tx.send(true);

    if let Err(err) = periodic_handle.await {
        error!("periodic flush task aborted: {:#}", err);
    }

    match finalize_shutdown(&state).await {
        Ok((loaded, wal)) => {
            info!(loaded, wal, "flushed snapshots before shutdown");
        }
        Err(err) => {
            error!("shutdown flush failed: {:#}", err);
        }
    }
    Ok(())
}

async fn run_periodic_snapshot_flush(state: AppState, mut shutdown: watch::Receiver<bool>) {
    let interval = Duration::from_millis(state.flush_idle_ms.max(50));
    loop {
        tokio::select! {
            _ = sleep(interval) => {
                let slugs: Vec<String> = state.docs.read().keys().cloned().collect();
                for slug in slugs {
                    if let Err(err) = flush_snapshot_if_needed(&state, &slug).await {
                        error!(%slug, "periodic flush failed: {:#}", err);
                    }
                }
            }
            changed = shutdown.changed() => {
                if changed.is_ok() && *shutdown.borrow() {
                    break;
                }
            }
        }
    }
}

#[cfg(unix)]
async fn listen_for_shutdown_signal(
    shutdown_tx: watch::Sender<bool>,
    signal_tx: oneshot::Sender<()>,
) {
    info!("waiting for shutdown signal (Ctrl+C or SIGTERM)");
    let mut sigterm_stream = match unix_signal(SignalKind::terminate()) {
        Ok(stream) => stream,
        Err(err) => {
            error!("failed to install SIGTERM handler: {:#}", err);
            signal::ctrl_c().await.ok();
            let _ = shutdown_tx.send(true);
            let _ = signal_tx.send(());
            return;
        }
    };
    tokio::select! {
        _ = signal::ctrl_c() => info!("received Ctrl+C (SIGINT)"),
        _ = sigterm_stream.recv() => info!("received SIGTERM"),
    }
    let _ = shutdown_tx.send(true);
    let _ = signal_tx.send(());
}

#[cfg(not(unix))]
async fn listen_for_shutdown_signal(
    shutdown_tx: watch::Sender<bool>,
    signal_tx: oneshot::Sender<()>,
) {
    info!("waiting for shutdown signal (Ctrl+C)");
    if signal::ctrl_c().await.is_ok() {
        info!("received Ctrl+C (SIGINT)");
    }
    let _ = shutdown_tx.send(true);
    let _ = signal_tx.send(());
}

async fn finalize_shutdown(state: &AppState) -> anyhow::Result<(usize, usize)> {
    let loaded = flush_loaded_docs(state).await?;
    let wal = flush_all_wals_to_snapshots(state).await?;
    Ok((loaded, wal))
}

async fn flush_loaded_docs(state: &AppState) -> anyhow::Result<usize> {
    let slugs: Vec<String> = state.docs.read().keys().cloned().collect();
    let mut flushed = 0usize;
    for slug in slugs {
        if flush_snapshot_force(state, &slug).await? {
            flushed += 1;
        }
    }
    Ok(flushed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::Doc;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use parking_lot::RwLock;
    use std::fs;
    use std::sync::Arc;
    use tower::util::ServiceExt;
    use uuid::Uuid;

    fn mk_state() -> AppState {
        let base = std::env::temp_dir().join(format!("main-tests-{}", Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let wal = base.join("wal");
        let snap = base.join("snapshots");
        fs::create_dir_all(&wal).unwrap();
        fs::create_dir_all(&snap).unwrap();
        AppState::new(wal, snap, 1_000, 128, true, Vec::new())
    }

    #[tokio::test]
    async fn router_serves_health_endpoint() {
        let state = mk_state();
        let app = build_router(&state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn router_enforces_snapshot_auth() {
        let state = mk_state();
        let slug = "secure";
        let mut doc = Doc::default();
        doc.password_hash = Some(crate::storage::hash_password("pw"));
        doc.content = "secret".into();
        state
            .docs
            .write()
            .insert(slug.into(), Arc::new(RwLock::new(doc)));

        let app = build_router(&state);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/snapshot?slug=secure")
                    .method("GET")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn flush_loaded_docs_writes_pending_content() {
        let state = mk_state();
        let slug = "flush-me";
        let mut doc = Doc::default();
        doc.content = "shutdown".into();
        doc.rev = 1;
        doc.since_flush = 1;
        state
            .docs
            .write()
            .insert(slug.into(), Arc::new(RwLock::new(doc)));

        let flushed = flush_loaded_docs(&state).await.unwrap();
        assert_eq!(flushed, 1);

        let snap = crate::storage::snapshot_path(&state, slug).unwrap();
        assert_eq!(fs::read_to_string(snap).unwrap(), "shutdown");
    }
}
