#!/usr/bin/env node
// Build a multi-size Apple .icns container from PNG sources. Portable
// across Linux + macOS (no need for `iconutil`) — useful in CI where we
// can't rely on Apple tools being installed.
//
// Usage: node build-icns.mjs <master.png> <output.icns>
// The master PNG should be at least 1024x1024.

import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [, , MASTER, OUT] = process.argv
if (!MASTER || !OUT) {
	console.error('usage: build-icns.mjs <master.png> <output.icns>')
	process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'qbee-icns-'))
mkdirSync(work, { recursive: true })

const sizes = [16, 32, 64, 128, 256, 512, 1024]
for (const s of sizes) {
	execSync(`magick "${MASTER}" -resize ${s}x${s} "${work}/icon_${s}.png"`)
}

// Apple .icns OS types covering 16x16 → 1024x1024 plus retina (@2x) sizes.
const TYPES = [
	['icp4', 16],
	['icp5', 32],
	['icp6', 64],
	['ic07', 128],
	['ic08', 256],
	['ic09', 512],
	['ic10', 1024],
	['ic11', 32],
	['ic12', 64],
	['ic13', 256],
	['ic14', 512],
]

const chunks = []
for (const [type, size] of TYPES) {
	const data = readFileSync(`${work}/icon_${size}.png`)
	const header = Buffer.alloc(8)
	Buffer.from(type, 'ascii').copy(header, 0)
	header.writeUInt32BE(data.length + 8, 4)
	chunks.push(header)
	chunks.push(data)
}

const body = Buffer.concat(chunks)
const file = Buffer.alloc(8 + body.length)
Buffer.from('icns', 'ascii').copy(file, 0)
file.writeUInt32BE(8 + body.length, 4)
body.copy(file, 8)

writeFileSync(OUT, file)
console.log(`wrote ${OUT} (${file.length} bytes, ${TYPES.length} sizes)`)
