use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::{sync::mpsc, time::sleep};
use tracing::{error, warn};
use uuid::Uuid;

use anyhow::anyhow;

use crate::{
    auth::{extract_password_from_headers, extract_password_from_token, is_authorized},
    presence::{
        register_presence, remove_presence, touch_presence, update_presence_cursor,
        update_presence_ime, update_presence_profile,
    },
    state::{AppState, apply_edit, broadcast, get_or_load_doc, now_millis, remember_op_id},
    storage::{flush_snapshot_if_needed, wal_append_event},
    types::{ClientMsg, CompatOpContext, CursorState, DocEvent, Edit, ImeEvent, OpKind, ServerMsg},
};

#[derive(Clone, Copy)]
struct ClientMeta {
    id: Uuid,
    compat: bool,
}

#[derive(Deserialize)]
pub struct WsQuery {
    pub slug: String,
    pub token: Option<String>,
    pub password: Option<String>,
}

pub async fn ws_handler(
    State(state): State<AppState>,
    Query(q): Query<WsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !state.app_env_dev
        && !state.allowed_origins.is_empty()
        && let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok())
        && !state
            .allowed_origins
            .iter()
            .any(|allowed| origin.starts_with(allowed))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let WsQuery {
        slug,
        token,
        password,
    } = q;
    let header_pw = extract_password_from_headers(&headers, &slug);
    let mut provided = password;
    if provided.is_none() {
        provided = header_pw;
    }
    if provided.is_none() {
        provided = token
            .as_deref()
            .and_then(|t| extract_password_from_token(t, &slug));
    }
    let doc = match get_or_load_doc(&state, &slug).await {
        Ok(doc) => doc,
        Err(err) => {
            error!("invalid slug '{}': {:#}", slug, err);
            return StatusCode::BAD_REQUEST.into_response();
        }
    };
    {
        let d = doc.read();
        if !is_authorized(&d, provided.as_deref()) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
    }
    ws.on_upgrade(move |socket| handle_ws(state, slug, socket))
}

async fn handle_ws(state: AppState, slug: String, socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    if let Err(err) = get_or_load_doc(&state, &slug).await {
        error!("invalid slug '{}': {:#}", slug, err);
        return;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMsg>();
    {
        let mut subs = state.subs.write();
        subs.entry(slug.clone()).or_default().push(tx.clone());
    }
    let tx_self = tx.clone();
    let client_id_store = Arc::new(Mutex::new(None::<ClientMeta>));

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(text) => {
                    if sender.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
                Err(err) => {
                    warn!("failed to serialize ws message: {:#}", err);
                }
            }
        }
    });

    let st = state.clone();
    let slug_cl = slug.clone();
    let client_id_for_task = client_id_store.clone();
    let tx_for_task = tx_self.clone();
    let mut recv_task = tokio::spawn(async move {
        let mut established = false;
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(t) => match serde_json::from_str::<ClientMsg>(&t) {
                    Ok(client_msg) => {
                        if let Err(err) = handle_client_message(
                            client_msg,
                            &mut established,
                            &st,
                            &slug_cl,
                            &client_id_for_task,
                            &tx_for_task,
                        )
                        .await
                        {
                            error!(slug = %slug_cl, "handle_client_message error: {:#}", err);
                            break;
                        }
                    }
                    Err(err) => {
                        warn!("failed to parse ws message: {:#}", err);
                    }
                },
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    let st2 = state.clone();
    let slug2 = slug.clone();
    let idle_ms = state.flush_idle_ms;
    let flush_task = tokio::spawn(async move {
        loop {
            sleep(Duration::from_millis(idle_ms)).await;
            if let Err(e) = flush_snapshot_if_needed(&st2, &slug2).await {
                error!("flush error: {:#}", e);
            }
        }
    });

    tokio::select! {
        _ = (&mut send_task) => {}
        _ = (&mut recv_task) => {}
    }
    if let Some(meta) = *client_id_store.lock()
        && let Some(removed) = remove_presence(&state, &slug, &meta.id)
    {
        broadcast(
            &state,
            &slug,
            ServerMsg::PresenceDiff {
                slug: slug.clone(),
                added: vec![],
                updated: vec![],
                removed: vec![removed.client_id],
            },
        );
    }
    flush_task.abort();
}

async fn handle_client_message(
    msg: ClientMsg,
    established: &mut bool,
    state: &AppState,
    slug: &str,
    client_meta: &Arc<Mutex<Option<ClientMeta>>>,
    tx_for_task: &mpsc::UnboundedSender<ServerMsg>,
) -> anyhow::Result<()> {
    use ClientMsg::*;

    match msg {
        Hello {
            slug: hello_slug,
            client_id,
            label,
            color,
        } => handle_hello(
            established,
            state,
            slug,
            client_meta,
            tx_for_task,
            hello_slug,
            client_id,
            label,
            color,
        ),
        Join {
            session_id,
            client_id,
            label,
            color,
            password,
            token,
        } => {
            handle_compat_join(
                state,
                slug,
                client_meta,
                tx_for_task,
                established,
                session_id,
                client_id,
                label,
                color,
                password,
                token,
            )
            .await
        }
        CompatOp {
            session_id,
            operation,
            context,
        } => {
            *established = true;
            handle_compat_op(state, slug, client_meta, session_id, operation, context).await
        }
        Edit { slug: _, edit } => {
            if !*established {
                return Ok(());
            }
            handle_edit(state, slug, client_meta, edit).await
        }
        Cursor {
            slug: _,
            cursor,
            op_id,
            ts,
        } => {
            if !*established {
                return Ok(());
            }
            handle_cursor(state, slug, client_meta, cursor, op_id, ts)
        }
        Ime {
            slug: _,
            ime,
            op_id,
            ts,
        } => {
            if !*established {
                return Ok(());
            }
            handle_ime(state, slug, client_meta, ime, op_id, ts)
        }
        Profile {
            slug: profile_slug,
            label,
            color,
        } => {
            if !*established {
                return Ok(());
            }
            handle_profile(state, slug, client_meta, profile_slug, label, color)
        }
        Ping { ts } => {
            if !*established {
                return Ok(());
            }
            handle_ping(state, slug, client_meta, tx_for_task, ts);
            Ok(())
        }
        Pong => {
            if !*established {
                return Ok(());
            }
            handle_pong(state, slug, client_meta);
            Ok(())
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_compat_join(
    state: &AppState,
    slug: &str,
    client_meta: &Arc<Mutex<Option<ClientMeta>>>,
    tx_for_task: &mpsc::UnboundedSender<ServerMsg>,
    established: &mut bool,
    session_id: String,
    client_id: Uuid,
    label: Option<String>,
    color: Option<String>,
    password: Option<String>,
    token: Option<String>,
) -> anyhow::Result<()> {
    if session_id != slug {
        warn!(expected = %slug, received = %session_id, "compat join slug mismatch");
        return Ok(());
    }

    let doc = get_or_load_doc(state, slug).await?;
    let mut provided = password;
    if provided.is_none()
        && let Some(tk) = token.as_deref()
    {
        provided = extract_password_from_token(tk, slug);
    }

    {
        let guard = doc.read();
        if !is_authorized(&guard, provided.as_deref()) {
            return Err(anyhow!("unauthorized compat join request"));
        }
    }

    {
        let mut guard = client_meta.lock();
        *guard = Some(ClientMeta {
            id: client_id,
            compat: true,
        });
    }

    let now = now_millis();
    let (presence_snapshot, added) = register_presence(state, slug, client_id, label, color, now);
    if tx_for_task
        .send(ServerMsg::PresenceSnapshot {
            slug: slug.to_string(),
            clients: presence_snapshot.clone(),
        })
        .is_err()
    {
        return Ok(());
    }

    broadcast(
        state,
        slug,
        ServerMsg::PresenceDiff {
            slug: slug.to_string(),
            added: vec![added],
            updated: vec![],
            removed: vec![],
        },
    );

    let doc_guard = doc.read();
    let _ = tx_for_task.send(ServerMsg::CompatSnapshot {
        session_id: slug.to_string(),
        rev: doc_guard.rev,
        content: doc_guard.content.clone(),
        presence: Some(presence_snapshot),
    });

    *established = true;
    Ok(())
}

async fn handle_compat_op(
    state: &AppState,
    slug: &str,
    client_meta: &Arc<Mutex<Option<ClientMeta>>>,
    session_id: String,
    operation: OpKind,
    context: CompatOpContext,
) -> anyhow::Result<()> {
    if session_id != slug {
        warn!(expected = %slug, received = %session_id, "compat op slug mismatch");
        return Ok(());
    }

    let CompatOpContext {
        base_version,
        client_id: ctx_client_id,
        selection,
        op_id,
        ts,
    } = context;

    let effective_client_id = {
        let mut guard = client_meta.lock();
        match *guard {
            Some(mut meta) => {
                if !meta.compat {
                    meta.compat = true;
                    *guard = Some(meta);
                }
                meta.id
            }
            None => {
                let cid = ctx_client_id.ok_or_else(|| anyhow!("compat op missing client id"))?;
                *guard = Some(ClientMeta {
                    id: cid,
                    compat: true,
                });
                cid
            }
        }
    };

    let now = now_millis();
    touch_presence(state, slug, &effective_client_id, now);

    let edit = Edit {
        base_rev: base_version,
        ops: vec![operation],
        client_id: Some(ctx_client_id.unwrap_or(effective_client_id)),
        op_id,
        cursor_before: None,
        cursor_after: selection.map(CursorState::from),
        ts: ts.or(Some(now)),
    };

    apply_edit(state, slug, edit).await?;
    Ok(())
}

fn current_client(meta: &Arc<Mutex<Option<ClientMeta>>>) -> Option<ClientMeta> {
    *meta.lock()
}

fn handle_hello(
    established: &mut bool,
    state: &AppState,
    slug: &str,
    client_meta: &Arc<Mutex<Option<ClientMeta>>>,
    tx_for_task: &mpsc::UnboundedSender<ServerMsg>,
    hello_slug: String,
    client_id: Uuid,
    label: Option<String>,
    color: Option<String>,
) -> anyhow::Result<()> {
    if *established {
        return Ok(());
    }
    if hello_slug != slug {
        warn!(expected = %slug, received = %hello_slug, "hello slug mismatch");
        return Err(anyhow!("hello slug mismatch"));
    }
    {
        let mut guard = client_meta.lock();
        *guard = Some(ClientMeta {
            id: client_id,
            compat: false,
        });
    }
    let now = now_millis();
    let (snapshot, added) = register_presence(state, slug, client_id, label, color, now);
    if tx_for_task
        .send(ServerMsg::PresenceSnapshot {
            slug: slug.to_string(),
            clients: snapshot,
        })
        .is_err()
    {
        return Ok(());
    }
    broadcast(
        state,
        slug,
        ServerMsg::PresenceDiff {
            slug: slug.to_string(),
            added: vec![added],
            updated: vec![],
            removed: vec![],
        },
    );
    *established = true;
    Ok(())
}

async fn handle_edit(
    state: &AppState,
    slug: &str,
    client_meta: &Arc<Mutex<Option<ClientMeta>>>,
    mut edit: Edit,
) -> anyhow::Result<()> {
    let cid = match current_client(client_meta) {
        Some(meta) => meta.id,
        None => return Ok(()),
    };
    let now = now_millis();
    touch_presence(state, slug, &cid, now);
    if edit.client_id.is_none() {
        edit.client_id = Some(cid);
    }
    if edit.ts.is_none() {
        edit.ts = Some(now);
    }
    apply_edit(state, slug, edit).await
}

fn handle_cursor(
    state: &AppState,
    slug: &str,
    client_meta: &Arc<Mutex<Option<ClientMeta>>>,
    cursor: CursorState,
    op_id: Option<Uuid>,
    ts: Option<u64>,
) -> anyhow::Result<()> {
    if let Some(meta) = current_client(client_meta) {
        let cid = meta.id;
        let server_now = now_millis();
        let ts_value = ts.unwrap_or(server_now);
        if let Some(updated) = update_presence_cursor(state, slug, cid, cursor.clone(), server_now)
        {
            let mut should_append = true;
            if let Some(id) = op_id {
                should_append = remember_op_id(state, slug, id);
            }
            if should_append {
                let event = DocEvent::Cursor {
                    client_id: cid,
                    op_id,
                    cursor: cursor.clone(),
                };
                if let Err(err) = wal_append_event(state, slug, &event, ts_value) {
                    error!("failed to append cursor event: {:#}", err);
                }
            }
            broadcast(
                state,
                slug,
                ServerMsg::Cursor {
                    slug: slug.to_string(),
                    client_id: cid,
                    cursor,
                    op_id,
                    ts: ts_value,
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
    Ok(())
}

fn handle_ime(
    state: &AppState,
    slug: &str,
    client_meta: &Arc<Mutex<Option<ClientMeta>>>,
    ime: ImeEvent,
    op_id: Option<Uuid>,
    ts: Option<u64>,
) -> anyhow::Result<()> {
    if let Some(meta) = current_client(client_meta) {
        let cid = meta.id;
        let server_now = now_millis();
        let ts_value = ts.unwrap_or(server_now);
        if let Some(updated) = update_presence_ime(state, slug, cid, &ime, server_now) {
            let mut should_append = true;
            if let Some(id) = op_id {
                should_append = remember_op_id(state, slug, id);
            }
            if should_append {
                let event = DocEvent::Ime {
                    client_id: cid,
                    op_id,
                    ime: ime.clone(),
                };
                if let Err(err) = wal_append_event(state, slug, &event, ts_value) {
                    error!("failed to append ime event: {:#}", err);
                }
            }
            broadcast(
                state,
                slug,
                ServerMsg::Ime {
                    slug: slug.to_string(),
                    client_id: cid,
                    ime: ime.clone(),
                    op_id,
                    ts: ts_value,
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
    Ok(())
}

fn handle_profile(
    state: &AppState,
    slug: &str,
    client_meta: &Arc<Mutex<Option<ClientMeta>>>,
    profile_slug: String,
    label: Option<String>,
    color: Option<String>,
) -> anyhow::Result<()> {
    if profile_slug != slug {
        warn!(expected = %slug, received = %profile_slug, "profile slug mismatch");
        return Ok(());
    }
    if let Some(meta) = current_client(client_meta) {
        let cid = meta.id;
        let now = now_millis();
        if let Some(updated) = update_presence_profile(state, slug, cid, label, color, now) {
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
    Ok(())
}

fn handle_ping(
    state: &AppState,
    slug: &str,
    client_meta: &Arc<Mutex<Option<ClientMeta>>>,
    tx_for_task: &mpsc::UnboundedSender<ServerMsg>,
    ts: Option<u64>,
) {
    if let Some(meta) = current_client(client_meta) {
        touch_presence(state, slug, &meta.id, now_millis());
    }
    let _ = tx_for_task.send(ServerMsg::Pong { ts });
}

fn handle_pong(state: &AppState, slug: &str, client_meta: &Arc<Mutex<Option<ClientMeta>>>) {
    if let Some(meta) = current_client(client_meta) {
        touch_presence(state, slug, &meta.id, now_millis());
    }
}
