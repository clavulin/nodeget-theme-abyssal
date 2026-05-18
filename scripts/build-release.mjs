import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { constants as zlibConstants, deflateRawSync } from 'node:zlib'
import { dirname, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const themeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const statusshowRoot = resolve(themeRoot, '..', 'statusshow')
const tmpRoot = resolve(themeRoot, '.tmp')
const stagedRoot = resolve(tmpRoot, 'release-statusshow')
const distRoot = resolve(themeRoot, 'dist')
const stageDistRoot = resolve(stagedRoot, 'dist')
const zipFilename = 'NodeGet-Abyssal-Theme.zip'

const SKIP_STAGE_ENTRIES = new Set([
  '.git',
  '.wrangler',
  'dist',
  'node_modules',
  zipFilename,
])
const FORBIDDEN_DIST_PATTERNS = [
  /^server-order\.json$/,
  /^download\.html$/,
  /^world\.geo\.json$/,
  /^\.env(?:$|\.)/,
  /^public\/config\.json$/,
  /^\.wrangler(?:\/|$)/,
  /^node_modules(?:\/|$)/,
  /^dist(?:\/|$)/,
]

function fail(message) {
  console.error(`[build-release] ${message}`)
  process.exit(1)
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${label} is missing or invalid JSON: ${error.message}`)
  }
}

function normalizeEntry(path) {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function assertNoReleaseEnv() {
  const forbidden = Object.keys(process.env).filter((key) => key === 'NODEGET_CONFIG' || /^SITE_\d+$/.test(key))
  if (forbidden.length > 0) {
    fail(`release builds must not use env-derived config; unset ${forbidden.sort().join(', ')}`)
  }
}

function cleanBuildEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODEGET_') || /^SITE_\d+$/.test(key)) {
      delete env[key]
    }
  }
  return env
}

function copyStatusShowSource() {
  if (!existsSync(resolve(statusshowRoot, 'package.json'))) {
    fail(`expected StatusShow source at ${statusshowRoot}`)
  }

  rmSync(stagedRoot, { recursive: true, force: true })
  mkdirSync(stagedRoot, { recursive: true })

  for (const name of readdirSync(statusshowRoot)) {
    if (SKIP_STAGE_ENTRIES.has(name) || /^\.env(?:$|\.)/.test(name)) continue
    cpSync(resolve(statusshowRoot, name), resolve(stagedRoot, name), {
      recursive: true,
      dereference: false,
      errorOnExist: false,
      force: true,
    })
  }

  const upstreamNodeModules = resolve(statusshowRoot, 'node_modules')
  if (existsSync(upstreamNodeModules)) {
    symlinkSync(upstreamNodeModules, resolve(stagedRoot, 'node_modules'), 'dir')
  }
}

function overlayThemeCore() {
  rmSync(resolve(stagedRoot, 'public'), { recursive: true, force: true })
  cpSync(resolve(themeRoot, 'public'), resolve(stagedRoot, 'public'), { recursive: true })
  cpSync(resolve(themeRoot, 'nodeget-theme.json'), resolve(stagedRoot, 'nodeget-theme.json'))
}

function runViteBuild() {
  const viteCli = resolve(stagedRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteCli)) {
    fail(`missing ${viteCli}; install dependencies in ${statusshowRoot} before building`)
  }

  execFileSync(process.execPath, [viteCli, 'build', '--emptyOutDir'], {
    cwd: stagedRoot,
    env: cleanBuildEnv(),
    stdio: 'inherit',
  })
}

function writeReleaseMetadata() {
  rmSync(distRoot, { recursive: true, force: true })
  cpSync(stageDistRoot, distRoot, { recursive: true })

  const packageJson = readJson(resolve(themeRoot, 'package.json'), 'package.json')
  const themeManifest = readJson(resolve(themeRoot, 'nodeget-theme.json'), 'nodeget-theme.json')
  const placeholderConfig = readJson(resolve(themeRoot, 'config.example.json'), 'config.example.json')

  themeManifest.version = packageJson.version
  writeFileSync(resolve(distRoot, 'nodeget-theme.json'), `${JSON.stringify(themeManifest, null, 2)}\n`)
  writeFileSync(resolve(distRoot, 'config.json'), `${JSON.stringify(placeholderConfig, null, 2)}\n`)
}

function collectFiles(dir, root = dir) {
  const entries = []
  for (const name of readdirSync(dir).sort()) {
    const fullPath = resolve(dir, name)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      entries.push(...collectFiles(fullPath, root))
    } else if (stat.isFile()) {
      entries.push(normalizeEntry(relative(root, fullPath)))
    }
  }
  return entries
}

function pruneForbiddenOutputs() {
  for (const entry of collectFiles(distRoot)) {
    if (entry === zipFilename) continue
    if (FORBIDDEN_DIST_PATTERNS.some((pattern) => pattern.test(entry))) {
      rmSync(resolve(distRoot, entry), { force: true })
      console.log(`[build-release] pruned forbidden output ${entry}`)
    }
  }
}

function writeFileList() {
  const filelistPath = resolve(distRoot, 'nodeget-theme-files.json')
  rmSync(filelistPath, { force: true })
  rmSync(resolve(distRoot, zipFilename), { force: true })

  const entries = collectFiles(distRoot)
  entries.push('nodeget-theme-files.json')
  writeFileSync(filelistPath, `${JSON.stringify(entries, null, 2)}\n`)
  return entries
}

function makeCrc32Table() {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[index] = value >>> 0
  }
  return table
}

const CRC32_TABLE = makeCrc32Table()

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980)
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosDate, dosTime }
}

function writeUInt16(value) {
  const buffer = Buffer.allocUnsafe(2)
  buffer.writeUInt16LE(value)
  return buffer
}

function writeUInt32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

function createZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    if (entry === zipFilename) continue
    const fullPath = resolve(distRoot, entry)
    const stat = lstatSync(fullPath)
    if (!stat.isFile()) continue

    const raw = readFileSync(fullPath)
    const compressed = deflateRawSync(raw, { level: zlibConstants.Z_BEST_COMPRESSION })
    const name = Buffer.from(entry)
    const checksum = crc32(raw)
    const { dosDate, dosTime } = dosDateTime(stat.mtime)
    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(8),
      writeUInt16(dosTime),
      writeUInt16(dosDate),
      writeUInt32(checksum),
      writeUInt32(compressed.length),
      writeUInt32(raw.length),
      writeUInt16(name.length),
      writeUInt16(0),
      name,
    ])
    const centralHeader = Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(8),
      writeUInt16(dosTime),
      writeUInt16(dosDate),
      writeUInt32(checksum),
      writeUInt32(compressed.length),
      writeUInt32(raw.length),
      writeUInt16(name.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(offset),
      name,
    ])

    localParts.push(localHeader, compressed)
    centralParts.push(centralHeader)
    offset += localHeader.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const endOfCentralDirectory = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(centralParts.length),
    writeUInt16(centralParts.length),
    writeUInt32(centralDirectory.length),
    writeUInt32(offset),
    writeUInt16(0),
  ])

  writeFileSync(resolve(distRoot, zipFilename), Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]))
}

function assertNoForbiddenDistEntries(entries) {
  for (const entry of entries) {
    for (const pattern of FORBIDDEN_DIST_PATTERNS) {
      if (pattern.test(entry)) {
        fail(`dist contains forbidden entry after pruning: ${entry}`)
      }
    }
  }
}

assertNoReleaseEnv()
copyStatusShowSource()
overlayThemeCore()
runViteBuild()
writeReleaseMetadata()
pruneForbiddenOutputs()
const entries = writeFileList()
assertNoForbiddenDistEntries(entries)
createZip(entries)

console.log(`[build-release] wrote ${distRoot}`)
