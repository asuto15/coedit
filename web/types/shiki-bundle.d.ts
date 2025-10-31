declare module 'shiki/bundle/web' {
  type CodeToHtmlOptions = {
    lang: string
    theme: string
  }

  type Highlighter = {
    codeToHtml(code: string, options: CodeToHtmlOptions): string
  }

  export function getHighlighter(options: Record<string, unknown>): Promise<Highlighter>
}
