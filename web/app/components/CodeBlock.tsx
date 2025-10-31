'use client'
import React, { useEffect, useMemo, useState } from 'react'

interface CodeBlockProps { code: string; language?: string }

const highlightCache = new Map<string, string>()

type Highlighter = {
  codeToHtml(code: string, options: { lang: string; theme: string }): string
}

let highlighterPromise: Promise<Highlighter> | null = null

async function loadHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki/bundle/web').then(({ getHighlighter }) =>
      getHighlighter({
        themes: ['github-light', 'github-dark'],
        langs: [
          'markdown',
          'bash',
          'shell',
          'javascript',
          'typescript',
          'tsx',
          'json',
          'yaml',
          'toml',
          'ini',
          'rust',
          'go',
          'python',
          'c',
          'cpp',
        ],
      }) as Promise<Highlighter>
    )
  }
  return highlighterPromise
}

function useShikiTheme(): string {
  const [theme, setTheme] = useState<string>(() => {
    if (typeof window === 'undefined') return 'github-light'
    return getComputedStyle(document.documentElement).getPropertyValue('--shiki-theme').trim() || 'github-light'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const update = () => setTheme(getComputedStyle(document.documentElement).getPropertyValue('--shiki-theme').trim() || 'github-light')
    const obs = new MutationObserver(update)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

export default function CodeBlock({ code, language }: CodeBlockProps) {
  const theme = useShikiTheme()
  const [html, setHtml] = useState('')
  const lang = language || 'plaintext'
  const key = useMemo(() => `${lang}::${theme}::${code}`, [lang, theme, code])

  useEffect(() => {
    let alive = true
    async function run() {
      if (highlightCache.has(key)) { setHtml(highlightCache.get(key)!); return }
      try {
        const hi = await loadHighlighter()
        const out = await hi.codeToHtml(code, { lang, theme })
        if (!alive) return
        highlightCache.set(key, out)
        setHtml(out)
      } catch { setHtml(`<pre><code>${code}</code></pre>`) }
    }
    run()
    return () => { alive = false }
  }, [key, code, lang, theme])

  return (
    <div className="codeblock" dangerouslySetInnerHTML={{ __html: html || `<pre><code>${code}</code></pre>` }} />
  )
}
