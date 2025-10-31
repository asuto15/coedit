import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import './globals.css'
import { BIZ_UDPGothic, M_PLUS_1_Code } from 'next/font/google'

const bizUdpGothic = BIZ_UDPGothic({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-biz-udp-gothic',
})

const mPlus1Code = M_PLUS_1_Code({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-m-plus-1-code',
})

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? 'coedit'
const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN ?? 'localhost'
const rawBaseUrl = process.env.NEXT_PUBLIC_BASE_URL?.trim()
const inferredScheme = appDomain === 'localhost' || appDomain.endsWith('.local') ? 'http' : 'https'
const baseUrl = rawBaseUrl && rawBaseUrl.length > 0 ? rawBaseUrl : `${inferredScheme}://${appDomain}`
const metadataBase = (() => {
  try {
    return new URL(baseUrl)
  } catch {
    return undefined
  }
})()

export const metadata: Metadata = {
  title: appName,
  metadataBase,
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
    apple: '/favicon.ico',
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className={`${bizUdpGothic.variable} ${mPlus1Code.variable}`}>
        <div className="app-shell">
          <header className="app-header">
            <Link href="/" className="app-brand">
              {appName}
            </Link>
          </header>
          <div className="page-container">{children}</div>
          <footer className="app-footer">
            <span>© {new Date().getFullYear()} asuto</span>
            <Link
              className="app-footer__link"
              href="https://github.com/asuto153/coedit"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </Link>
            <span className="muted">ドキュメント共同編集アプリ coedit</span>
          </footer>
        </div>
      </body>
    </html>
  )
}
