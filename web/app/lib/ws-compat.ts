'use client'

import { v4 as uuidv4 } from 'uuid'
import {
  fetchSnapshot,
  getStoredPassword,
  setStoredPassword,
  type Snapshot,
  type Op as CompatOp,
  type PresenceState,
  type CursorState,
  type ImeEvent,
} from './api'

type JoinMessage = {
  type: 'join'
  sessionId: string
  clientId: string
  label?: string
  color?: string
  password?: string
}

type CompatOpMessage = {
  type: 'op'
  operation: CompatOp
  context: {
    clientId?: string
    baseVersion: number
    selection?: {
      position: number
      anchor?: number
      selection_direction?: 'forward' | 'backward'
    }
  }
  sessionId: string
}

type CompatPingMessage =
  | { type: 'ping' }
  | { type: 'ping'; ts: number }

type ServerApplied = {
  type: 'applied'
  slug: string
  rev: number
  ops: CompatOp[]
  client_id?: string
  op_id?: string
  ts: number
}

type ServerPresenceSnapshot = {
  type: 'presence_snapshot'
  slug: string
  clients: PresenceState[]
}

type ServerPresenceDiff = {
  type: 'presence_diff'
  slug: string
  added: PresenceState[]
  updated: PresenceState[]
  removed: string[]
}

type ServerCursor = {
  type: 'cursor'
  slug: string
  client_id: string
  cursor: CursorState
  op_id?: string
  ts: number
}

type ServerIme = {
  type: 'ime'
  slug: string
  client_id: string
  ime: ImeEvent
  op_id?: string
  ts: number
}

type ServerMsg =
  | ServerApplied
  | ServerPresenceSnapshot
  | ServerPresenceDiff
  | ServerCursor
  | ServerIme
  | { type: 'pong'; ts?: number }
  | (Record<string, unknown> & { type: string })

const OriginalWebSocket = globalThis.WebSocket

function isBrowser(): boolean {
  return typeof window !== 'undefined'
}

function deriveSlug(): string {
  if (!isBrowser()) return ''
  const globalWindow = window as Window & { __COEDIT_SLUG?: unknown }
  const fromGlobal = globalWindow.__COEDIT_SLUG
  if (typeof fromGlobal === 'string' && fromGlobal.length > 0) {
    return fromGlobal
  }
  const path = window.location.pathname
  const editPrefix = '/edit/'
  const viewPrefix = '/view/'
  if (path.startsWith(editPrefix)) {
    return decodeURIComponent(path.slice(editPrefix.length))
  }
  if (path.startsWith(viewPrefix)) {
    return decodeURIComponent(path.slice(viewPrefix.length))
  }
  return ''
}

function buildBasicToken(slug: string, password: string): string {
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return window.btoa(`${slug}:${password}`)
  }
  return Buffer.from(`${slug}:${password}`, 'utf-8').toString('base64')
}

function buildWsUrl(rawUrl: string, slug: string): string {
  if (!isBrowser()) return rawUrl
  try {
    const base = rawUrl.startsWith('ws')
      ? rawUrl
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`
    const url = new URL(base, window.location.href)
    const isCoeditApi = url.pathname.startsWith('/api/')
    if (!isCoeditApi) {
      return url.toString()
    }
    if (slug.length > 0) {
      url.searchParams.set('slug', slug)
    }
    const stored = getStoredPassword(slug)
    if (stored) {
      url.searchParams.set('token', buildBasicToken(slug, stored))
    }
    return url.toString()
  } catch (error) {
    console.warn('WebSocket URLの生成に失敗しました', error)
    return rawUrl
  }
}

function toServerOp(op: CompatOp) {
  if (op.type === 'insert') {
    return { type: 'insert', pos: op.pos, text: op.text }
  }
  return { type: 'delete', pos: op.pos, len: op.len }
}

function toCompatOp(op: CompatOp): CompatOp {
  return op
}

type CompatMessage =
  | { type: 'snapshot'; payload: Snapshot }
  | {
      type: 'op_broadcast'
      payload: {
        operation: CompatOp
        context: {
          serverSeq: number
          clientId?: string
          ts?: number
        }
      }
    }
  | { type: 'ack'; sessionId: string; serverSeq: number }
  | { type: 'ack'; sessionId: string; serverSeq: number; opId?: string }
  | (Record<string, unknown> & { type: string })

class CompatWebSocket extends (OriginalWebSocket ?? class {}) {
  private slug: string
  private sessionId: string
  private clientId?: string
  private messageTarget: EventTarget
  private onMessageHandler: ((ev: MessageEvent) => void) | null
  private pendingOpIds: Set<string>
  private lastSnapshot?: Snapshot
  private readonly applyCompat: boolean

  constructor(url: string, protocols?: string | string[]) {
    if (!OriginalWebSocket) {
      throw new Error('WebSocket is not supported in this environment')
    }
    const slug = deriveSlug()
    const finalUrl = buildWsUrl(url, slug)
    super(finalUrl, protocols)
    this.slug = slug
    this.sessionId = slug
    this.messageTarget = new EventTarget()
    this.onMessageHandler = null
    this.pendingOpIds = new Set()
    const parsedUrl = (() => {
      try {
        return new URL(finalUrl)
      } catch {
        return null
      }
    })()
    this.applyCompat = parsedUrl?.pathname.startsWith('/api/') ?? false

    if (this.applyCompat) {
      super.addEventListener('message', ev => {
        this.handleServerMessage(ev)
      })
    }
  }

  override set onmessage(handler: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
    if (!this.applyCompat) {
      super.onmessage = handler
      return
    }
    if (this.onMessageHandler) {
      this.messageTarget.removeEventListener('message', this.onMessageHandler as EventListener)
    }
    if (handler) {
      const wrapped = (ev: Event) => {
        handler.call(this, ev as MessageEvent)
      }
      this.onMessageHandler = wrapped as (ev: MessageEvent) => void
      this.messageTarget.addEventListener('message', wrapped)
    } else {
      this.onMessageHandler = null
    }
  }

  override get onmessage(): ((this: WebSocket, ev: MessageEvent) => unknown) | null {
    if (!this.applyCompat) {
      return super.onmessage
    }
    return this.onMessageHandler
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (!this.applyCompat) {
      super.addEventListener(type, listener ?? undefined, options)
      return
    }
    if (type === 'message' && listener) {
      this.messageTarget.addEventListener('message', listener, options)
      return
    }
    if (!listener) return
    super.addEventListener(type, listener as EventListenerOrEventListenerObject, options)
  }

  override removeEventListener(
    type: string,
    listener?: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (!this.applyCompat) {
      super.removeEventListener(type, listener ?? undefined, options)
      return
    }
    if (type === 'message' && listener) {
      this.messageTarget.removeEventListener('message', listener, options)
      return
    }
    if (!listener) return
    super.removeEventListener(type, listener as EventListenerOrEventListenerObject, options)
  }

  private dispatchCompat(msg: CompatMessage) {
    if (!this.applyCompat) return
    const event = new MessageEvent('message', {
      data: JSON.stringify(msg),
      origin: window.location.origin,
    })
    this.messageTarget.dispatchEvent(event)
  }

  private dispatchNative(msg: ServerMsg) {
    if (!this.applyCompat) return
    super.dispatchEvent(
      new MessageEvent('coedit:server-msg', {
        data: msg,
      }),
    )
  }

  private async handleJoin(msg: JoinMessage) {
    if (!this.applyCompat) return
    this.sessionId = msg.sessionId
    this.clientId = msg.clientId
    if (msg.password && msg.password.length > 0) {
      setStoredPassword(this.sessionId, msg.password)
    }
    try {
      const hello = {
        type: 'hello',
        slug: this.sessionId,
        client_id: msg.clientId,
        label: msg.label ?? null,
        color: msg.color ?? null,
      }
      super.send(JSON.stringify(hello))
      const snapshot = await fetchSnapshot(this.sessionId, msg.password ? { password: msg.password } : undefined)
      this.lastSnapshot = snapshot
      this.dispatchCompat({ type: 'snapshot', payload: snapshot })
    } catch (err) {
      console.error('failed to perform hello handshake', err)
    }
  }

  override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (!this.applyCompat) {
      super.send(data)
      return
    }
    if (typeof data !== 'string') {
      super.send(data)
      return
    }
    try {
      const parsed = JSON.parse(data)
      if (parsed && typeof parsed === 'object' && 'type' in parsed && typeof parsed.type === 'string') {
        switch (parsed.type) {
          case 'join':
            this.handleJoin(parsed as JoinMessage)
            return
          case 'op':
            this.handleCompatOp(parsed as CompatOpMessage)
            return
          case 'ping':
            this.handleCompatPing(parsed as CompatPingMessage)
            return
          default:
            break
        }
      }
    } catch (error) {
      console.warn('互換WSラッパーで送信メッセージの解析に失敗しました', error)
    }
    super.send(data)
  }

  private handleCompatPing(msg: CompatPingMessage) {
    if (!this.applyCompat) return
    const payload: { type: 'ping'; ts?: number } = { type: 'ping' }
    if ('ts' in msg && typeof msg.ts === 'number') {
      payload.ts = msg.ts
    }
    super.send(JSON.stringify(payload))
  }

  private handleCompatOp(msg: CompatOpMessage) {
    if (!this.applyCompat) {
      super.send(JSON.stringify(msg))
      return
    }
    if (!this.sessionId || this.sessionId.length === 0) {
      console.warn('sessionId is not set; ignoring op message')
      return
    }
    const opId = uuidv4()
    this.pendingOpIds.add(opId)
    const editPayload = {
      type: 'edit',
      slug: this.sessionId,
      edit: {
        base_rev: msg.context.baseVersion,
        ops: [toServerOp(msg.operation)],
        client_id: this.clientId ?? undefined,
        op_id: opId,
        cursor_after: msg.context.selection ?? undefined,
        ts: Date.now(),
      },
    }
    super.send(JSON.stringify(editPayload))
  }

  private handleServerMessage(ev: MessageEvent) {
    if (!this.applyCompat) return
    let parsed: ServerMsg | null = null
    if (typeof ev.data === 'string') {
      try {
        parsed = JSON.parse(ev.data)
      } catch (err) {
        console.error('failed to parse ws message', err)
      }
    } else {
      parsed = ev.data as ServerMsg
    }

    if (!parsed || typeof parsed !== 'object') {
      return
    }

    this.dispatchNative(parsed)

    switch (parsed.type) {
      case 'applied': {
        const serverMsg = parsed as ServerApplied
        const serverSeq = serverMsg.rev
        if (serverMsg.client_id && this.clientId && serverMsg.client_id === this.clientId) {
          this.pendingOpIds.delete(serverMsg.op_id ?? '')
          this.dispatchCompat({
            type: 'ack',
            sessionId: this.sessionId,
            serverSeq,
            opId: serverMsg.op_id,
          })
        } else {
          for (const op of serverMsg.ops) {
            this.dispatchCompat({
              type: 'op_broadcast',
              payload: {
                operation: toCompatOp(op),
                context: {
                  serverSeq,
                  clientId: serverMsg.client_id,
                  ts: serverMsg.ts,
                },
              },
            })
          }
        }
        break
      }
      default:
        break
    }
  }
}

if (isBrowser() && OriginalWebSocket) {
  type WebSocketWithFlag = typeof OriginalWebSocket & { __coeditCompatApplied?: boolean }
  const originalWithFlag = OriginalWebSocket as WebSocketWithFlag
  if (!originalWithFlag.__coeditCompatApplied) {
    Object.defineProperty(CompatWebSocket, 'CONNECTING', { value: OriginalWebSocket.CONNECTING })
    Object.defineProperty(CompatWebSocket, 'OPEN', { value: OriginalWebSocket.OPEN })
    Object.defineProperty(CompatWebSocket, 'CLOSING', { value: OriginalWebSocket.CLOSING })
    Object.defineProperty(CompatWebSocket, 'CLOSED', { value: OriginalWebSocket.CLOSED })
    type CompatWithFlag = typeof CompatWebSocket & { __coeditCompatApplied?: boolean }
    ;(CompatWebSocket as CompatWithFlag).__coeditCompatApplied = true
    originalWithFlag.__coeditCompatApplied = true
    const windowWithWebSocket = window as Window & { WebSocket: typeof OriginalWebSocket }
    windowWithWebSocket.WebSocket = CompatWebSocket as unknown as typeof OriginalWebSocket
  }
}
