// Markdown wrapper with code-block syntax highlighting + GitHub-flavored extensions.
// Used by both the chat and agent panels for assistant messages.

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
  pre({ children }: any) {
    return <pre style={preBlock}>{children}</pre>
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
