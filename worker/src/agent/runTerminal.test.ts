import { describe, it, expect } from 'vitest'
import { runShellCommand, formatTerminalResult } from './runTerminal.js'

describe('runShellCommand', () => {
  it('captures stdout and exit 0 for a successful command', async () => {
    const result = await runShellCommand('echo hello', '/tmp')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
    expect(result.stderr).toBe('')
    expect(result.timedOut).toBe(false)
  })

  it('captures stderr and a non-zero exit', async () => {
    const result = await runShellCommand('echo oops 1>&2; exit 7', '/tmp')
    expect(result.exitCode).toBe(7)
    expect(result.stderr.trim()).toBe('oops')
  })

  it('respects a tight timeout', async () => {
    const result = await runShellCommand('sleep 5', '/tmp', { timeoutMs: 100 })
    expect(result.timedOut).toBe(true)
    // SIGTERM-killed processes don't have a clean exit code; signal is what we see.
    expect(result.exitCode === null || result.signal !== null).toBe(true)
  })

  it('honors AbortSignal', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const result = await runShellCommand('sleep 5', '/tmp', { signal: ac.signal })
    expect(result.exitCode === null || result.signal !== null).toBe(true)
  })

  it('runs in the given cwd', async () => {
    const result = await runShellCommand('pwd', '/tmp')
    expect(result.stdout.trim()).toBe('/tmp')
  })
})

describe('formatTerminalResult', () => {
  it('renders command, exit code, and both streams', () => {
    const out = formatTerminalResult('npm test', {
      exitCode: 0,
      signal: null,
      stdout: '5 tests passed',
      stderr: '',
      truncated: false,
      timedOut: false,
    })
    expect(out).toContain('$ npm test')
    expect(out).toContain('exit code: 0')
    expect(out).toContain('5 tests passed')
  })

  it('marks timeouts visibly', () => {
    const out = formatTerminalResult('sleep 99', {
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: true,
    })
    expect(out).toContain('(timed out)')
  })

  it('annotates truncation', () => {
    const out = formatTerminalResult('big', {
      exitCode: 0,
      signal: null,
      stdout: 'lots',
      stderr: '',
      truncated: true,
      timedOut: false,
    })
    expect(out).toContain('truncated')
  })
})
