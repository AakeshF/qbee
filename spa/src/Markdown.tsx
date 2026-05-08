// Markdown wrapper with code-block syntax highlighting + GitHub-flavored extensions.
// Used by both the chat and agent panels for assistant messages.
//
// Fenced code blocks render with a header bar (language chip + Copy button)
// and a left gutter with line numbers. Inline code keeps its compact look.

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

// Minimal monokai-ish CSS for highlight.js. Inlined so we don't pull a CSS file.
const HIGHLIGHT_CSS = `
.hljs { color: #ddd; background: #1e1e1e; }
.hljs-comment, .hljs-quote { color: #6a6a6a; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-section, .hljs-deletion { color: #d97070; }
.hljs-string, .hljs-attr, .hljs-template-variable, .hljs-addition { color: #9eccaa; }
.hljs-number, .hljs-literal, .hljs-doctag, .hljs-meta { color: #d6a45c; }
.hljs-title, .hljs-name, .hljs-selector-id, .hljs-selector-class { color: #e0c46a; }
.hljs-type, .hljs-built_in, .hljs-attribute { color: #6ec6ce; }
.hljs-symbol, .hljs-bullet, .hljs-link, .hljs-variable, .hljs-tag { color: #c7a3e0; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: bold; }
`

let stylesInjected = false
function injectStyles() {
  if (stylesInjected || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.textContent = HIGHLIGHT_CSS
  document.head.appendChild(style)
  stylesInjected = true
}

const components = {
  // Inline + fenced code. react-markdown 9 passes a `node` and content; the
  // distinguishing trick is whether `className` is set (fenced gets language-*).
  code({ className, children, ...props }: any) {
    const hasLang = /language-/.test(className ?? '')
    if (!hasLang) {
      return (
        <code style={inlineCode} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className={className} style={fencedCode} {...props}>
        {children}
      </code>
    )
  },
  // Fenced blocks get a header (lang chip + Copy) and a numbered gutter.
  // Inline-only "<pre>" with no <code> child (rare) falls through unchanged.
  pre({ children }: any) {
    const codeEl = extractCodeChild(children)
    if (!codeEl) {
      return <pre style={preBlock}>{children}</pre>
    }
    const lang = extractLang(codeEl.props?.className) ?? ''
    const text = extractText(codeEl.props?.children).replace(/\n$/, '')
    return <FencedBlock lang={lang}>{text}</FencedBlock>
  },
  a({ href, children }: any) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" style={link}>
        {children}
      </a>
    )
  },
  p({ children }: any) {
    return <p style={paragraph}>{children}</p>
  },
  ul({ children }: any) {
    return <ul style={list}>{children}</ul>
  },
  ol({ children }: any) {
    return <ol style={list}>{children}</ol>
  },
}

const inlineCode: React.CSSProperties = {
  background: '#3a3a3a',
  color: '#e0c46a',
  padding: '1px 4px',
  borderRadius: 3,
  fontSize: '0.92em',
  fontFamily: 'monospace',
}
const fencedCode: React.CSSProperties = { fontFamily: 'monospace', fontSize: 12 }
const preBlock: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #333',
  borderRadius: 4,
  padding: 8,
  margin: '6px 0',
  overflowX: 'auto',
  fontSize: 12,
  lineHeight: 1.4,
}
const link: React.CSSProperties = { color: '#7aa6e0', textDecoration: 'underline' }
const paragraph: React.CSSProperties = { margin: '4px 0' }
const list: React.CSSProperties = { margin: '4px 0', paddingLeft: 20 }

export function Markdown({ text }: { text: string }) {
  injectStyles()
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components as any}>
      {text}
    </ReactMarkdown>
  )
}

// Walks react-markdown's children and pulls out the single inner <code>
// element. react-markdown renders fenced code as <pre><code class="language-x">…</code></pre>.
// children may be a single element or an array; first <code>-typed wins.
function extractCodeChild(children: any): any | null {
  const arr = Array.isArray(children) ? children : [children]
  for (const c of arr) {
    if (c && typeof c === 'object' && c.type === 'code') return c
    // react-markdown wraps in our own custom code component, where type is the function.
    if (c && typeof c === 'object' && c.props && typeof c.props === 'object' && 'className' in c.props) {
      return c
    }
  }
  return null
}

function extractLang(className: string | undefined): string | null {
  if (!className) return null
  const match = className.match(/language-([\w-]+)/)
  return match ? match[1]! : null
}

// Recursively flatten react children to a plain string. rehypeHighlight has
// already nested span elements over the raw text; we walk them for the copy
// button payload.
function extractText(node: any): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && node.props && 'children' in node.props) {
    return extractText(node.props.children)
  }
  return ''
}

function FencedBlock({ lang, children }: { lang: string; children: string }) {
  const [copied, setCopied] = useState(false)
  const lines = children.split('\n')
  const lineNumWidth = String(lines.length).length

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(children)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard access denied (rare in webview). Silent — the user can still
      // select-and-copy manually.
    }
  }

  return (
    <div style={fencedRoot}>
      <div style={fencedHeader}>
        <span style={fencedLangChip}>{lang || 'code'}</span>
        <span style={{ flex: 1 }} />
        <button style={copyBtn} onClick={onCopy} title="Copy this block to clipboard">
          {copied ? '✓ copied' : 'Copy'}
        </button>
      </div>
      <pre style={preBlockNumbered}>
        <code className={lang ? `language-${lang}` : undefined} style={fencedCode}>
          {lines.map((line, i) => (
            <span key={i} style={fencedLineRow}>
              <span style={{ ...fencedGutter, width: `${lineNumWidth}ch` }}>{i + 1}</span>
              <span style={fencedLineText}>{line || '​'}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}

const fencedRoot: React.CSSProperties = {
  border: '1px solid #333',
  borderRadius: 4,
  margin: '6px 0',
  background: '#1a1a1a',
  overflow: 'hidden',
}
const fencedHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  background: '#222',
  borderBottom: '1px solid #333',
  fontSize: 11,
  color: '#aaa',
}
const fencedLangChip: React.CSSProperties = {
  fontFamily: 'monospace',
  background: '#2a3a4a',
  color: '#bcd',
  padding: '1px 6px',
  borderRadius: 3,
  fontSize: 10,
  textTransform: 'lowercase',
}
const copyBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid #444',
  color: '#aaa',
  padding: '2px 8px',
  borderRadius: 3,
  fontSize: 10,
  cursor: 'pointer',
}
const preBlockNumbered: React.CSSProperties = {
  margin: 0,
  padding: 0,
  fontSize: 12,
  lineHeight: 1.4,
  overflowX: 'auto',
}
const fencedLineRow: React.CSSProperties = { display: 'flex', alignItems: 'flex-start' }
const fencedGutter: React.CSSProperties = {
  display: 'inline-block',
  textAlign: 'right',
  paddingRight: 10,
  paddingLeft: 8,
  color: '#555',
  userSelect: 'none',
  flexShrink: 0,
  background: '#1a1a1a',
}
const fencedLineText: React.CSSProperties = {
  paddingLeft: 4,
  paddingRight: 8,
  whiteSpace: 'pre',
  flex: 1,
  minWidth: 0,
}
