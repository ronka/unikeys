/**
 * The thin file layer that sits above the adapters.
 *
 * Adapters are pure string-to-string functions and know nothing about the
 * filesystem; everything to do with locating, reading, backing up and writing
 * config files lives here, in the main process. Nothing in the renderer ever
 * touches `fs`.
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { copyFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { APPS, type AppId } from '../shared/apps'

export type ReadOutcome =
  | { ok: true; path: string; contents: string }
  | { ok: false; reason: 'not-found'; searched: string[] }
  | { ok: false; reason: 'unreadable'; path: string; error: string }

/**
 * Resolves an app's config path. A manual override wins; otherwise the standard
 * macOS locations are tried in order.
 *
 * WebStorm's path contains a version segment (`WebStorm2024.3`), so a `*` in a
 * configured path is expanded against the directory listing rather than being
 * treated literally.
 */
export function resolveConfigPath(app: AppId, override: string | null): string | null {
  if (override) return existsSync(override) ? override : null

  for (const relative of APPS[app].configPaths) {
    const candidate = join(homedir(), relative)
    const expanded = expandGlob(candidate)
    if (expanded) return expanded
  }
  return null
}

/**
 * Every path unikeys would look at for this app, so a "config not found" message
 * can say where it looked rather than just that it failed.
 */
export function candidatePaths(app: AppId): string[] {
  return APPS[app].configPaths.map((relative) => join(homedir(), relative))
}

/**
 * Expands a single `*` segment by picking the last matching directory entry —
 * last, because JetBrains directories sort by version and the newest install is
 * the one the user is running.
 *
 * For WebStorm the resolved directory then needs a keymap file inside it; that
 * is handled by `resolveKeymapFile`.
 */
function expandGlob(path: string): string | null {
  if (!path.includes('*')) {
    return existsSync(path) ? path : null
  }

  const segments = path.split('/')
  const globIndex = segments.findIndex((s) => s.includes('*'))
  const parent = segments.slice(0, globIndex).join('/')
  const pattern = segments[globIndex]
  const rest = segments.slice(globIndex + 1)

  if (!existsSync(parent)) return null

  const prefix = pattern.slice(0, pattern.indexOf('*'))
  const suffix = pattern.slice(pattern.indexOf('*') + 1)
  const matches = readdirSync(parent)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    .sort()

  for (const match of matches.reverse()) {
    const candidate = [parent, match, ...rest].join('/')
    const resolved = expandGlob(candidate)
    if (resolved) return resolved
  }
  return null
}

/**
 * WebStorm's configured path points at a `keymaps` directory rather than a file,
 * because the filename is whatever the user named their custom keymap. Picks the
 * single `.xml` inside, or the most recently modified when there are several.
 */
export function resolveKeymapFile(keymapsDir: string): string | null {
  if (!existsSync(keymapsDir)) return null
  if (statSync(keymapsDir).isFile()) return keymapsDir

  const xmls = readdirSync(keymapsDir)
    .filter((entry) => entry.endsWith('.xml'))
    .map((entry) => join(keymapsDir, entry))
  if (xmls.length === 0) return null

  return xmls.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

export function readConfig(app: AppId, override: string | null): ReadOutcome {
  let path = resolveConfigPath(app, override)
  if (path === null) {
    return { ok: false, reason: 'not-found', searched: override ? [override] : candidatePaths(app) }
  }

  // WebStorm resolves to a directory of keymaps; pick the file inside it.
  if (existsSync(path) && statSync(path).isDirectory()) {
    const keymap = resolveKeymapFile(path)
    if (keymap === null) {
      return { ok: false, reason: 'not-found', searched: [path] }
    }
    path = keymap
  }

  try {
    return { ok: true, path, contents: readFileSync(path, 'utf8') }
  } catch (error) {
    return { ok: false, reason: 'unreadable', path, error: (error as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/**
 * Tracks which files have already been backed up, so a file is copied once per
 * session rather than once per save — a session's first backup is the one that
 * captures the pre-unikeys state, which is what makes a bad write recoverable.
 */
export class BackupSession {
  private readonly backedUp = new Set<string>()

  constructor(
    readonly directory: string,
    private readonly timestamp: string
  ) {}

  /** Returns the backup path, or `null` if this file was already backed up. */
  ensureBackup(path: string): string | null {
    if (this.backedUp.has(path)) return null
    if (!existsSync(path)) {
      // Nothing to back up; unikeys is about to create this file.
      this.backedUp.add(path)
      return null
    }

    mkdirSync(this.directory, { recursive: true })
    const target = join(this.directory, `${this.timestamp}-${basename(path)}`)
    copyFileSync(path, target)
    this.backedUp.add(path)
    return target
  }
}

/**
 * `now` is passed in rather than read here so the caller owns the clock and this
 * module stays trivially exercisable.
 */
export function createBackupSession(directory: string, now: Date): BackupSession {
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  return new BackupSession(directory, timestamp)
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

/**
 * Writes via a temp file in the same directory followed by a rename, so an
 * interrupted write can never leave a truncated config behind. Same-directory
 * matters: rename is only atomic within a filesystem.
 */
export function writeAtomic(path: string, contents: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temp = join(directory, `.${basename(path)}.unikeys-tmp`)

  try {
    writeFileSync(temp, contents, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      // The original file is intact either way; a stray temp file is not worth
      // masking the real error for.
    }
    throw error
  }
}
