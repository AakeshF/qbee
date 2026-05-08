// AppImage in-place update for v0.5 (Linux only). The editor renderer doesn't
// have arbitrary FS access, so the worker handles download + SHA verify +
// atomic replace. We can replace $APPIMAGE while it's running because Linux
// keeps the old inode alive for the process holding it open; the next launch
// gets the new version.
//
// Windows + macOS auto-update are out of scope — different mechanisms (zip
// re-extract on Windows, .dmg drag-replace or Sparkle on macOS). Both return
// 'unsupported' so the dashboard can offer the "Open release page" fallback.

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import type { UpdateCheckResponse, UpdateProgressEvent } from '@qbee/shared'

const RELEASES_OWNER = 'AakeshF'
const RELEASES_REPO = 'qbee'
const LATEST_API = `https://api.github.com/repos/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest`

type GitHubAsset = {
  name: string
  browser_download_url: string
  size: number
}

type GitHubRelease = {
  tag_name: string
  html_url: string
  assets: GitHubAsset[]
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResponse> {
  if (process.platform !== 'linux' || !process.env.APPIMAGE) {
    return { status: 'unsupported', reason: process.platform !== 'linux' ? `auto-update is Linux-only in v0.5 (got ${process.platform})` : 'not running from an AppImage ($APPIMAGE not set)' }
  }
  let release: GitHubRelease
  try {
    const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) {
      return { status: 'error', error: `GitHub API returned HTTP ${res.status}` }
    }
    release = (await res.json()) as GitHubRelease
  } catch (err) {
    return { status: 'error', error: (err as Error).message }
  }

  const latest = release.tag_name.replace(/^v/, '')
  if (compareSemver(latest, currentVersion) <= 0) {
    return { status: 'up_to_date', current: currentVersion }
  }

  const archSuffix = matchArchSuffix(os.arch())
  if (!archSuffix) {
    return { status: 'unsupported', reason: `unrecognized arch: ${os.arch()}` }
  }

  // Match the AppImage asset for this arch + the SHA sidecar.
  const appImageAsset = release.assets.find((a) => a.name.endsWith(`-${archSuffix}.AppImage`))
  if (!appImageAsset) {
    return { status: 'error', error: `no AppImage asset found for ${archSuffix} in release ${release.tag_name}` }
  }
  const shaAsset = release.assets.find((a) => a.name === `${appImageAsset.name}.sha256`)
  if (!shaAsset) {
    return { status: 'error', error: `no .sha256 sidecar found for ${appImageAsset.name}` }
  }

  return {
    status: 'available',
    current: currentVersion,
    latest,
    downloadUrl: appImageAsset.browser_download_url,
    sha256Url: shaAsset.browser_download_url,
    sizeBytes: appImageAsset.size,
    releaseNotesUrl: release.html_url,
  }
}

export async function* applyUpdate(downloadUrl: string, sha256Url: string): AsyncIterable<UpdateProgressEvent> {
  const target = process.env.APPIMAGE
  if (!target) {
    yield { type: 'error', message: '$APPIMAGE not set — not running from an AppImage' }
    return
  }
  if (process.platform !== 'linux') {
    yield { type: 'error', message: `auto-update is Linux-only in v0.5 (got ${process.platform})` }
    return
  }

  // Download the new AppImage to a tmp file alongside the target so the rename
  // is atomic on the same filesystem.
  const tmpPath = path.join(path.dirname(target), `.qbee-update-${Date.now()}.AppImage.part`)
  try {
    yield { type: 'downloading', receivedBytes: 0, totalBytes: null }
    const res = await fetch(downloadUrl)
    if (!res.ok || !res.body) {
      yield { type: 'error', message: `download failed: HTTP ${res.status}` }
      return
    }
    const totalBytes = Number(res.headers.get('content-length')) || null
    const handle = await fs.open(tmpPath, 'w', 0o755)
    let received = 0
    let lastEmit = 0
    try {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const hash = createHash('sha256')
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
          await handle.write(value)
          hash.update(value)
          received += value.length
          // Throttle progress events to one per 64 KB to avoid event spam.
          if (received - lastEmit > 64 * 1024) {
            lastEmit = received
            yield { type: 'downloading', receivedBytes: received, totalBytes }
          }
        }
      }
      yield { type: 'downloading', receivedBytes: received, totalBytes }

      yield { type: 'verifying' }
      const localHashHex = hash.digest('hex')
      const shaText = await (await fetch(sha256Url)).text()
      // .sha256 sidecar from sha256sum is "<hex>  <filename>\n". First whitespace-delimited token is the hash.
      const expectedHash = shaText.trim().split(/\s+/)[0]?.toLowerCase()
      if (!expectedHash) {
        yield { type: 'error', message: 'could not parse .sha256 sidecar' }
        return
      }
      if (expectedHash !== localHashHex) {
        yield { type: 'error', message: `SHA mismatch — expected ${expectedHash}, got ${localHashHex}` }
        return
      }
    } finally {
      await handle.close()
    }

    yield { type: 'replacing' }
    // Linux allows replacing an in-use binary; the running process keeps the
    // old inode via its open-file table while the path now points to the new
    // file. Next launch gets the new version.
    await fs.rename(tmpPath, target)
    await fs.chmod(target, 0o755)

    yield { type: 'done', targetPath: target }
  } catch (err) {
    // Cleanup the partial download on failure.
    await fs.unlink(tmpPath).catch(() => undefined)
    yield { type: 'error', message: (err as Error).message }
  }
}

function matchArchSuffix(arch: string): string | null {
  switch (arch) {
    case 'x64':
      return 'x86_64'
    case 'arm64':
      return 'aarch64'
    default:
      return null
  }
}

function compareSemver(a: string, b: string): number {
  const parse = (s: string) => s.split('-')[0]!.split('.').map((n) => Number(n) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da - db
  }
  return 0
}
