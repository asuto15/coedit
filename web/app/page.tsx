'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, type FormEvent } from 'react'

const suggestions = [
  { title: 'デモページ', slug: 'demo' },
  { title: 'Markdownの例', slug: 'markdown-example' },
  { title: 'TODOメモ', slug: 'todo' },
  { title: 'MTG 議事録 2025-11-02', slug: 'minutes/20251102' },
  { title: '日報 2025-11-02', slug: 'daily-report/20251102' },
]

export default function Home() {
  const appName = process.env.NEXT_PUBLIC_APP_NAME ?? 'coedit'
  const router = useRouter()
  const [slug, setSlug] = useState('demo')
  const slugPath = useMemo(() => {
    return slug
      .split('/')
      .map(part => part.trim())
      .filter(part => part.length > 0)
      .map(part => encodeURIComponent(part))
      .join('/')
  }, [slug])
  const viewHref = slugPath.length > 0 ? `/view/${slugPath}` : '/view'
  const editHref = slugPath.length > 0 ? `/edit/${slugPath}` : '/edit'
  const readableSlug = slugPath.length > 0 ? slugPath : '(未指定)'

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    router.push(editHref)
  }

  return (
    <main>
      <section className="app">
        <span className="badge">'CO'llaborative 'EDIT'ing</span>
        <h1 className="app-title">{appName} へようこそ</h1>
        <p className="app-desc">
          {appName} は、複数人で同時編集できる Markdown ドキュメント共同編集アプリです。
          リアルタイム同期・Markdownレンダリング機能を持ったエディタを備えた編集ページと、ドキュメントをMarkdownにレンダリングする閲覧ページを用意し、チームでの議事録や仕様書などの管理をスムーズにします。
          履歴の保存やアクセス権限の設定もサポートしていて、離れたメンバーとも安心してドキュメントを共同編集できます。
        </p>
      </section>

      <section className="action-card">
        <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="badge">Quick Access</span>
          <h2 className="card-title">ドキュメントを開く</h2>
          <p className="form-note">URL パスにしたい任意の文字列を入力してください。入力したパスが存在しない場合は新規作成されます。</p>
        </header>
        <form onSubmit={handleSubmit} className="page-section action-form">
          <div className="input-field">
            <label htmlFor="slug-input">スペース / ドキュメント ID</label>
            <input
              id="slug-input"
              className="input-text"
              value={slug}
              placeholder="例: team/2025-q1-planning"
              onChange={event => setSlug(event.target.value)}
            />
          </div>
          <p className="slug-preview">
            <span>
              編集ページ:{' '}
              {slugPath.length > 0 ? (
                <code className="inline-code">{`/edit/${slugPath}`}</code>
              ) : (
                '未指定'
              )}
            </span>
            <span>
              閲覧ページ:{' '}
              {slugPath.length > 0 ? (
                <code className="inline-code">{`/view/${slugPath}`}</code>
              ) : (
                '未指定'
              )}
            </span>
          </p>
          <div className="actions-row">
            <button type="submit" className="button button-primary">
              編集ページを開く
            </button>
            <Link href={viewHref} className="button button-secondary">
              閲覧ページを開く
            </Link>
          </div>
        </form>
        <div className="tips-grid">
          {suggestions.map(item => (
            <button
              key={item.slug}
              type="button"
              className="tip-card"
              onClick={() => setSlug(item.slug)}
            >
              <strong>{item.title}</strong>
              <span>/{item.slug}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="page-section feature-section">
        <header className="section-header">
          <div>
            <span className="badge">Why coedit</span>
            <h2 className="section-title">チームのドキュメント運用を加速させる機能</h2>
          </div>
          <p className="section-subtitle">
            日々のミーティング、仕様策定、ナレッジ共有を 1 つのワークスペースで完結できます。
          </p>
        </header>
        <div className="feature-grid">
          <article className="feature-card">
            <span className="feature-icon" aria-hidden="true">
              ⚡
            </span>
            <h3>リアルタイムで共同編集</h3>
            <p>カーソル位置や参加メンバーのアバターまで同期され、誰がどこを編集しているか一目で把握できます。</p>
          </article>
          <article className="feature-card">
            <span className="feature-icon" aria-hidden="true">
              📦
            </span>
            <h3>履歴とスナップショットで安心</h3>
            <p>保存は自動化され、サーバ側で WAL / スナップショットを管理。巻き戻し機能も今後実装予定です。</p>
          </article>
          <article className="feature-card">
            <span className="feature-icon" aria-hidden="true">
              🔐
            </span>
            <h3>柔軟なアクセスコントロール</h3>
            <p>URL 単位のパスワード保護や共有リンクの制御が可能で、複数人で安全に共同編集できます。</p>
          </article>
          <article className="feature-card">
            <span className="feature-icon" aria-hidden="true">
              🖥️
            </span>
            <h3>分割ビューのライブプレビュー</h3>
            <p>編集中の Markdown を常にレンダリングし、装飾やリンクを確認しながら安心して編集できます。</p>
          </article>
          <article className="feature-card">
            <span className="feature-icon" aria-hidden="true">
              🧑‍🤝‍🧑
            </span>
            <h3>プレゼンスとコメント</h3>
            <p>参加メンバーの状況やメモをリアルタイムに共有。議事録やレビュー時のすれ違いを無くします。</p>
          </article>
          <article className="feature-card">
            <span className="feature-icon" aria-hidden="true">
              📚
            </span>
            <h3>URL ベースの整理整頓</h3>
            <p>任意のパスをドキュメント ID に使え、プロジェクトやチーム単位で体系的に分類できます。</p>
          </article>
        </div>
      </section>
    </main>
  )
}
