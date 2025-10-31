'use client'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { fetchSnapshot, setStoredPassword, UnauthorizedError } from '../../lib/api'
import MarkdownRenderer from '../../components/MarkdownRenderer'

export default function ViewPageClient({ slugParts }: { slugParts: string[] }) {
  const decodedSlugParts = slugParts.map(part => decodeURIComponent(part))
  const slug = decodedSlugParts.join('/')
  const encodedSlugPath = slugParts.map(part => encodeURIComponent(part)).join('/')
  const searchParams = useSearchParams()
  const queryPassword = useMemo(() => {
    const value = searchParams?.get('password') ?? ''
    return value.trim().length > 0 ? value : null
  }, [searchParams])
  const [content, setContent] = useState<string>('')
  const [authState, setAuthState] = useState<'unknown'|'authorized'|'needPassword'>('unknown')
  const [authNonce, setAuthNonce] = useState(0)
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<'idle'|'copied'|'error'>('idle')
  const [copyMessage, setCopyMessage] = useState('')

  useEffect(() => {
    setAuthState('unknown')
    setAuthNonce(n => n + 1)
    setLoginPassword(queryPassword ?? '')
    setLoginError(null)
  }, [slug, queryPassword])

  useEffect(() => {
    let alive = true
    async function load() {
      const directPassword = queryPassword ?? undefined
      try {
        const snap = await fetchSnapshot(slug, directPassword ? { password: directPassword } : undefined)
        if (!alive) return
        setContent(snap.content)
        setAuthState('authorized')
        if (directPassword) {
          setStoredPassword(slug, directPassword)
          setLoginPassword('')
        }
      } catch (err) {
        if (!alive) return
        if (err instanceof UnauthorizedError) {
          setAuthState('needPassword')
          if (directPassword) {
            setLoginError('パスワードが違います')
          }
        } else {
          console.error(err)
        }
      }
    }
    load()
    return () => { alive = false }
  }, [slug, authNonce, queryPassword])

  const handleLoginSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoginError(null)
    try {
      const snap = await fetchSnapshot(slug, { password: loginPassword })
      setStoredPassword(slug, loginPassword)
      setContent(snap.content)
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

  const handleCopyLink = useCallback(async () => {
    if (typeof window === 'undefined') return
    const path = encodedSlugPath.length > 0 ? `/view/${encodedSlugPath}` : '/view'
    const url = new URL(path, window.location.origin).toString()
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        throw new Error('clipboard unavailable')
      }
      setCopyStatus('copied')
      setCopyMessage('リンクをコピーしました')
    } catch {
      setCopyStatus('error')
      setCopyMessage('コピーに失敗しました')
    } finally {
      window.setTimeout(() => {
        setCopyStatus('idle')
        setCopyMessage('')
      }, 2600)
    }
  }, [encodedSlugPath])

  if (authState !== 'authorized') {
    return (
      <main>
        <section className="page-section">
          <div className="section-header">
            <div>
              <div className="section-title-row">
                <h1 className="section-title">閲覧ページ</h1>
                <span className="section-slug">/{slug || '未指定'}</span>
              </div>
            </div>
            <div className="view-controls">
              <Link href={encodedSlugPath.length > 0 ? `/edit/${encodedSlugPath}` : '/edit'} className="button button-secondary">
                編集に切り替える
              </Link>
            </div>
          </div>
          {authState === 'unknown' ? (
            <p className="status-message">認証確認中...</p>
          ) : (
            <form onSubmit={handleLoginSubmit} className="password-form">
              <div className="input-field">
                <label htmlFor="view-password">閲覧パスワード</label>
                <input
                  id="view-password"
                  className="input-text"
                  type="password"
                  value={loginPassword}
                  onChange={e => setLoginPassword(e.target.value)}
                  autoFocus
                  placeholder="編集ページで設定されたパスワード"
                />
              </div>
              <button type="submit" className="button button-primary" disabled={loginPassword.length === 0}>
                認証する
              </button>
            </form>
          )}
          {loginError && <p className="status-message error">{loginError}</p>}
          <p className="form-note">パスワードは編集ページの「パスワード設定」から更新できます。</p>
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
              <h1 className="section-title">閲覧モード</h1>
              <span className="section-slug">/{slug || '未指定'}</span>
            </div>
          </div>
          <div className="view-controls">
            <button type="button" className="button button-ghost" onClick={handleCopyLink}>
              リンクをコピー
            </button>
            <Link href={encodedSlugPath.length > 0 ? `/edit/${encodedSlugPath}` : '/edit'} className="button button-secondary">
              編集ページを開く
            </Link>
          </div>
        </div>
        {copyStatus !== 'idle' && copyMessage && (
          <p className={`status-message ${copyStatus === 'error' ? 'error' : 'success'}`}>{copyMessage}</p>
        )}
        <div className="view-content">
          <MarkdownRenderer content={content} />
        </div>
      </section>
    </main>
  )
}
