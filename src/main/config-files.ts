/**
 * The thin file layer that sits above the adapters.
 *
 * Adapters are pure string-to-string functions and know nothing about the
 * filesystem; everything to do with locating, reading, backing up and writing
 * config files lives here, in the main process. Nothing in the renderer ever
 * touches `fs`.
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { chmodSync, copyFileSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { APPS, type AppId, type FormatId } from '../shared/apps'

/**
 * Named separately because a caller that has already ruled out success still
 * has a four-way decision to make about *why* — and `Extract`ing the failure
 * arms back out of the union at every such call site is noise.
 */
export type ReadFailure =
  | { ok: false; reason: 'not-found'; searched: string[] }
  | { ok: false; reason: 'unreadable'; path: string; error: string }

export type ReadOutcome = { ok: true; path: string; contents: string } | ReadFailure

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
 * The fixed filename a format keeps inside a directory, when it has one.
 *
 * Obsidian's hotkeys live at `<vault>/.obsidian/hotkeys.json`, and `.obsidian`
 * is the directory a user browsing to their vault will land on and select — the
 * file inside it may not even exist yet. Resolving the directory to the file is
 * the same courtesy `resolveKeymapFile` extends to a JetBrains `keymaps`
 * directory, and the difference is only that the name here is known in advance.
 *
 * Keyed by format rather than by app, so nothing above the adapter registry
 * hardcodes a particular application.
 */
const DIRECTORY_FILENAMES: Partial<Record<FormatId, string>> = {
  'obsidian-hotkeys': 'hotkeys.json'
}

/** The file a directory path names for this app, or `null` if it names none. */
export function configFileIn(app: AppId, directory: string): string | null {
  const filename = DIRECTORY_FILENAMES[APPS[app].format]
  return filename === undefined ? null : join(directory, filename)
}

/**
 * What to tell a user about an app that has no standard config location at all.
 *
 * Shared because three call sites need the same sentence — the Apps page status,
 * the write target, and the save that declines to write — and three copies of it
 * would drift into three different accounts of the same situation.
 */
export function configPathRequiredMessage(app: AppId): string {
  const hint = CONFIG_PATH_HINTS[APPS[app].format]
  return hint ?? `${APPS[app].name} has no standard config location. Choose one in Apps.`
}

const CONFIG_PATH_HINTS: Partial<Record<FormatId, string>> = {
  'obsidian-hotkeys':
    'Obsidian keeps its hotkeys inside a vault, so unikeys cannot find them on its own. ' +
    'Choose the vault’s .obsidian folder, or the hotkeys.json inside it. Obsidian only ' +
    'writes that file once you have set at least one hotkey, so if it is not there yet, set ' +
    'one in Obsidian first.'
}

export type WriteTarget = { ok: true; path: string } | { ok: false; error: string }

/**
 * Where a config that does not exist yet should be created.
 *
 * A candidate path containing `*` is a search pattern, not a location — writing
 * to it literally would create a directory named `WebStorm*` and a file the IDE
 * will never read, while reporting success. So an unresolvable pattern is an
 * error the user can act on rather than a path.
 */
export function writeTarget(app: AppId, override: string | null): WriteTarget {
  if (override) {
    if (existsSync(override) && statSync(override).isDirectory()) {
      // A format with a known filename can name the file even when it does not
      // exist yet, which is the ordinary state of a vault whose owner has never
      // set a hotkey.
      const known = configFileIn(app, override)
      if (known) return { ok: true, path: known }

      const keymap = resolveKeymapFile(override)
      if (keymap) return { ok: true, path: keymap }
      // A keymaps directory with no keymap in it: unikeys has no filename to
      // choose, because the name is whatever the user called their keymap.
      return {
        ok: false,
        error: `${override} is a directory with no keymap file in it. Create a custom keymap in ${APPS[app].name} first, then point unikeys at its .xml file.`
      }
    }
    return { ok: true, path: override }
  }

  // An app with no standard location was never going to have one found for it,
  // and telling its user to create a config in the app is advice that cannot
  // work: the file is already wherever they keep their data, and unikeys needs
  // to be pointed at it.
  if (APPS[app].configPaths.length === 0) {
    return { ok: false, error: configPathRequiredMessage(app) }
  }

  const concrete = candidatePaths(app).find((path) => !path.includes('*'))
  if (concrete) return { ok: true, path: concrete }

  return {
    ok: false,
    error: `unikeys could not locate ${APPS[app].name}'s config. Create a custom keymap in ${APPS[app].name}, or set the path manually in Apps.`
  }
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
    // Natural order, so WebStorm2024.10 beats WebStorm2024.9 — a plain string
    // sort gets the newest install exactly backwards once a minor hits double
    // digits.
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

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

  // A path may name a directory rather than a file: WebStorm resolves to a
  // directory of keymaps, and an Obsidian override is as likely to name the
  // vault's `.obsidian` folder as the `hotkeys.json` inside it. Reading, unlike
  // writing, needs the file to be there — a named file that does not exist yet
  // is `not-found`, which is what lets the first save create it.
  if (existsSync(path) && statSync(path).isDirectory()) {
    const known = configFileIn(app, path)
    if (known !== null) {
      if (!existsSync(known)) return { ok: false, reason: 'not-found', searched: [known] }
      path = known
    } else {
      const keymap = resolveKeymapFile(path)
      if (keymap === null) {
        return { ok: false, reason: 'not-found', searched: [path] }
      }
      path = keymap
    }
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

  /**
   * Returns the backup path, or `null` if this file was already backed up.
   *
   * `label` disambiguates the filename. VSCode and Cursor both keep a file
   * called `keybindings.json`, so naming backups after the basename alone would
   * have Cursor's backup silently overwrite VSCode's — destroying the only copy
   * of the state the user needs to recover.
   */
  ensureBackup(path: string, label: string): string | null {
    if (this.backedUp.has(path)) return null
    if (!existsSync(path)) {
      // Nothing to back up; unikeys is about to create this file.
      this.backedUp.add(path)
      return null
    }

    mkdirSync(this.directory, { recursive: true })
    const target = join(this.directory, `${this.timestamp}-${label}-${basename(path)}`)
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
  // Follow symlinks before writing. A config symlinked into a dotfiles repo is
  // exactly the setup a unikeys user is likely to have, and renaming over the
  // link would replace it with a regular file, silently orphaning the repo copy.
  const target = existsSync(path) ? realpathSync(path) : path

  const directory = dirname(target)
  mkdirSync(directory, { recursive: true })

  // The suffix is unique per call so two unikeys processes writing the same file
  // cannot publish each other's half-written temp.
  const temp = join(directory, `.${basename(target)}.unikeys-${process.pid}-${tempCounter++}.tmp`)

  try {
    writeFileSync(temp, contents, 'utf8')
    // Carry the original permissions across, so a config the user kept at 0600
    // does not come back world-readable.
    if (existsSync(target)) chmodSync(temp, statSync(target).mode & 0o7777)
    renameSync(temp, target)
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

let tempCounter = 0
