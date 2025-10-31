import React from 'react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Node, Parent } from 'unist'
import { CodeBlock } from './MarkdownRenderer.client'

type HeadingNode = Parent & { type: 'heading'; depth: number }
type ListNode = Parent & { type: 'list'; ordered: boolean }
type LinkNode = Parent & { type: 'link'; url: string }
type CodeNode = Node & { type: 'code'; lang?: string; value: string }
type ImageNode = Node & { type: 'image'; url: string; alt?: string }
type TextNode = Node & { type: 'text'; value: string }
type InlineCodeNode = Node & { type: 'inlineCode'; value: string }

function isParent(n: Node): n is Parent { return 'children' in n }

function render(node: Node, key?: string|number): React.ReactNode {
  if (isParent(node)) {
    const children = node.children.map((c, i) => render(c, i))
    switch (node.type) {
      case 'root': return <>{children}</>
      case 'paragraph':
        return (
          <p
            key={key}
            style={{ lineHeight: 1.5, margin: '15px 0', textIndent: '1em' }}
          >
            {children}
          </p>
        )
      case 'heading': {
        const d = (node as HeadingNode).depth
        const headingTag = `h${Math.min(6, Math.max(1, d))}` as keyof JSX.IntrinsicElements
        return React.createElement(headingTag, { key, style: { margin: d <= 2 ? '20px 0 12px' : '12px 0 8px' } }, children)
      }
      case 'list': {
        const ordered = (node as ListNode).ordered
        const listTag = (ordered ? 'ol' : 'ul') as keyof JSX.IntrinsicElements
        return React.createElement(listTag, { key, style: { paddingInlineStart: 24, margin: '8px 0' } }, children)
      }
      case 'listItem': return <li key={key}>{children}</li>
      case 'blockquote': return <blockquote key={key} style={{ borderLeft: '4px solid #3b82f6', paddingLeft: 12, color: '#6b7280' }}>{children}</blockquote>
      case 'strong': return <strong key={key}>{children}</strong>
      case 'emphasis': return <em key={key}>{children}</em>
      case 'delete': return <del key={key}>{children}</del>
      case 'link': {
        const url = (node as LinkNode).url
        return <a key={key} href={url} style={{ color: '#2f8ffc', fontWeight: 600 }}>{children}</a>
      }
      case 'table': return <table key={key} style={{ borderCollapse:'collapse', border:'1px solid #ddd' }}><tbody>{children}</tbody></table>
      case 'tableRow': return <tr key={key}>{children}</tr>
      case 'tableCell': return <td key={key} style={{ border:'1px solid #ddd', padding:'6px 10px' }}>{children}</td>
      default: return <React.Fragment key={key}>{children}</React.Fragment>
    }
  } else {
    switch (node.type) {
      case 'text': return (node as TextNode).value
      case 'inlineCode': {
        const inline = node as InlineCodeNode
        return <code key={key} style={{ background:'#f3f4f6', padding:'2px 4px', borderRadius:4 }}>{inline.value}</code>
      }
      case 'code': {
        const n = node as CodeNode
        return <CodeBlock key={key} code={n.value} language={n.lang} />
      }
      case 'image': {
        const n = node as ImageNode
        return <img key={key} src={n.url} alt={n.alt ?? ''} />
      }
      case 'thematicBreak': return <hr key={key} />
      default: return null
    }
  }
}

export default function MarkdownRenderer({ content }: { content: string }) {
  const mdast = unified().use(remarkParse).use(remarkGfm).parse(content)
  return (
    <div className="prose max-w-none" style={{ wordBreak: 'break-word' }}>
      {render(mdast)}
    </div>
  )
}
