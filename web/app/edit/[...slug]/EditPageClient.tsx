'use client'
import '../../lib/ws-compat'
import Link from 'next/link'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  fetchSnapshot,
  setStoredPassword,
  getStoredPassword,
  updatePasswordOnServer,
  UnauthorizedError,
  type EditMsg,
  type WsInbound,
  type CursorState,
  type PresenceState,
  type CursorMsgOutbound,
  type CursorMsgInbound,
  type ImeEvent,
  type ImeMsgInbound,
  type PresenceSnapshotMsg,
  type PresenceDiffMsg,
  type AckMsg,
  type OpBroadcastMsg,
  type TextRange,
} from '../../lib/api'
import { PendingQueue, useHeartbeat, useRealtimeChannel, type PendingEdit } from '../../lib/realtime'
import { applyOps, diffToOps, type Op } from '../../lib/ot'
import { v4 as uuidv4 } from 'uuid'
import MarkdownRenderer from '../../components/MarkdownRenderer'

const STORAGE_PREFIX = process.env.NEXT_PUBLIC_STORAGE_PREFIX ?? 'coedit'
const DISPLAY_NAME_KEY = `${STORAGE_PREFIX}:displayName`
const DISPLAY_COLOR_KEY = `${STORAGE_PREFIX}:color`
const MODE_KEY = `${STORAGE_PREFIX}:mode`

type PresenceMap = Record<string, PresenceState>

const getStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch (error) {
    console.warn('localStorage へのアクセスに失敗しました', error)
    return null
  }
}

const safeGetItem = (key: string): string | null => {
  const storage = getStorage()
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch (error) {
    console.warn(`localStorage.getItem(${key}) に失敗しました`, error)
    return null
  }
}

const safeSetItem = (key: string, value: string) => {
  const storage = getStorage()
  if (!storage) return
  try {
    storage.setItem(key, value)
  } catch (error) {
    console.warn(`localStorage.setItem(${key}) に失敗しました`, error)
  }
}

function getInitialDisplayName(clientId: string): string {
  if (typeof window === 'undefined') return `ユーザー-${clientId.slice(0, 6)}`
  const stored = safeGetItem(DISPLAY_NAME_KEY)
  if (stored && stored.trim().length > 0) {
    return stored.trim().slice(0, 32)
  }
  const generated = `ユーザー-${clientId.slice(0, 6)}`
  safeSetItem(DISPLAY_NAME_KEY, generated)
  return generated
}

function deriveClientColor(clientId: string): string {
  let hash = 0
  for (let i = 0; i < clientId.length; i += 1) {
    hash = (hash * 31 + clientId.charCodeAt(i)) | 0
  }
  const hue = Math.abs(hash) % 360
  // convert HSL to RGB then to hex for easier manipulation
  const s = 0.65
  const l = 0.6
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) { r = c; g = x; b = 0 }
  else if (hue < 120) { r = x; g = c; b = 0 }
  else if (hue < 180) { r = 0; g = c; b = x }
  else if (hue < 240) { r = 0; g = x; b = c }
  else if (hue < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const toHex = (val: number) => {
    const n = Math.round((val + m) * 255)
    return n.toString(16).padStart(2, '0')
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function getStoredColor(clientId: string): string {
  const fallback = deriveClientColor(clientId)
  if (typeof window === 'undefined') return fallback
  const stored = safeGetItem(DISPLAY_COLOR_KEY)
  if (stored && /^#([0-9a-fA-F]{6})$/.test(stored.trim())) {
    return stored.trim()
  }
  safeSetItem(DISPLAY_COLOR_KEY, fallback)
  return fallback
}

function hexToRgba(hex: string, alpha: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!match) return `rgba(99, 102, 241, ${alpha})`
  const value = match[1]
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function fallbackLabel(clientId: string): string {
  return `ユーザー-${clientId.slice(0, 6)}`
}

function resolvePresenceColor(color: string | undefined, clientId: string): string {
  if (color && /^#([0-9a-fA-F]{6})$/.test(color)) {
    return color
  }
  return deriveClientColor(clientId)
}

function isOp(value: unknown): value is Op {
  if (!value || typeof value !== 'object') return false
  const op = value as Record<string, unknown>
  if (op.type === 'insert') {
    return typeof op.pos === 'number' && typeof op.text === 'string'
  }
  if (op.type === 'delete') {
    return typeof op.pos === 'number' && typeof op.len === 'number'
  }
  return false
}

function resolveLineInfo(starts: number[], length: number, pos: number) {
  const clamped = Math.max(0, Math.min(pos, length))
  let line = 0
  while (line + 1 < starts.length && starts[line + 1] <= clamped) {
    line += 1
  }
  const lineStart = starts[line] ?? 0
  const column = clamped - lineStart
  return { clamped, line, column }
}

function computeCursorState(textarea: HTMLTextAreaElement): CursorState {
  const start = textarea.selectionStart ?? 0
  const end = textarea.selectionEnd ?? start
  const direction = textarea.selectionDirection === 'backward'
    ? 'backward'
    : textarea.selectionDirection === 'forward'
      ? 'forward'
      : undefined
  const position = direction === 'backward' ? start : end
  const anchor =
    start === end
      ? undefined
      : direction === 'backward'
        ? end
        : start
  const cursor: CursorState = { position }
  if (anchor !== undefined) cursor.anchor = anchor
  if (direction) cursor.selection_direction = direction
  return cursor
}

function computeSelectionRange(textarea: HTMLTextAreaElement): TextRange {
  const start = textarea.selectionStart ?? 0
  const end = textarea.selectionEnd ?? start
  return { start, end }
}

function cursorsEqual(a: CursorState | null, b: CursorState | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.position === b.position &&
    (a.anchor ?? null) === (b.anchor ?? null) &&
    (a.selection_direction ?? null) === (b.selection_direction ?? null)
  )
}

function imeEventToSnapshot(event: ImeEvent): PresenceState['ime'] {
  switch (event.phase) {
    case 'start':
      return { phase: 'start', range: event.range }
    case 'update':
      return { phase: 'update', range: event.range, text: event.text }
    case 'commit':
      return { phase: 'commit', range: event.replace_range, text: event.text }
    case 'cancel':
      return { phase: 'cancel', range: event.range }
    default:
      return undefined
  }
}

export default function EditPageClient({ slugParts }: { slugParts: string[] }) {
  const decodedSlugParts = slugParts.map(part => decodeURIComponent(part))
  const slug = decodedSlugParts.join('/')
  const encodedSlugPath = slugParts.map(part => encodeURIComponent(part)).join('/')
  const clientId = useMemo(() => uuidv4(), [])
  const searchParams = useSearchParams()
  const queryPassword = useMemo(() => {
    const value = searchParams?.get('password') ?? ''
    return value.trim().length > 0 ? value : null
  }, [searchParams])
  const [content, setContent] = useState<string>('')
  const [rev, setRev] = useState<number>(0)
  const wsRef = useRef<WebSocket | null>(null)
  const contentRef = useRef<string>('')
  const revRef = useRef<number>(0)
  const lastMsgAtRef = useRef<number>(Date.now())
  const storageKeyQueue = `${STORAGE_PREFIX}:queue:${slug}:${clientId}`
  const storageKeyText = `${STORAGE_PREFIX}:text:${slug}:${clientId}`
  const [mode, setMode] = useState<'edit'|'preview'|'both'>('both')
  const [authState, setAuthState] = useState<'unknown'|'authorized'|'needPassword'>('unknown')
  const [authNonce, setAuthNonce] = useState(0)
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [activePassword, setActivePassword] = useState<string>(() => getStoredPassword(slug) ?? '')
  const [newPasswordInput, setNewPasswordInput] = useState('')
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null)
  const [updatingPassword, setUpdatingPassword] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle'|'copied'|'error'>('idle')
  const copyStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [presence, setPresence] = useState<PresenceMap>({})
  const presenceRef = useRef<PresenceMap>({})
  const updatePresence = useCallback((updater: (prev: PresenceMap) => PresenceMap) => {
    setPresence(prev => {
      const next = updater(prev)
      presenceRef.current = next
      return next
    })
  }, [])
  const replacePresence = useCallback((next: PresenceMap) => {
    presenceRef.current = next
    setPresence(next)
  }, [])
  const queueRef = useRef(new PendingQueue())
  const savedTextRef = useRef<string | null>(null)
  const persistQueue = useCallback(() => {
    safeSetItem(storageKeyQueue, JSON.stringify(queueRef.current))
  }, [storageKeyQueue])
  useEffect(() => {
    setAuthState('unknown')
    setAuthNonce(n => n + 1)
    setActivePassword(getStoredPassword(slug) ?? '')
    setLoginPassword(queryPassword ?? '')
    setLoginError(null)
  }, [slug, queryPassword])
  useEffect(() => {
    replacePresence({})
  }, [slug, replacePresence])
  useEffect(() => {
    const saved = safeGetItem(MODE_KEY)
    if (saved === 'edit' || saved === 'preview' || saved === 'both') {
      setMode(saved)
    }
  }, [])
  useEffect(() => { contentRef.current = content }, [content])
  useEffect(() => { revRef.current = rev }, [rev])
  useEffect(() => {
    return () => {
      if (copyStatusTimer.current) {
        clearTimeout(copyStatusTimer.current)
        copyStatusTimer.current = null
      }
    }
  }, [])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const lastCursorStateRef = useRef<CursorState | null>(null)
  const cursorThrottleRef = useRef<number | null>(null)
  const pendingCursorRef = useRef<CursorState | null>(null)
  const compositionRangeRef = useRef<TextRange | null>(null)
  const wsReadyRef = useRef(false)
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
    const scrollY = typeof window !== 'undefined' ? window.scrollY : 0
    const scrollX = typeof window !== 'undefined' ? window.scrollX : 0
    if (typeof window !== 'undefined') {
      window.scrollTo(scrollX, scrollY)
    }
  }, [])
  const [displayName, setDisplayName] = useState(() => getInitialDisplayName(clientId))
  const [displayColor, setDisplayColor] = useState(() => getStoredColor(clientId))
  const displayNameRef = useRef(displayName)
  const displayColorRef = useRef(displayColor)
  const [profileNameInput, setProfileNameInput] = useState(displayName)
  const [profileColorInput, setProfileColorInput] = useState(displayColor)
  const [cursorRenderTick, setCursorRenderTick] = useState(0)

  const updateModeSetting = useCallback((nextMode: 'edit'|'preview'|'both') => {
    setMode(nextMode)
    safeSetItem(MODE_KEY, nextMode)
  }, [])

  const sendProfileUpdate = useCallback(() => {
    const labelValue = displayNameRef.current
    const colorValue = displayColorRef.current
    updatePresence(prev => {
      const next = { ...prev }
      const existing = next[clientId] ?? { client_id: clientId }
      next[clientId] = {
        ...existing,
        label: labelValue,
        color: colorValue,
        last_seen: Date.now(),
        cursor: existing.cursor,
        ime: existing.ime,
      }
      return next
    })
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !wsReadyRef.current) return
    const payload = {
      type: 'profile',
      slug,
      label: labelValue,
      color: colorValue,
    }
    try { ws.send(JSON.stringify(payload)) } catch (err) { console.error(err) }
  }, [slug, clientId, updatePresence])

  useEffect(() => {
    displayNameRef.current = displayName
    safeSetItem(DISPLAY_NAME_KEY, displayNameRef.current)
  }, [displayName])
  useEffect(() => {
    displayColorRef.current = displayColor
    safeSetItem(DISPLAY_COLOR_KEY, displayColorRef.current)
  }, [displayColor])
  useEffect(() => { setProfileNameInput(displayName) }, [displayName])
  useEffect(() => { setProfileColorInput(displayColor) }, [displayColor])
  useEffect(() => {
    if (!wsReadyRef.current) return
    sendProfileUpdate()
  }, [sendProfileUpdate, displayName, displayColor])

  useEffect(() => {
    adjustTextareaHeight()
  }, [content, adjustTextareaHeight])

  const sendCursorMessage = useCallback((cursor: CursorState) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const payload: CursorMsgOutbound = {
      type: 'cursor',
      slug,
      cursor,
      op_id: uuidv4(),
      ts: Date.now(),
    }
    try { ws.send(JSON.stringify(payload)) } catch (err) { console.error(err) }
    updatePresence(prev => {
      const next = { ...prev }
      const existing = next[clientId] ?? { client_id: clientId }
      next[clientId] = {
        ...existing,
        label: displayNameRef.current,
        color: existing.color ?? displayColorRef.current,
        cursor,
        last_seen: Date.now(),
      }
      return next
    })
  }, [slug, clientId, updatePresence])

  const sendImeMessage = useCallback((ime: ImeEvent) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const payload = {
      type: 'ime',
      slug,
      ime,
      op_id: uuidv4(),
      ts: Date.now(),
    }
    try { ws.send(JSON.stringify(payload)) } catch (err) { console.error(err) }
    const imeSnapshot = imeEventToSnapshot(ime)
    if (!imeSnapshot) return
    updatePresence(prev => {
      const next = { ...prev }
      const existing = next[clientId] ?? { client_id: clientId }
      next[clientId] = {
        ...existing,
        label: displayNameRef.current,
        color: existing.color ?? displayColorRef.current,
        ime: imeSnapshot,
        last_seen: Date.now(),
      }
      return next
    })
  }, [slug, clientId, updatePresence])

  const publishCursorImmediate = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const cursor = computeCursorState(textarea)
    lastCursorStateRef.current = cursor
    sendCursorMessage(cursor)
  }, [sendCursorMessage])

  const handleCopyViewLink = useCallback(async () => {
    if (typeof window === 'undefined') return
    const path = encodedSlugPath.length > 0 ? `/view/${encodedSlugPath}` : '/view'
    const urlObj = new URL(path, window.location.origin)
    const trimmedPassword = activePassword.trim()
    if (trimmedPassword.length > 0) {
      urlObj.searchParams.set('password', trimmedPassword)
    }
    const url = urlObj.toString()
    if (copyStatusTimer.current) {
      clearTimeout(copyStatusTimer.current)
      copyStatusTimer.current = null
    }

    const fallbackCopy = () => {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = url
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const succeeded = document.execCommand('copy')
        document.body.removeChild(textarea)
        if (succeeded) {
          setCopyStatus('copied')
        } else {
          setCopyStatus('error')
          window.prompt('リンクをコピーできませんでした。以下のURLをコピーしてください。', url)
        }
      } catch (error) {
        console.warn('フォールバックでのリンクコピーに失敗しました', error)
        setCopyStatus('error')
        window.prompt('リンクをコピーできませんでした。以下のURLをコピーしてください。', url)
      }
    }

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url)
        setCopyStatus('copied')
      } else {
        fallbackCopy()
      }
    } catch (error) {
      console.warn('クリップボードへのコピーに失敗しました', error)
      fallbackCopy()
    }

    copyStatusTimer.current = setTimeout(() => {
      setCopyStatus('idle')
      copyStatusTimer.current = null
    }, 2500)
  }, [encodedSlugPath, activePassword])

  const socket = useRealtimeChannel(authState === 'authorized' ? slug : null, {
    reconnectDeps: [authNonce, activePassword],
  })

  useEffect(() => {
    wsRef.current = socket
  }, [socket])

  const getLastMessageAt = useCallback(() => lastMsgAtRef.current, [])

  useHeartbeat(socket, {
    getLastMessageAt,
    staleThresholdMs: 30000,
    onTimeout: () => {
      wsReadyRef.current = false
    },
  })

  useEffect(() => {
    if (typeof window === 'undefined') {
      savedTextRef.current = null
      queueRef.current.replace()
      return
    }
    const raw = safeGetItem(storageKeyQueue)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown
        const normalize = (item: unknown): PendingEdit | null => {
          if (!item || typeof item !== 'object' || item === null) return null
          const value = item as Record<string, unknown>
          if (typeof value.op_id !== 'string' || typeof value.base_rev !== 'number') return null
          const opCandidates = value.ops
          if (!Array.isArray(opCandidates)) return null
          const ops = opCandidates.filter(isOp)
          if (ops.length !== opCandidates.length) return null
          const normalized: PendingEdit = {
            op_id: value.op_id,
            base_rev: value.base_rev,
            ops,
          }
          if (value.cursor_before) normalized.cursor_before = value.cursor_before as CursorState
          if (value.cursor_after) normalized.cursor_after = value.cursor_after as CursorState
          if (typeof value.ts === 'number') normalized.ts = value.ts
          return normalized
        }
        if (Array.isArray(parsed)) {
          const items = (parsed as unknown[]).reduce<PendingEdit[]>((acc, entry) => {
            const normalized = normalize(entry)
            if (normalized) acc.push(normalized)
            return acc
          }, [])
          queueRef.current.replace({ items, latestAck: 0 })
        } else if (parsed && typeof parsed === 'object') {
          const record = parsed as { items?: unknown; latestAck?: unknown }
          const sourceItems = Array.isArray(record.items) ? record.items : []
          const items = sourceItems.reduce<PendingEdit[]>((acc, entry) => {
            const normalized = normalize(entry)
            if (normalized) acc.push(normalized)
            return acc
          }, [])
          const latestAck = typeof record.latestAck === 'number' ? record.latestAck : 0
          queueRef.current.replace({ items, latestAck })
        } else {
          queueRef.current.replace()
        }
      } catch (error) {
        console.warn('ローカルキューの復元に失敗しました', error)
        queueRef.current.replace()
      }
    } else {
      queueRef.current.replace()
    }
    const saved = safeGetItem(storageKeyText)
    savedTextRef.current = saved
    if (saved != null) {
      setContent(saved)
    }
  }, [storageKeyQueue, storageKeyText])

  const handleAuthError = useCallback((err: unknown) => {
    if (err instanceof UnauthorizedError) {
      setAuthState('needPassword')
      const ws = wsRef.current
      if (ws) {
        try { ws.close() } catch (closeError) {
          console.warn('WebSocketのクローズに失敗しました', closeError)
        }
      }
    } else if (err) {
      console.error(err)
    }
  }, [])

  const resendQueue = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    queueRef.current.flush(edit => {
      const msg: EditMsg = {
        type: 'edit',
        slug,
        edit: {
          base_rev: edit.base_rev,
          ops: edit.ops,
          client_id: clientId,
          op_id: edit.op_id,
          cursor_before: edit.cursor_before,
          cursor_after: edit.cursor_after,
          ts: edit.ts,
        },
      }
      try { ws.send(JSON.stringify(msg)) } catch (err) { console.error(err) }
    })
  }, [slug, clientId])

  const reconcileWithServer = useCallback(async () => {
    if (!queueRef.current.isEmpty()) return
    try {
      const snap = await fetchSnapshot(slug)
      revRef.current = snap.rev
      queueRef.current.setLatestServerSeq(snap.rev)
      setRev(snap.rev)
      if (snap.content !== contentRef.current) {
        const ops = diffToOps(snap.content, contentRef.current)
        if (ops.length > 0) {
          const op_id = uuidv4()
          const nowTs = Date.now()
          const pending: PendingEdit = {
            op_id,
            base_rev: snap.rev,
            ops,
            ts: nowTs,
          }
          queueRef.current.enqueue(pending)
          persistQueue()
          const ws = wsRef.current
          const msg: EditMsg = {
            type: 'edit',
            slug,
            edit: {
              base_rev: pending.base_rev,
              ops: pending.ops,
              client_id: clientId,
              op_id,
              ts: nowTs,
            },
          }
          try { ws?.send(JSON.stringify(msg)) } catch (err) { console.error(err) }
        }
      }
    } catch (err) {
      handleAuthError(err)
    }
  }, [slug, clientId, persistQueue, handleAuthError])

  useEffect(() => {
    let cancelled = false
    const directPassword = queryPassword ?? undefined

    const load = async () => {
      try {
        const snap = await fetchSnapshot(slug, directPassword ? { password: directPassword } : undefined)
        if (cancelled) return
        revRef.current = snap.rev
        queueRef.current.setLatestServerSeq(snap.rev)
        setRev(snap.rev)
        if (savedTextRef.current == null) {
          setContent(snap.content)
        }
        setAuthState('authorized')
        if (directPassword) {
          setStoredPassword(slug, directPassword)
          setActivePassword(directPassword)
          setLoginPassword('')
        }
      } catch (err) {
        if (cancelled) return
        handleAuthError(err)
        if (queryPassword && err instanceof UnauthorizedError) {
          setLoginError('パスワードが違います')
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [slug, authNonce, queryPassword, handleAuthError])

  useEffect(() => {
    if (!socket) return
    wsReadyRef.current = false

    const handleOpen = () => {
      lastMsgAtRef.current = Date.now()
      const joinPayload = {
        type: 'join',
        sessionId: slug,
        clientId,
        label: displayNameRef.current,
        color: displayColorRef.current,
        password: activePassword || undefined,
      }
      try { socket.send(JSON.stringify(joinPayload)) } catch (err) { console.error(err) }
      queueRef.current.setLatestServerSeq(revRef.current)
      resendQueue()
      if (queueRef.current.isEmpty()) {
        reconcileWithServer().catch(() => {})
      }
      wsReadyRef.current = true
      sendProfileUpdate()
      publishCursorImmediate()
    }

    const handleCoeditMsg = (event: Event) => {
      const messageEvent = event as MessageEvent<WsInbound | Record<string, unknown>>
      const data = messageEvent.data
      if (!data || typeof data !== 'object') return
      const base = data as Record<string, unknown>
      const typeValue = base.type
      if (typeof typeValue !== 'string') return
      lastMsgAtRef.current = Date.now()
      switch (typeValue) {
        case 'cursor': {
          const msg = data as CursorMsgInbound
          if (msg.slug !== slug) break
          updatePresence(prev => {
            const next = { ...prev }
            const existing = next[msg.client_id] ?? { client_id: msg.client_id }
            next[msg.client_id] = {
              ...existing,
              cursor: msg.cursor,
              last_seen: Date.now(),
            }
            return next
          })
          break
        }
        case 'ime': {
          const msg = data as ImeMsgInbound
          if (msg.slug !== slug) break
          updatePresence(prev => {
            const next = { ...prev }
            const existing = next[msg.client_id] ?? { client_id: msg.client_id }
            next[msg.client_id] = {
              ...existing,
              ime: imeEventToSnapshot(msg.ime),
              last_seen: Date.now(),
            }
            return next
          })
          break
        }
        case 'presence_snapshot': {
          const snapshot = data as PresenceSnapshotMsg
          if (snapshot.slug !== slug) break
          const map: PresenceMap = {}
          for (const p of snapshot.clients) {
            map[p.client_id] = p
          }
          replacePresence(map)
          updatePresence(prev => {
            const next = { ...prev }
            const existing = next[clientId] ?? { client_id: clientId }
            next[clientId] = {
              ...existing,
              label: displayNameRef.current,
              color: displayColorRef.current,
              last_seen: Date.now(),
              cursor: existing.cursor,
              ime: existing.ime,
            }
            return next
          })
          break
        }
        case 'presence_diff': {
          const diff = data as PresenceDiffMsg
          if (diff.slug !== slug) break
          updatePresence(prev => {
            const next = { ...prev }
            for (const added of diff.added) {
              next[added.client_id] = added
            }
            for (const updatedState of diff.updated) {
              const existing = next[updatedState.client_id] ?? { client_id: updatedState.client_id }
              next[updatedState.client_id] = { ...existing, ...updatedState }
            }
            for (const removed of diff.removed) {
              delete next[removed]
            }
            return next
          })
          break
        }
        default:
          break
      }
    }

    const handleMessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') {
        console.warn('想定外のWebSocketメッセージ形式を受信しました', ev.data)
        return
      }
      try {
        const parsed = JSON.parse(ev.data) as unknown
        if (!parsed || typeof parsed !== 'object') return
        const msg = parsed as WsInbound
        lastMsgAtRef.current = Date.now()
        switch (msg.type) {
          case 'snapshot': {
            const payload = msg.payload
            if (payload.slug !== slug) break
            contentRef.current = payload.content
            setContent(payload.content)
            setRev(payload.rev)
            revRef.current = payload.rev
            queueRef.current.setLatestServerSeq(payload.rev)
            break
          }
          case 'op_broadcast': {
            const payload = msg.payload as OpBroadcastMsg['payload']
            setContent(prev => {
              const next = applyOps(prev, [payload.operation])
              contentRef.current = next
              return next
            })
            setRev(payload.context.serverSeq)
            revRef.current = payload.context.serverSeq
            queueRef.current.setLatestServerSeq(payload.context.serverSeq)
            break
          }
          case 'ack': {
            const { opId, serverSeq } = msg as AckMsg
            queueRef.current.ack({ opId, serverSeq })
            persistQueue()
            if (typeof serverSeq === 'number') {
              setRev(serverSeq)
              revRef.current = serverSeq
            }
            if (queueRef.current.isEmpty()) {
              reconcileWithServer().catch(() => {})
            }
            break
          }
          default:
            break
        }
      } catch (error) {
        console.error('WebSocketメッセージの処理に失敗しました', error)
      }
    }

    const handleClose = () => {
      wsReadyRef.current = false
    }

    const handleError = () => {
      try { socket.close() }
      catch (closeError) {
        console.warn('WebSocketのエラー処理中にcloseへ失敗しました', closeError)
      }
    }

    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose)
    socket.addEventListener('error', handleError)
    socket.addEventListener('coedit:server-msg', handleCoeditMsg as EventListener)

    return () => {
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      socket.removeEventListener('error', handleError)
      socket.removeEventListener('coedit:server-msg', handleCoeditMsg as EventListener)
      if (wsRef.current === socket) {
        wsRef.current = null
      }
    }
  }, [
    socket,
    slug,
    clientId,
    activePassword,
    resendQueue,
    reconcileWithServer,
    sendProfileUpdate,
    publishCursorImmediate,
    updatePresence,
    replacePresence,
    persistQueue,
  ])

  useEffect(() => {
    if (authState !== 'authorized') return
    const id = setInterval(() => {
      reconcileWithServer().catch(() => {})
    }, 10000)
    return () => {
      clearInterval(id)
    }
  }, [authState, reconcileWithServer])

  const handleLoginSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoginError(null)
    try {
      const snap = await fetchSnapshot(slug, { password: loginPassword })
      setStoredPassword(slug, loginPassword)
      setActivePassword(loginPassword)
      setContent(snap.content)
      setRev(snap.rev)
      revRef.current = snap.rev
      queueRef.current.setLatestServerSeq(snap.rev)
      setAuthState('authorized')
      setAuthNonce(n => n + 1)
      setLoginPassword('')
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setLoginError('パスワードが違います')
      } else {
        console.error(err)
        setLoginError('認証中にエラーが発生しました')
      }
    }
  }

  const handlePasswordUpdate = async () => {
    if (updatingPassword) return
    const nextPassword = newPasswordInput
    if (nextPassword === activePassword) {
      setPasswordStatus('変更はありません')
      return
    }
    setPasswordStatus(null)
    setUpdatingPassword(true)
    try {
      await updatePasswordOnServer(slug, nextPassword, activePassword || undefined)
      if (nextPassword) {
        setStoredPassword(slug, nextPassword)
        setActivePassword(nextPassword)
        setPasswordStatus('パスワードを更新しました')
      } else {
        setStoredPassword(slug, null)
        setActivePassword('')
        setPasswordStatus('パスワードを削除しました')
      }
      setNewPasswordInput('')
      setAuthState('unknown')
      setAuthNonce(n => n + 1)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setPasswordStatus('現在のパスワードが正しくありません')
        setAuthState('needPassword')
      } else {
        console.error(err)
        setPasswordStatus('更新に失敗しました')
      }
    } finally {
      setUpdatingPassword(false)
    }
  }

  const handleProfileNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setProfileNameInput(event.target.value)
  }, [])

  const handleProfileColorChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setProfileColorInput(event.target.value)
  }, [])

  const handleProfileSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = profileNameInput.trim().slice(0, 32)
    const finalName = trimmed.length > 0 ? trimmed : fallbackLabel(clientId)
    displayNameRef.current = finalName
    displayColorRef.current = profileColorInput
    setDisplayName(finalName)
    setDisplayColor(profileColorInput)
    updatePresence(prev => {
      const next = { ...prev }
      const existing = next[clientId] ?? { client_id: clientId }
      next[clientId] = {
        ...existing,
        label: finalName,
        color: profileColorInput,
        last_seen: Date.now(),
        cursor: existing.cursor,
        ime: existing.ime,
      }
      return next
    })
    sendProfileUpdate()
  }, [profileNameInput, profileColorInput, clientId, updatePresence, sendProfileUpdate])

  const onChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = e.target
    const next = textarea.value
    const ops = diffToOps(content, next)
    setContent(next)
    safeSetItem(storageKeyText, next)
    const cursorAfter = computeCursorState(textarea)
    const cursorBefore = lastCursorStateRef.current
    lastCursorStateRef.current = cursorAfter
    if (ops.length === 0) return
    const op_id = uuidv4()
    const base_rev = queueRef.current.latestServerSeq()
    const ts = Date.now()
    const pending: PendingEdit = {
      op_id,
      base_rev,
      ops,
      cursor_before: cursorBefore ?? undefined,
      cursor_after: cursorAfter,
      ts,
    }
    queueRef.current.enqueue(pending)
    persistQueue()
    const msg: EditMsg = {
      type: 'edit',
      slug,
      edit: {
        base_rev,
        ops,
        client_id: clientId,
        op_id,
        cursor_before: cursorBefore ?? undefined,
        cursor_after: cursorAfter,
        ts,
      },
    }
    try { wsRef.current?.send(JSON.stringify(msg)) } catch (err) {
      console.error(err)
    }
  }, [slug, clientId, content, storageKeyText])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const handleSelectionChange = () => {
      const el = textareaRef.current
      if (!el || document.activeElement !== el) return
      const cursor = computeCursorState(el)
      if (cursorsEqual(lastCursorStateRef.current, cursor)) return
      lastCursorStateRef.current = cursor
      pendingCursorRef.current = cursor
      if (cursorThrottleRef.current != null) return
      cursorThrottleRef.current = window.setTimeout(() => {
        cursorThrottleRef.current = null
        const pending = pendingCursorRef.current
        if (!pending) return
        pendingCursorRef.current = null
        sendCursorMessage(pending)
      }, 60)
    }
    const handleCompositionStart = (event: CompositionEvent) => {
      if (event.target !== textareaRef.current) return
      const el = textareaRef.current
      if (!el) return
      const range = computeSelectionRange(el)
      compositionRangeRef.current = range
      sendImeMessage({ phase: 'start', range })
    }
    const handleCompositionUpdate = (event: CompositionEvent) => {
      if (event.target !== textareaRef.current) return
      const el = textareaRef.current
      if (!el) return
      const range = computeSelectionRange(el)
      compositionRangeRef.current = range
      sendImeMessage({ phase: 'update', range, text: event.data ?? '' })
    }
    const handleCompositionEnd = (event: CompositionEvent) => {
      if (event.target !== textareaRef.current) return
      const range = compositionRangeRef.current ?? computeSelectionRange(textareaRef.current as HTMLTextAreaElement)
      compositionRangeRef.current = null
      sendImeMessage({ phase: 'commit', replace_range: range, text: event.data ?? '' })
    }
    const handleCompositionCancel = (event: Event) => {
      if (event.target !== textareaRef.current) return
      const range = compositionRangeRef.current ?? computeSelectionRange(textareaRef.current as HTMLTextAreaElement)
      compositionRangeRef.current = null
      sendImeMessage({ phase: 'cancel', range })
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    textarea.addEventListener('compositionstart', handleCompositionStart)
    textarea.addEventListener('compositionupdate', handleCompositionUpdate)
    textarea.addEventListener('compositionend', handleCompositionEnd)
    textarea.addEventListener('compositioncancel', handleCompositionCancel)
    handleSelectionChange()
    const handleScroll = () => setCursorRenderTick(t => t + 1)
    const handleResize = () => {
      setCursorRenderTick(t => t + 1)
      adjustTextareaHeight()
    }
    textarea.addEventListener('scroll', handleScroll)
    window.addEventListener('resize', handleResize)
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
      textarea.removeEventListener('compositionstart', handleCompositionStart)
      textarea.removeEventListener('compositionupdate', handleCompositionUpdate)
      textarea.removeEventListener('compositionend', handleCompositionEnd)
      textarea.removeEventListener('compositioncancel', handleCompositionCancel)
      textarea.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleResize)
      if (cursorThrottleRef.current != null) {
        window.clearTimeout(cursorThrottleRef.current)
        cursorThrottleRef.current = null
      }
    }
  }, [sendCursorMessage, sendImeMessage, adjustTextareaHeight])

 
  const remotePresenceList = useMemo(
    () => Object.values(presence).filter(p => p.client_id !== clientId),
    [presence, clientId],
  )
  const lineMetadata = useMemo(() => {
    const starts = [0]
    let length = 0
    for (const ch of content) {
      length += 1
      if (ch === '\n') starts.push(length)
    }
    return { starts, length }
  }, [content])
  const remoteCursorItems = useMemo(() => {
    const textarea = textareaRef.current
    if (!textarea || typeof window === 'undefined') return []
    const style = window.getComputedStyle(textarea)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.font = style.font || `${style.fontSize} ${style.fontFamily}`
    }
    const measure = ctx?.measureText('M')
    const charWidth = measure?.width || parseFloat(style.fontSize) || 16
    let lineHeight = parseFloat(style.lineHeight)
    if (!lineHeight || Number.isNaN(lineHeight)) {
      const ascent = measure?.actualBoundingBoxAscent ?? 0
      const descent = measure?.actualBoundingBoxDescent ?? 0
      lineHeight = ascent + descent > 0 ? (ascent + descent) * 1.1 : (parseFloat(style.fontSize) || 16) * 1.4
    }
    const paddingTop = parseFloat(style.paddingTop) || 0
    const paddingLeft = parseFloat(style.paddingLeft) || 0
    const borderTop = parseFloat(style.borderTopWidth) || 0
    const borderLeft = parseFloat(style.borderLeftWidth) || 0
    const baseTop = textarea.offsetTop + borderTop + paddingTop - textarea.scrollTop
    const baseLeft = textarea.offsetLeft + borderLeft + paddingLeft - textarea.scrollLeft
    const starts = lineMetadata.starts
    const totalLength = lineMetadata.length

    return remotePresenceList
      .map(p => {
        const cursor = p.cursor
        if (!cursor) return null
        const color = resolvePresenceColor(p.color, p.client_id)
        const caretInfo = resolveLineInfo(starts, totalLength, cursor.position)
        const caretTop = baseTop + caretInfo.line * lineHeight
        const caretLeft = baseLeft + caretInfo.column * charWidth
        const selectionRects: Array<{ top: number; left: number; width: number; height: number }> = []
        if (cursor.anchor !== undefined && cursor.anchor !== cursor.position) {
          const start = Math.min(cursor.anchor, cursor.position)
          const end = Math.max(cursor.anchor, cursor.position)
          let current = start
          while (current < end) {
            const startInfo = resolveLineInfo(starts, totalLength, current)
            const nextLineStart = startInfo.line + 1 < starts.length ? starts[startInfo.line + 1] : totalLength
            const segmentEnd = Math.min(end, nextLineStart)
            const endInfo = resolveLineInfo(starts, totalLength, segmentEnd)
            const top = baseTop + startInfo.line * lineHeight
            const left = baseLeft + startInfo.column * charWidth
            const width = Math.max(2, (endInfo.column - startInfo.column) * charWidth)
            selectionRects.push({ top, left, width, height: lineHeight })
            current = segmentEnd > current ? segmentEnd : current + 1
          }
        }
        return {
          clientId: p.client_id,
          label: p.label ?? fallbackLabel(p.client_id),
          color,
          caret: { top: caretTop, left: caretLeft, height: lineHeight },
          selections: selectionRects,
        }
      })
      .filter((item): item is {
        clientId: string
        label: string
        color: string
        caret: { top: number; left: number; height: number }
        selections: Array<{ top: number; left: number; width: number; height: number }>
      } => item !== null)
  }, [remotePresenceList, lineMetadata, cursorRenderTick])
  const describeCursor = (cursor?: CursorState): string => {
    if (!cursor) return 'カーソル位置未取得'
    if (cursor.anchor !== undefined && cursor.anchor !== cursor.position) {
      const start = Math.min(cursor.anchor, cursor.position)
      const end = Math.max(cursor.anchor, cursor.position)
      return `選択 ${start}-${end}`
    }
    return `位置 ${cursor.position}`
  }

  const Editor = (
    <div className="editor-panel">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={onChange}
        className="editor-textarea"
        placeholder="Markdown を記述してください..."
      />
      <div className="presence-overlay">
        {remoteCursorItems.map(item => (
          <Fragment key={item.clientId}>
            {item.selections.map((rect, idx) => (
              <div
                key={`selection-${item.clientId}-${idx}`}
                style={{
                  position: 'absolute',
                  top: rect.top,
                  left: rect.left,
                  width: rect.width,
                  height: rect.height,
                  backgroundColor: hexToRgba(item.color, 0.2),
                  borderRadius: 2,
                }}
              />
            ))}
            <div
              style={{
                position: 'absolute',
                top: item.caret.top,
                left: item.caret.left,
                width: 2,
                height: item.caret.height,
                backgroundColor: item.color,
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: Math.max(4, item.caret.top - 22),
                left: Math.max(4, item.caret.left + 4),
                background: item.color,
                color: '#fff',
                borderRadius: 4,
                padding: '2px 6px',
                fontSize: 12,
                lineHeight: 1.2,
                whiteSpace: 'nowrap',
                boxShadow: '0 2px 6px rgba(15, 23, 42, 0.2)',
              }}
            >
              {item.label}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  )

  const Preview = (
    <div className="editor-panel editor-panel--preview">
      <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
        <MarkdownRenderer content={content} />
      </div>
    </div>
  )

  const isPasswordStatusError = passwordStatus ? /失敗|正しくありません/.test(passwordStatus) : false
  const copyStatusMessage =
    copyStatus === 'copied'
      ? '閲覧ページへのリンクをコピーしました'
      : copyStatus === 'error'
        ? 'リンクをコピーできませんでした'
        : null

  if (authState !== 'authorized') {
    return (
      <main>
        <section className="page-section">
          <div className="section-header">
            <div>
              <div className="section-title-row">
                <h1 className="section-title">編集ページ</h1>
                <span className="section-slug">/{slug || '未指定'}</span>
              </div>
            </div>
            <div className="view-controls">
              <Link href={encodedSlugPath.length > 0 ? `/view/${encodedSlugPath}` : '/view'} className="button button-secondary">
                閲覧ページを見る
              </Link>
            </div>
          </div>
          {authState === 'unknown' ? (
            <p className="status-message">認証確認中...</p>
          ) : (
            <form onSubmit={handleLoginSubmit} className="password-form">
              <div className="input-field">
                <label htmlFor="edit-password">編集パスワード</label>
                <input
                  id="edit-password"
                  type="password"
                  className="input-text"
                  value={loginPassword}
                  onChange={e => setLoginPassword(e.target.value)}
                  autoFocus
                  placeholder="このドキュメントの編集パスワード"
                />
              </div>
              <button type="submit" className="button button-primary" disabled={loginPassword.length === 0}>
                認証する
              </button>
            </form>
          )}
          {loginError && <p className="status-message error">{loginError}</p>}
          <p className="form-note">パスワードはチームメンバーと共有されます。不要になったら後から削除できます。</p>
        </section>
      </main>
    )
  }

  return (
    <main>
      <section className="page-section">
        <div className="section-header">
          <div>
            <div className="section-title-row">
              <h1 className="section-title">編集ページ</h1>
              <span className="section-slug">/{slug || '未指定'}</span>
            </div>
          </div>
          <div className="view-controls">
            <button type="button" className="button button-ghost" onClick={handleCopyViewLink}>
              閲覧リンクをコピー
            </button>
            <Link href={encodedSlugPath.length > 0 ? `/view/${encodedSlugPath}` : '/view'} className="button button-secondary">
              閲覧ページを開く
            </Link>
          </div>
        </div>
        <div className="editor-toolbar">
          <span className="rev">rev. {rev}</span>
          <form
            className="editor-toolbar__password"
            onSubmit={event => {
              event.preventDefault()
              handlePasswordUpdate()
            }}
          >
            <input
              type="password"
              className="input-text"
              value={newPasswordInput}
              onChange={e => setNewPasswordInput(e.target.value)}
              placeholder="新しいパスワード（空で削除）"
            />
            <button type="submit" className="button button-primary" disabled={updatingPassword}>
              {updatingPassword ? '更新中...' : '更新'}
            </button>
          </form>
          <div className="toolbar-spacer" />
          <div className="editor-mode-switch">
            <button
              type="button"
              className={mode === 'edit' ? 'active' : ''}
              onClick={() => updateModeSetting('edit')}
            >
              Editor
            </button>
            <button
              type="button"
              className={mode === 'both' ? 'active' : ''}
              onClick={() => updateModeSetting('both')}
            >
              Both
            </button>
            <button
              type="button"
              className={mode === 'preview' ? 'active' : ''}
              onClick={() => updateModeSetting('preview')}
            >
              Preview
            </button>
          </div>
        </div>
        {(passwordStatus || copyStatusMessage) && (
          <div className="status-stack">
            {passwordStatus && (
              <span className={`status-message ${isPasswordStatusError ? 'error' : 'success'}`}>
                {passwordStatus}
              </span>
            )}
            {copyStatusMessage && (
              <span className={`status-message ${copyStatus === 'error' ? 'error' : 'success'}`}>
                {copyStatusMessage}
              </span>
            )}
          </div>
        )}
        <form onSubmit={handleProfileSubmit} className="profile-form">
          <div className="input-field">
            <label htmlFor="profile-name">表示名</label>
            <input
              id="profile-name"
              type="text"
              className="input-text"
              value={profileNameInput}
              onChange={handleProfileNameChange}
              placeholder="例: デザインチームA"
            />
          </div>
          <div className="input-field">
            <label htmlFor="profile-color">カーソルカラー</label>
            <input
              id="profile-color"
              type="color"
              className="color-input"
              value={profileColorInput}
              onChange={handleProfileColorChange}
            />
          </div>
          <button type="submit" className="button button-primary">
            表示設定を保存
          </button>
        </form>
        <div className="editor-workspace">
          {(mode === 'both' || mode === 'edit') && <div style={{ minWidth: 0, minHeight: 0, height: '100%' }}>{Editor}</div>}
          {(mode === 'both' || mode === 'preview') && <div style={{ minWidth: 0, minHeight: 0, height: '100%' }}>{Preview}</div>}
        </div>
        {remotePresenceList.length > 0 && (
          <div className="presence-sidebar">
            {remotePresenceList.map(p => {
              const display = p.label && p.label.trim().length > 0 ? p.label : fallbackLabel(p.client_id)
              const color = resolvePresenceColor(p.color, p.client_id)
              return (
                <div key={p.client_id} className="presence-card" style={{ borderLeftColor: color }}>
                  <span className="name">{display}</span>
                  <span className="meta">{describeCursor(p.cursor)}</span>
                </div>
              )
            })}
          </div>
        )}
        <p className="form-note">IME の変換中やカーソル位置も共有されます。共同編集者の動きに追従できます。</p>
      </section>
    </main>
  )
}
