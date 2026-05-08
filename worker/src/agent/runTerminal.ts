// Subprocess execution for the run_terminal agent tool. Runs commands via
// `sh -c` (bash on systems where it's the default; either is fine because we
// only need shell pipes/redirects/expansions to behave normally).
//
// The actual *approval* of the command happens upstream in tools.ts via
// ctx.requestApproval; this module assumes approval has been granted and
// just executes.

import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 256 * 1024

export type TerminalResult = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
}

export async function runShellCommand(
  command: string,
  cwd: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<TerminalResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<TerminalResult>((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false

    const onAbort = () => {
      try { child.kill('SIGTERM') } catch { /* already exited */ }
    }
    if (options?.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already exited */ }
      // Hard-kill 2s later if SIGTERM didn't take.
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* */ } }, 2000)
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) { truncated = true; return }
      const remaining = MAX_OUTPUT_BYTES - stdoutBytes
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      stdout += slice.toString('utf8')
      stdoutBytes += slice.length
      if (chunk.length > remaining) truncated = true
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) { truncated = true; return }
      const remaining = MAX_OUTPUT_BYTES - stderrBytes
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      stderr += slice.toString('utf8')
      stderrBytes += slice.length
      if (chunk.length > remaining) truncated = true
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (options?.signal) options.signal.removeEventListener('abort', onAbort)
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + `spawn error: ${err.message}`,
        truncated,
        timedOut,
      })
    })

    child.on('close', (code, signalName) => {
      clearTimeout(timer)
      if (options?.signal) options.signal.removeEventListener('abort', onAbort)
      resolve({ exitCode: code, signal: signalName, stdout, stderr, truncated, timedOut })
    })
  })
}

export function formatTerminalResult(command: string, result: TerminalResult): string {
  const lines: string[] = []
  lines.push(`$ ${command}`)
  if (result.timedOut) lines.push('(timed out)')
  if (result.exitCode !== null) lines.push(`exit code: ${result.exitCode}`)
  else if (result.signal) lines.push(`killed by signal: ${result.signal}`)
  if (result.stdout) {
    lines.push('')
    lines.push('--- stdout ---')
    lines.push(result.stdout.trimEnd())
  }
  if (result.stderr) {
    lines.push('')
    lines.push('--- stderr ---')
    lines.push(result.stderr.trimEnd())
  }
  if (result.truncated) lines.push('\n(output truncated at 256 KB)')
  return lines.join('\n')
}
