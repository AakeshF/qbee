// Formats an EditorContext snapshot as a string for injection into the model's
// system prompt or as a leading system message. Kept small and stable so the
// model can rely on the structure.

import type { EditorContext } from '@qbee/shared'

const MAX_OPEN_FILES = 20
const MAX_SELECTION_CHARS = 8000

export function formatEditorContext(ctx: EditorContext | undefined): string | null {
  if (!ctx) return null
  const lines: string[] = []
  if (ctx.activeFile) {
    const cursor = ctx.cursorLine !== undefined ? `:${ctx.cursorLine + 1}` : ''
    lines.push(`active_file: ${ctx.activeFile}${cursor}`)
  }
  if (ctx.selection) {
    const { startLine, endLine, text } = ctx.selection
    lines.push(`selection: lines ${startLine + 1}-${endLine + 1}`)
    const trimmed = text.length > MAX_SELECTION_CHARS ? text.slice(0, MAX_SELECTION_CHARS) + '\n…[truncated]' : text
    lines.push('```')
    lines.push(trimmed)
    lines.push('```')
  }
  if (ctx.openFiles && ctx.openFiles.length > 0) {
    const list = ctx.openFiles.slice(0, MAX_OPEN_FILES).join(', ')
    const more = ctx.openFiles.length > MAX_OPEN_FILES ? ` (+${ctx.openFiles.length - MAX_OPEN_FILES} more)` : ''
    lines.push(`open_files: ${list}${more}`)
  }
  if (lines.length === 0) return null
  return `<editor_state>\n${lines.join('\n')}\n</editor_state>`
}
