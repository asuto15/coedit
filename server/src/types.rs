use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OpKind {
    Insert { pos: usize, text: String },
    Delete { pos: usize, len: usize },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SelectionDirection {
    Forward,
    Backward,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CursorState {
    pub position: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_direction: Option<SelectionDirection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Edit {
    pub base_rev: u64,
    pub ops: Vec<OpKind>,
    pub client_id: Option<Uuid>,
    pub op_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_before: Option<CursorState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_after: Option<CursorState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotResp {
    pub slug: String,
    pub rev: u64,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImeSnapshot {
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<TextRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum ImeEvent {
    Start {
        range: TextRange,
    },
    Update {
        range: TextRange,
        text: String,
    },
    Commit {
        replace_range: TextRange,
        text: String,
    },
    Cancel {
        range: TextRange,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DocEvent {
    Edit {
        edit: Edit,
    },
    Cursor {
        client_id: Uuid,
        op_id: Option<Uuid>,
        cursor: CursorState,
    },
    Ime {
        client_id: Uuid,
        op_id: Option<Uuid>,
        ime: ImeEvent,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WalEntryV2 {
    pub version: u8,
    pub ts: u64,
    pub event: DocEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum WalLine {
    V2(WalEntryV2),
    V1(Edit),
}

pub const CURRENT_WAL_VERSION: u8 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PresenceState {
    pub client_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<CursorState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ime: Option<ImeSnapshot>,
    pub last_seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Hello {
        slug: String,
        client_id: Uuid,
        label: Option<String>,
        color: Option<String>,
    },
    Edit {
        slug: String,
        edit: Edit,
    },
    Cursor {
        slug: String,
        cursor: CursorState,
        op_id: Option<Uuid>,
        ts: Option<u64>,
    },
    Ime {
        slug: String,
        ime: ImeEvent,
        op_id: Option<Uuid>,
        ts: Option<u64>,
    },
    Profile {
        slug: String,
        label: Option<String>,
        color: Option<String>,
    },
    Join {
        session_id: String,
        client_id: Uuid,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        password: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        token: Option<String>,
    },
    #[serde(rename = "op")]
    CompatOp {
        session_id: String,
        operation: OpKind,
        context: CompatOpContext,
    },
    Ping {
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<u64>,
    },
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompatOpContext {
    #[serde(rename = "baseVersion")]
    pub base_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<CompatSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompatSelection {
    pub position: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_direction: Option<SelectionDirection>,
}

impl From<CompatSelection> for CursorState {
    fn from(value: CompatSelection) -> Self {
        CursorState {
            position: value.position,
            anchor: value.anchor,
            selection_direction: value.selection_direction,
        }
    }
}

impl From<CursorState> for CompatSelection {
    fn from(value: CursorState) -> Self {
        CompatSelection {
            position: value.position,
            anchor: value.anchor,
            selection_direction: value.selection_direction,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Applied {
        slug: String,
        rev: u64,
        ops: Vec<OpKind>,
        client_id: Option<Uuid>,
        op_id: Option<Uuid>,
        ts: u64,
    },
    Cursor {
        slug: String,
        client_id: Uuid,
        cursor: CursorState,
        op_id: Option<Uuid>,
        ts: u64,
    },
    Ime {
        slug: String,
        client_id: Uuid,
        ime: ImeEvent,
        op_id: Option<Uuid>,
        ts: u64,
    },
    PresenceSnapshot {
        slug: String,
        clients: Vec<PresenceState>,
    },
    PresenceDiff {
        slug: String,
        added: Vec<PresenceState>,
        updated: Vec<PresenceState>,
        removed: Vec<Uuid>,
    },
    #[serde(rename = "snapshot")]
    CompatSnapshot {
        session_id: String,
        rev: u64,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        presence: Option<Vec<PresenceState>>,
    },
    #[serde(rename = "op_broadcast")]
    CompatOpBroadcast {
        session_id: String,
        operation: OpKind,
        context: CompatOpBroadcastContext,
    },
    #[serde(rename = "ack")]
    CompatAck {
        session_id: String,
        server_seq: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        op_id: Option<Uuid>,
    },
    Pong {
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompatOpBroadcastContext {
    #[serde(rename = "serverSeq")]
    pub server_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<CompatSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<u64>,
}
