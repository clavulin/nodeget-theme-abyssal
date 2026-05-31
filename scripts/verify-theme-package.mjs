import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distPath = resolve(projectRoot, 'dist')
const manifestPath = resolve(distPath, 'nodeget-theme.json')
const configPath = resolve(distPath, 'config.json')
const filelistPath = resolve(distPath, 'nodeget-theme-files.json')
const zipPath = resolve(distPath, 'NodeGet-Abyssal-Theme.zip')
const releaseAssetsPath = resolve(projectRoot, 'docs', 'release-assets.json')

const REQUIRED_ENTRIES = ['custom.css', 'custom.js', 'nodeget-theme.json', 'config.json']
const APPROVED_ASSET_LICENSE_STATUSES = new Set(['approved', 'redistributable'])
const FORBIDDEN_PATTERNS = [
  /^server-order\.json$/,
  /^download\.html$/,
  /^world\.geo\.json$/,
  /^\.env(?:$|\.)/,
  /^public\/config\.json$/,
  /^\.wrangler(?:\/|$)/,
  /^node_modules(?:\/|$)/,
  /^dist(?:\/|$)/,
]
const PLACEHOLDER_BACKEND_RE = /your-backend\.example\.com/i
const PLACEHOLDER_TOKEN_RE = /^(?:your-token|your-api-token|your-token-here|your_token_here|change-me|example-token)$/i
const PRIVATE_PREFERENCE_FLAGS = ['enable_server_order']
const STRICT_ASSET_LICENSES = process.env.NODEGET_THEME_STRICT_ASSET_LICENSES === '1'

function fail(message) {
  console.error(`[verify-package] ${message}`)
  process.exit(1)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function readJson(path, label) {
  assert(existsSync(path), `${label} is missing`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(`${label} is not valid JSON`)
  }
}

function normalizeEntry(entry) {
  return String(entry).replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function assertAllowedEntries(entries, label) {
  for (const rawEntry of entries) {
    const entry = normalizeEntry(rawEntry)
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert(!pattern.test(entry), `${label} contains forbidden entry: ${entry}`)
    }
  }

  for (const required of REQUIRED_ENTRIES) {
    assert(entries.includes(required), `${label} is missing required entry: ${required}`)
  }
}

function isGeneratedRasterVariant(entry, entries) {
  if (!/^assets\/[^/]+\.(?:avif|webp)$/i.test(entry)) return false
  const sourcePng = entry.replace(/\.(?:avif|webp)$/i, '.png')
  return entries.includes(sourcePng)
}

function isReleaseStaticAssetPath(entry, entries) {
  if (entry === 'logo.png') return true
  if (entry.startsWith('linux-logo-icon/') && !entry.endsWith('/')) return true
  if (!entry.startsWith('assets/') || entry.endsWith('/')) return false
  if (isGeneratedRasterVariant(entry, entries)) return false
  return !/^assets\/[^/]+\.(?:js|css)(?:\.map)?$/.test(entry)
}

function assertReleaseAssetInventory(inventory, entries, label) {
  assert(inventory && typeof inventory === 'object', 'docs/release-assets.json must be a JSON object')
  assert(Array.isArray(inventory.assets), 'docs/release-assets.json assets must be an array')

  const inventoryPaths = new Set()
  for (const [index, asset] of inventory.assets.entries()) {
    assert(asset && typeof asset === 'object', `asset inventory entry ${index} must be an object`)
    assert(typeof asset.path === 'string' && asset.path.trim(), `asset inventory entry ${index} is missing path`)
    const path = normalizeEntry(asset.path)
    assert(typeof asset.kind === 'string' && asset.kind.trim(), `asset inventory entry ${path} is missing kind`)
    assert(typeof asset.role === 'string' && asset.role.trim(), `asset inventory entry ${path} is missing role`)
    assert(typeof asset.origin === 'string' && asset.origin.trim(), `asset inventory entry ${path} is missing origin`)
    const licenseStatus = asset.license_status
    assert(
      typeof licenseStatus === 'string' && licenseStatus.trim(),
      `asset inventory entry ${path} is missing license_status`,
    )
    assert(!inventoryPaths.has(path), `asset inventory contains duplicate path: ${path}`)
    inventoryPaths.add(path)

    if (STRICT_ASSET_LICENSES) {
      assert(
        APPROVED_ASSET_LICENSE_STATUSES.has(licenseStatus),
        `asset inventory entry ${path} has non-approved license_status: ${licenseStatus}`,
      )
    }
  }

  const normalizedEntries = entries.map(normalizeEntry)
  const releaseAssetPaths = new Set(normalizedEntries.filter((entry) => isReleaseStaticAssetPath(entry, normalizedEntries)))

  for (const path of releaseAssetPaths) {
    assert(inventoryPaths.has(path), `${label} contains release asset missing from docs/release-assets.json: ${path}`)
  }

  for (const path of inventoryPaths) {
    assert(releaseAssetPaths.has(path), `docs/release-assets.json contains asset missing from ${label}: ${path}`)
  }
}

function assertPlaceholderConfig(config, label) {
  assert(config && typeof config === 'object', `${label} must be a JSON object`)
  const siteTokens = Array.isArray(config.site_tokens) ? config.site_tokens : []
  assert(siteTokens.length > 0, `${label} must include placeholder site_tokens`)

  for (const [index, site] of siteTokens.entries()) {
    const backendUrl = String(site?.backend_url || '').trim()
    const token = String(site?.token || '').trim()
    assert(PLACEHOLDER_BACKEND_RE.test(backendUrl), `${label} site_tokens[${index}] backend_url must be a placeholder`)
    assert(PLACEHOLDER_TOKEN_RE.test(token), `${label} site_tokens[${index}] token must be a placeholder`)
  }

  for (const key of PRIVATE_PREFERENCE_FLAGS) {
    assert(config.user_preferences?.[key] === undefined, `${label} user_preferences.${key} must not be present`)
  }
}

function assertManifestDefaults(manifest) {
  const items = manifest?.user_preferences_form?.items
  assert(Array.isArray(items), 'manifest user_preferences_form.items must be an array')

  for (const key of PRIVATE_PREFERENCE_FLAGS) {
    const item = items.find((candidate) => candidate?.key === key)
    assert(!item, `manifest user_preferences_form must not expose ${key}`)
  }
}

function readZipEntryNames(path) {
  assert(existsSync(path), 'dist/NodeGet-Abyssal-Theme.zip is missing')
  const buffer = readFileSync(path)
  const eocdSignature = 0x06054b50
  const centralDirectorySignature = 0x02014b50
  const minEocdOffset = Math.max(0, buffer.length - 0xffff - 22)

  let eocdOffset = -1
  for (let offset = buffer.length - 22; offset >= minEocdOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset
      break
    }
  }
  assert(eocdOffset >= 0, 'zip central directory footer was not found')

  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16)
  const names = []
  let offset = centralDirectoryOffset

  for (let index = 0; index < entryCount; index += 1) {
    assert(buffer.readUInt32LE(offset) === centralDirectorySignature, 'zip central directory entry is invalid')
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    names.push(normalizeEntry(buffer.subarray(nameStart, nameEnd).toString('utf8')))
    offset = nameEnd + extraLength + commentLength
  }

  return names
}

const manifest = readJson(manifestPath, 'dist/nodeget-theme.json')
const config = readJson(configPath, 'dist/config.json')
const filelist = readJson(filelistPath, 'dist/nodeget-theme-files.json')
const releaseAssets = readJson(releaseAssetsPath, 'docs/release-assets.json')
assert(Array.isArray(filelist), 'dist/nodeget-theme-files.json must be an array')

assertManifestDefaults(manifest)
assertPlaceholderConfig(config, 'dist/config.json')
const filelistEntries = filelist.map(normalizeEntry)
const zipEntries = readZipEntryNames(zipPath)
assertAllowedEntries(filelistEntries, 'filelist')
assertAllowedEntries(zipEntries, 'zip')
assertReleaseAssetInventory(releaseAssets, filelistEntries, 'filelist')
assertReleaseAssetInventory(releaseAssets, zipEntries, 'zip')

console.log('[verify-package] release package artifact checks passed')
