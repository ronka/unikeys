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
import type { ConfigLocation, Grants } from '../shared/store/types'
import { isSandboxed, withGrants } from './grants'

/**
 * Named separately because a caller that has already ruled out success still
 * has a four-way decision to make about *why* — and `Extract`ing the failure
 * arms back out of the union at every such call site is noise.
 */
export type ReadFailure =
  | { ok: false; reason: 'not-found'; searched: string[] }
  | { ok: false; reason: 'unreadable'; path: string; error: string }
  /**
   * The sandbox has not been let into the directory this config lives in.
   * `stale` separates "never granted" from "granted, but the folder has since
   * moved or been deleted" — the same picker fixes both, but only one of them
   * should tell the user that something they already did has come undone.
   */
  | { ok: false; reason: 'grant-required'; directory: string; stale: boolean }

export type ReadOutcome = { ok: true; path: string; contents: string } | ReadFailure

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/**
 * The directory a sandboxed build has to be let into for this app.
 *
 * A hand-picked path wins, as it does everywhere else: the user pointing at a
 * config is a stronger statement than the standard location. Its *directory* is
 * what gets granted even when they named a file, because `writeAtomic` needs to
 * create a sibling temp file — a file grant would let unikeys read a config it
 * then could not save.
 */
export function grantDirectory(app: AppId, location: ConfigLocation): string | null {
  const override = location.configPath
  if (override) {
    // An override naming a directory is already the answer — and the check has
    // to happen *under* the grants. Without them the sandbox answers `false` for
    // a directory that plainly exists, `dirname` walks up to the parent, and
    // unikeys concludes the grant is stale because it cannot read a folder it
    // was never given. That is the Obsidian case exactly: the user grants a
    // vault's `.obsidian`, and its parent is out of bounds by design.
    const directory = withGrants(
      location.grants,
      () => existsSync(override) && statSync(override).isDirectory()
    )
    if (directory) return override
    return dirname(override)
  }

  const relative = APPS[app].grantPath
  return relative === null ? null : join(homedir(), relative)
}

/**
 * Whether this read has to stop and ask before it touches the filesystem.
 *
 * Only ever true in a sandboxed build. The question is about the directory
 * rather than about any particular bookmark: unikeys holds a grant per folder
 * it has been let into, and what matters is whether the one it needs now is
 * covered by any of them — not whether some specific bookmark was the last to
 * be stored.
 *
 * Returning the *reason* rather than a boolean is what lets the UI distinguish
 * a first run from a grant that has gone stale, which is the difference between
 * asking for something and reporting that something the user already did has
 * come undone.
 */
function grantFailure(
  app: AppId,
  location: ConfigLocation
): Extract<ReadFailure, { reason: 'grant-required' }> | null {
  if (!isSandboxed()) return null

  const directory = grantDirectory(app, location)
  // An app with no standard location and no override has nothing to grant yet;
  // `config-path-required` is the honest state and asking for a folder before
  // the user has said which vault they mean is asking the wrong question.
  if (directory === null) return null

  // Asked of unikeys' own records first, and never of the filesystem, because
  // the filesystem cannot answer it: outside a real sandbox every path is
  // reachable whatever bookmarks are held, so "can I open this?" comes back
  // `true` for a folder that was never granted. That is not a test-only
  // nicety — it is the whole of `UNIKEYS_SIMULATE_SANDBOX`, where deciding on
  // reachability alone would mean the "Needs access" state never appears for
  // anyone who has the app installed.
  if (!coveredByGrant(location.grants, directory)) {
    return { ok: false, reason: 'grant-required', directory, stale: false }
  }

  // A grant for it exists, so now the filesystem has something to say: whether
  // it still opens. A directory that lists is a live grant even when the config
  // inside is missing — that is an ordinary `not-found`, and the first save
  // creates the file.
  if (withGrants(location.grants, () => existsSync(directory))) return null
  return { ok: false, reason: 'grant-required', directory, stale: true }
}

/**
 * Whether these grants reach into this directory.
 *
 * Containment rather than an exact match, because that is how the sandbox
 * itself behaves: a grant on a folder covers everything beneath it. Resolved on
 * both sides so `/tmp` against `/private/tmp`, or a home directory reached
 * through a symlink, is not read as a different place.
 */
function coveredByGrant(grants: Grants, directory: string): boolean {
  const real = resolveOrSelf(directory)
  return Object.keys(grants).some((granted) => {
    const grantedReal = resolveOrSelf(granted)
    return real === grantedReal || real.startsWith(`${grantedReal}/`)
  })
}

/**
 * Why a chosen folder cannot serve as this app's grant, or `null` if it can.
 *
 * Checked at the moment of granting rather than at the first save, because the
 * failure it catches is silent: a user who grants `Application Support` instead
 * of `Application Support/Code/User` has given unikeys a real, working
 * permission to the wrong place, and every later read comes back "no config
 * found" with nothing to connect it to the folder they picked.
 */
export function grantMismatch(
  app: AppId,
  directory: string,
  expected: string,
  grants: Grants
): string | null {
  // Compared by resolved path so that `/tmp` versus `/private/tmp`, or a home
  // directory reached through a symlink, is not read as the user missing.
  //
  // Equality is checked before anything is looked for inside, and that order
  // matters: the right folder with no config in it yet is the ordinary state of
  // an app the user has just installed, and unikeys creates the file on the
  // first save. Demanding the file be there already would refuse the correct
  // answer.
  const chosen = resolveOrSelf(directory)
  const target = resolveOrSelf(expected)
  if (chosen === target) return null

  // A different folder is still acceptable if the config really is in it — an
  // override, or a vault, or a dotfiles repo the standard location only links
  // into. Redeemed through the brand-new bookmark, because without it the
  // sandbox answers `false` for every folder alike and unikeys would reject the
  // user's correct choice as confidently as an incorrect one.
  const landmark = configFilename(app)
  if (landmark !== null) {
    if (withGrants(grants, () => existsSync(join(directory, landmark)))) return null
    return (
      `unikeys expected ${expected} for ${APPS[app].name}, and ${directory} holds no ` +
      `${landmark}. Grant access again — the picker opens at the folder it needs.`
    )
  }

  // No landmark: a globbed config path, where the grant has to sit at a
  // particular structural level and there is no filename that proves a folder
  // is it (see `configFilename`). What that rules out is a folder *below* the
  // one unikeys asked for — granting `.../JetBrains/WebStorm2024.3` when
  // `expandGlob` has to list `.../JetBrains` is the trap, and it is a trap
  // precisely because the grant works here and then makes every read report
  // itself as stale.
  //
  // A folder somewhere else entirely is a different question, and refusing it
  // was its own dead end: a config symlinked into a dotfiles repo needs that
  // repo granted too, and the repo is nowhere near the expected path. With no
  // landmark to test it against, accepting it is the only answer that leaves a
  // way forward — and the cost of being wrong is bounded, because a folder with
  // no config in it reports the ordinary `not-found` and can simply be granted
  // again.
  if (chosen.startsWith(`${target}/`)) {
    return (
      `${directory} sits inside ${expected}, and unikeys needs ${expected} itself for ` +
      `${APPS[app].name} — it has to list that folder to find the current version. Grant ` +
      'access again and choose the folder the picker opens at.'
    )
  }
  return null
}

/**
 * The filename an app's config has inside its directory, when it is knowable in
 * advance.
 *
 * The last segment of the standard path, or the fixed name a format keeps
 * inside a directory when there is no standard path at all — which is what
 * makes an Obsidian vault checkable despite unikeys never being able to guess
 * where it is. `null` when neither exists.
 *
 * Two callers, and they want the same answer for the same reason: `configFileIn`
 * turns a directory the user picked into the file to read or write, and
 * `grantMismatch` uses it as the landmark that says a chosen folder is the right
 * one. Both are asking "what is this app's config called in here?".
 *
 * Deliberately `null` for a globbed path, and this is the subtle one. JetBrains
 * keymaps live at `.../JetBrains/WebStorm2024.3/keymaps`, so the landmark is
 * `keymaps` — but the folder that has to be granted is `.../JetBrains`, two
 * levels up, and `keymaps` is not in it. Allowing the landmark test there would
 * accept a grant on `WebStorm2024.3` (where the user can see the keymaps, so an
 * entirely natural choice), and every later read would then fail to list
 * `.../JetBrains` and report the fresh grant as stale — a loop the user cannot
 * escape by re-granting. Where the path is globbed the grant level is
 * structural, and equality is the only sound test.
 */
export function configFilename(app: AppId): string | null {
  const standard = APPS[app].configPaths[0]
  if (standard !== undefined) return standard.includes('*') ? null : basename(standard)
  return DIRECTORY_FILENAMES[APPS[app].format] ?? null
}

/** Whether two paths name the same directory, symlinks and `/tmp` spellings aside. */
export function sameDirectory(a: string, b: string): boolean {
  return resolveOrSelf(a) === resolveOrSelf(b)
}

function resolveOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * The directory actually holding a config, once symlinks are followed, when no
 * grant covers it.
 *
 * A config symlinked into a dotfiles repo is the setup a unikeys user is
 * likeliest to have, and it defeats a grant silently: the link sits inside the
 * granted folder and reads fine, while `writeAtomic` resolves it and tries to
 * create its temp file in a repo the sandbox has never heard of. Detected here
 * so the UI can ask for the repo instead of reporting a permissions error
 * against a path the user never chose.
 *
 * Answered against every grant the app holds, which is what makes the case
 * finishable. Asking only about the directory the config *appears* to live in
 * means granting the repo can never satisfy the check — the escape is reported
 * again on the next read, and the two folders take turns being the one unikeys
 * says it cannot reach.
 */
export function symlinkEscape(path: string, grants: Grants): string | null {
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return null
  }
  if (real === path) return null

  const realDirectory = dirname(real)
  return coveredByGrant(grants, realDirectory) ? null : realDirectory
}

/**
 * Resolves an app's config path. A manual override wins; otherwise the standard
 * macOS locations are tried in order.
 *
 * WebStorm's path contains a version segment (`WebStorm2024.3`), so a `*` in a
 * configured path is expanded against the directory listing rather than being
 * treated literally.
 *
 * Private, and called only from inside a redeemed scope. Every caller wanted a
 * path in order to read or write it, which is `readConfig`'s and `writeTarget`'s
 * job — exposing this separately only ever offered a way to resolve a path
 * without the permission to use it.
 */
function resolveConfigPath(app: AppId, override: string | null): string | null {
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
 * The fixed filename a format keeps inside a directory, for a format with no
 * standard path to read the name off.
 *
 * Obsidian's hotkeys live at `<vault>/.obsidian/hotkeys.json`, and `.obsidian`
 * is the directory a user browsing to their vault will land on and select — the
 * file inside it may not even exist yet. Every other format has a standard path
 * whose last segment is the same answer, so this table holds only the apps that
 * have none.
 *
 * Keyed by format rather than by app, so nothing above the adapter registry
 * hardcodes a particular application.
 */
const DIRECTORY_FILENAMES: Partial<Record<FormatId, string>> = {
  'obsidian-hotkeys': 'hotkeys.json'
}

/**
 * The file a directory path names for this app, or `null` if it names none.
 *
 * Derived from the standard path rather than from a table of formats. The table
 * alone knew only about Obsidian, so a user who picked `.../Cursor/User` — the
 * only thing the sandboxed picker lets them pick, since it asks for folders —
 * got no filename here, fell through to `resolveKeymapFile`, and was told their
 * VSCode-family config directory held no keymap `.xml`. Every app whose config
 * has a fixed name now resolves; the globbed ones still return `null`, because
 * a JetBrains keymap is named by whoever created it.
 */
export function configFileIn(app: AppId, directory: string): string | null {
  const filename = configFilename(app)
  return filename === null ? null : join(directory, filename)
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
export function writeTarget(app: AppId, location: ConfigLocation): WriteTarget {
  return withGrants(location.grants, () => resolveWriteTarget(app, location.configPath))
}

function resolveWriteTarget(app: AppId, override: string | null): WriteTarget {
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

export function readConfig(app: AppId, location: ConfigLocation): ReadOutcome {
  // Asked before anything touches the filesystem. Without this the sandbox
  // would answer every `existsSync` with `false` and unikeys would report a
  // confident "no config found, looked in ..." about a folder it was never
  // allowed to open — the one wrong answer this state exists to prevent.
  const missing = grantFailure(app, location)
  if (missing) return missing

  return withGrants(location.grants, () => readGrantedConfig(app, location))
}

function readGrantedConfig(app: AppId, location: ConfigLocation): ReadOutcome {
  const override = location.configPath
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

  // A config that is really a link into a dotfiles repo reads perfectly well
  // through the grant and then fails on the first save, when `writeAtomic`
  // follows the link and tries to create a temp file somewhere the sandbox has
  // never been let into. Caught on the read so the user is asked for the repo
  // before they have made an edit, rather than after.
  const escaped = isSandboxed() ? symlinkEscape(path, location.grants) : null
  if (escaped !== null) {
    return { ok: false, reason: 'grant-required', directory: escaped, stale: false }
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
   *
   * `grants` are redeemed for the copy itself. The backup's *destination* is
   * inside unikeys' own container and never needs one; the source is the app's
   * config and always does. Redeemed here rather than by the caller so that
   * `apps-service.ts` — which calls this and `writeAtomic` back to back — stays
   * free of any notion of a bookmark.
   */
  ensureBackup(path: string, label: string, grants: Grants): string | null {
    if (this.backedUp.has(path)) return null

    return withGrants(grants, () => {
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
    })
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
 *
 * `grants` is required rather than defaulted, and `NO_GRANTS` is what unikeys'
 * own files pass. A default would make the permission a thing a caller could
 * leave off — which reads as harmless in the dmg build and silently means "no
 * access" in the App Store one, where the mistake cannot fail to compile.
 */
export function writeAtomic(path: string, contents: string, grants: Grants): void {
  withGrants(grants, () => writeResolved(path, contents))
}

function writeResolved(path: string, contents: string): void {
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
