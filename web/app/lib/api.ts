export type Snapshot = { slug: string; rev: number; content: string }
export type Op =
  | { type: 'insert'; pos: number; text: string }
  | { type: 'delete'; pos: number; len: number }

const STORAGE_PREFIX = process.env.NEXT_PUBLIC_STORAGE_PREFIX ?? 'coedit'
const passwordKey = (slug: string) => `${STORAGE_PREFIX}:pwd:${slug}`

export class UnauthorizedError extends Error {}

export function getStoredPassword(slug: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(passwordKey(slug))
  } catch (error) {
    console.warn('localStorage.getItemでパスワードの取得に失敗しました', error)
    return null
  }
}

export function setStoredPassword(slug: string, password: string | null) {
  if (typeof window === 'undefined') return
  try {
    if (password && password.length > 0) {
      localStorage.setItem(passwordKey(slug), password)
    } else {
      localStorage.removeItem(passwordKey(slug))
    }
  } catch (error) {
    console.warn('localStorageでパスワードの保存に失敗しました', error)
  }
}

function buildBasicToken(slug: string, password: string): string {
  const payload = `${slug}:${password}`
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return window.btoa(payload)
  }
  return Buffer.from(payload, 'utf-8').toString('base64')
}

export async function fetchSnapshot(slug: string, opts?: { password?: string }): Promise<Snapshot> {
  const headers = new Headers()
  const headerPassword = opts?.password ?? getStoredPassword(slug)
  if (headerPassword) headers.set('Authorization', `Basic ${buildBasicToken(slug, headerPassword)}`)
  const params = new URLSearchParams({ slug })
  if (opts?.password) params.set('password', opts.password)
  const res = await fetch(`/api/snapshot?${params.toString()}`, {
    cache: 'no-store',
    headers,
  })
  if (res.status === 401) throw new UnauthorizedError('unauthorized')
  if (!res.ok) throw new Error('failed to fetch snapshot')
  return res.json()
}

export type SelectionDirection = 'forward' | 'backward'

export type CursorState = {
  position: number
  anchor?: number
  selection_direction?: SelectionDirection
}

export type TextRange = { start: number; end: number }

export type ImeEvent =
  | { phase: 'start'; range: TextRange }
  | { phase: 'update'; range: TextRange; text: string }
  | { phase: 'commit'; replace_range: TextRange; text: string }
  | { phase: 'cancel'; range: TextRange }

export type ImeSnapshot = { phase: string; range?: TextRange; text?: string }

export type PresenceState = {
  client_id: string
  label?: string
  color?: string
  cursor?: CursorState
  ime?: ImeSnapshot
  last_seen: number
}

export type AppliedMsg = { type: 'applied'; slug: string; rev: number; ops: Op[]; client_id?: string; op_id?: string; ts: number }
export type CursorMsgInbound = { type: 'cursor'; slug: string; client_id: string; cursor: CursorState; op_id?: string; ts: number }
export type ImeMsgInbound = { type: 'ime'; slug: string; client_id: string; ime: ImeEvent; op_id?: string; ts: number }
export type PresenceSnapshotMsg = { type: 'presence_snapshot'; slug: string; clients: PresenceState[] }
export type PresenceDiffMsg = { type: 'presence_diff'; slug: string; added: PresenceState[]; updated: PresenceState[]; removed: string[] }
export type PingMsg = { type: 'ping' }
export type PongMsg = { type: 'pong' }
export type SnapshotMsg = { type: 'snapshot'; payload: Snapshot }
export type OpBroadcastMsg = {
  type: 'op_broadcast'
  payload: {
    operation: Op
    context: {
      serverSeq: number
      clientId?: string
      ts?: number
    }
  }
}
export type AckMsg = { type: 'ack'; sessionId: string; serverSeq: number; opId?: string }

export type EditPayload = {
  base_rev: number
  ops: Op[]
  client_id?: string
  op_id?: string
  cursor_before?: CursorState
  cursor_after?: CursorState
  ts?: number
}

export type EditMsg = { type: 'edit'; slug: string; edit: EditPayload }
export type HelloMsg = { type: 'hello'; slug: string; client_id: string; label?: string; color?: string }
export type CursorMsgOutbound = { type: 'cursor'; slug: string; cursor: CursorState; op_id?: string; ts?: number }
export type ImeMsgOutbound = { type: 'ime'; slug: string; ime: ImeEvent; op_id?: string; ts?: number }
export type ProfileMsgOutbound = { type: 'profile'; slug: string; label?: string | null; color?: string | null }
export type JoinMsgOutbound = {
  type: 'join'
  sessionId: string
  clientId: string
  label?: string
  color?: string
  password?: string
}
export type CompatOpMsg = {
  type: 'op'
  operation: Op
  context: {
    baseVersion: number
    clientId?: string
    selection?: CursorState
  }
  sessionId: string
}

export type WsInbound =
  | AppliedMsg
  | CursorMsgInbound
  | ImeMsgInbound
  | PresenceSnapshotMsg
  | PresenceDiffMsg
  | PongMsg
  | SnapshotMsg
  | OpBroadcastMsg
  | AckMsg
export type WsOutbound =
  | EditMsg
  | PingMsg
  | HelloMsg
  | CursorMsgOutbound
  | ImeMsgOutbound
  | ProfileMsgOutbound
  | PongMsg
  | JoinMsgOutbound
  | CompatOpMsg

export function openWs(slug: string): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const pwd = getStoredPassword(slug)
  const token = pwd ? `&token=${encodeURIComponent(buildBasicToken(slug, pwd))}` : ''
  const url = `${proto}//${location.host}/api/ws?slug=${encodeURIComponent(slug)}${token}`
  return new WebSocket(url)
}

export async function updatePasswordOnServer(slug: string, newPassword: string, currentPassword?: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const existing = currentPassword ?? getStoredPassword(slug) ?? undefined
  if (existing) headers['Authorization'] = `Basic ${buildBasicToken(slug, existing)}`
  const res = await fetch('/api/password', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      slug,
      current_password: existing ?? null,
      new_password: newPassword,
    }),
  })
  if (res.status === 401) throw new UnauthorizedError('unauthorized')
  if (!res.ok) throw new Error('failed to update password')
}
