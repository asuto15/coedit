import { useEffect, useRef, useState, type DependencyList } from 'react'

import { openWs, type CursorState, type Op } from './api'

export type PendingEdit = {
  op_id: string
  base_rev: number
  ops: Op[]
  cursor_before?: CursorState
  cursor_after?: CursorState
  ts?: number
}

export type PendingQueueSnapshot = {
  latestAck?: number
  items?: PendingEdit[]
}

export class PendingQueue {
  private q: PendingEdit[] = []
  private latestAck = 0

  constructor(initial?: PendingQueueSnapshot) {
    if (initial) {
      this.replace(initial)
    }
  }

  enqueue(edit: PendingEdit) {
    this.q.push(edit)
  }

  ack(opts: { opId?: string; serverSeq?: number }) {
    if (opts.opId) {
      this.q = this.q.filter(entry => entry.op_id !== opts.opId)
    }
    if (typeof opts.serverSeq === 'number' && opts.serverSeq > this.latestAck) {
      this.latestAck = opts.serverSeq
    }
  }

  latestServerSeq() {
    return this.latestAck
  }

  setLatestServerSeq(seq: number) {
    if (seq > this.latestAck) {
      this.latestAck = seq
    }
  }

  flush(sender: (edit: PendingEdit) => void) {
    for (const edit of this.q) {
      sender(edit)
    }
  }

  isEmpty() {
    return this.q.length === 0
  }

  snapshot(): PendingQueueSnapshot {
    return {
      latestAck: this.latestAck,
      items: this.q.map(item => ({ ...item, ops: item.ops.map(op => ({ ...op })) })),
    }
  }

  replace(snapshot?: PendingQueueSnapshot | PendingEdit[]) {
    if (!snapshot) {
      this.q = []
      this.latestAck = 0
      return
    }
    if (Array.isArray(snapshot)) {
      this.q = snapshot.map(item => ({ ...item, ops: item.ops.map(op => ({ ...op })) }))
      this.latestAck = 0
      return
    }
    const { items = [], latestAck = 0 } = snapshot
    this.q = items.map(item => ({ ...item, ops: item.ops.map(op => ({ ...op })) }))
    this.latestAck = latestAck
  }

  toJSON() {
    return this.snapshot()
  }

  [Symbol.iterator]() {
    return this.q[Symbol.iterator]()
  }
}

type UseRealtimeChannelOptions = {
  reconnectDeps?: DependencyList
  createSocket?: () => WebSocket
  onOpen?: (socket: WebSocket) => void
  onClose?: (event: CloseEvent) => void
  onError?: (event: Event) => void
}

export const useRealtimeChannel = (
  sessionId: string | null,
  options?: UseRealtimeChannelOptions,
) => {
  const [socket, setSocket] = useState<WebSocket | null>(null)
  const retryRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reconnectDeps = options?.reconnectDeps ?? []
  const createSocket = options?.createSocket
  const handleOpen = options?.onOpen
  const handleClose = options?.onClose
  const handleError = options?.onError

  useEffect(() => {
    if (!sessionId) {
      setSocket(prev => {
        if (prev) {
          try {
            prev.close(1000, 'session cleared')
          } catch (closeError) {
            console.warn('既存WebSocketのクローズに失敗しました', closeError)
          }
        }
        return null
      })
      return
    }

    let closed = false
    let ws: WebSocket | null = null

    const connect = () => {
      if (closed) return
      const socketFactory = createSocket ?? (() => openWs(sessionId))
      const next = socketFactory()
      ws = next
      setSocket(next)
      next.addEventListener('open', () => {
        retryRef.current = 0
        handleOpen?.(next)
      })
      next.addEventListener('close', event => {
        handleClose?.(event)
        if (closed) return
        const retry = Math.min(8, retryRef.current + 1)
        retryRef.current = retry
        const delay = Math.min(10_000, 500 * 2 ** retry)
        if (timerRef.current) {
          clearTimeout(timerRef.current)
        }
        timerRef.current = setTimeout(connect, delay)
      })
      next.addEventListener('error', event => {
        handleError?.(event)
        if (closed) return
        if (next.readyState === WebSocket.CONNECTING || next.readyState === WebSocket.OPEN) {
          try {
            next.close()
          } catch (closeError) {
            console.warn('エラーハンドリング中のWebSocketクローズに失敗しました', closeError)
          }
        }
      })
    }

    connect()

    return () => {
      closed = true
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (ws) {
        try {
          ws.close(1000, 'component unmounted')
        } catch (closeError) {
          console.warn('コンポーネントのアンマウント時にWebSocketクローズへ失敗しました', closeError)
        }
      }
      setSocket(null)
    }
  }, [sessionId, createSocket, ...reconnectDeps])

  return socket
}

type HeartbeatOptions = {
  intervalMs?: number
  staleThresholdMs?: number
  onTimeout?: () => void
  getLastMessageAt?: () => number
}

export const useHeartbeat = (socket: WebSocket | null, opts?: HeartbeatOptions) => {
  const {
    intervalMs = 5000,
    staleThresholdMs,
    onTimeout,
    getLastMessageAt,
  } = opts ?? {}

  useEffect(() => {
    if (!socket) return

    let cancelled = false
    const id = setInterval(() => {
      if (cancelled || socket.readyState !== WebSocket.OPEN) {
        return
      }
      if (typeof staleThresholdMs === 'number' && getLastMessageAt) {
        const last = getLastMessageAt()
        if (Date.now() - last > staleThresholdMs) {
          cancelled = true
          try {
            socket.close()
          } catch (closeError) {
            console.warn('ハートビートのタイムアウト処理でWebSocketクローズに失敗しました', closeError)
          }
          onTimeout?.()
          return
        }
      }
      try {
        socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
      } catch (sendError) {
        cancelled = true
        try {
          socket.close()
        } catch (closeError) {
          console.warn('ping送信後のWebSocketクローズに失敗しました', closeError)
        }
        console.warn('pingメッセージの送信に失敗しました', sendError)
        onTimeout?.()
      }
    }, intervalMs)

    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [socket, intervalMs, staleThresholdMs, onTimeout, getLastMessageAt])
}
