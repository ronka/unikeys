/**
 * Reading from and writing to the four apps.
 *
 * This module owns the two pipelines that connect unikeys' store to the real
 * world: the non-destructive first-run import, and the transactional save.
 * Everything format-specific happens behind an adapter; nothing here knows what
 * a `keybind =` line or a `<keyboard-shortcut>` element looks like.
 */

import { existsSync } from 'node:fs'

import { adapterFor } from '../shared/adapters'
import type { ManagedBinding, ParsedBinding } from '../shared/adapters/types'
import { APPS, type AppId } from '../shared/apps'
import { formatCanonical, parseCanonical, type Chord } from '../shared/chord'
import type { Catalogue, CatalogueAction } from '../shared/catalogue/types'
import type {
  AppStatus,
  FailedApp,
  ImportedChord,
  ImportResult,
  SkippedBinding,
  WriteRequest,
  WriteResult,
  WrittenApp
} from '../shared/ipc'
import type { AppConfig, Store } from '../shared/store/types'
import { BackupSession, candidatePaths, readConfig, writeAtomic } from './config-files'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isInstalled(app: AppId): boolean {
  return APPS[app].installPaths.some((path) => existsSync(path))
}

// ---------------------------------------------------------------------------
// Reading one app
// ---------------------------------------------------------------------------

interface AppReading {
  status: AppStatus
  /** User bindings keyed by the app's own command id. */
  userBindings: Map<string, ParsedBinding>
  defaults: Map<string, ParsedBinding>
}

function readApp(app: AppId, config: AppConfig): AppReading {
  const descriptor = APPS[app]
  const adapter = adapterFor(app)
  const installed = isInstalled(app)
  const defaultsReport = adapter.defaults(app)

  const base: AppStatus = {
    app,
    name: descriptor.name,
    health: 'ok',
    installed,
    enabled: config.enabled,
    resolvedPath: null,
    overridePath: config.configPath,
    searchedPaths: config.configPath ? [config.configPath] : candidatePaths(app),
    problems: [],
    userBindingCount: 0,
    defaultsAvailability: defaultsReport.availability,
    defaultsNote: defaultsReport.note,
    reloadHint: descriptor.reloadHint
  }

  // Defaults do not come from the config file, so they are available even when
  // the file is missing — which is the common case for a fresh install.
  let defaults = indexBindings(defaultsReport.bindings)

  if (!config.enabled) {
    return { status: { ...base, health: 'disabled' }, userBindings: new Map(), defaults }
  }

  const read = readConfig(app, config.configPath)
  if (!read.ok) {
    const health = read.reason === 'not-found' ? 'config-not-found' : 'config-unreadable'
    const message =
      read.reason === 'not-found'
        ? `No config found. Looked in: ${read.searched.join(', ')}`
        : `Could not read ${read.path}: ${read.error}`
    return {
      // An app that is not installed at all is a different situation from one
      // that is installed but has no config yet, and the user should see which.
      status: { ...base, health: installed ? health : 'not-installed', message },
      userBindings: new Map(),
      defaults
    }
  }

  const parsed = adapter.parse(read.contents)
  if (!parsed.ok) {
    return {
      status: {
        ...base,
        health: 'config-unparseable',
        resolvedPath: read.path,
        message: `Could not parse ${read.path}: ${parsed.error}`
      },
      userBindings: new Map(),
      defaults
    }
  }

  // A config that discards its app's shipped defaults means those defaults are
  // inert; showing them would describe bindings the user no longer has.
  if (parsed.defaultsSuppressed) defaults = new Map()

  return {
    status: {
      ...base,
      resolvedPath: read.path,
      userBindingCount: parsed.bindings.length,
      defaultsAvailability: parsed.defaultsSuppressed ? 'unavailable' : defaultsReport.availability,
      defaultsNote: parsed.defaultsSuppressed
        ? `This config discards ${descriptor.name}'s shipped defaults, so unikeys shows only your own bindings.`
        : defaultsReport.note,
      problems: parsed.problems.map((p) => (p.detail ? `${p.message} (${p.detail})` : p.message))
    },
    userBindings: indexBindings(parsed.bindings),
    defaults
  }
}

/**
 * Keeps the first binding per command. Apps allow a command to appear more than
 * once; the first is the one unikeys shows and the one it rewrites.
 */
function indexBindings(bindings: readonly ParsedBinding[]): Map<string, ParsedBinding> {
  const map = new Map<string, ParsedBinding>()
  for (const binding of bindings) {
    if (!map.has(binding.command)) map.set(binding.command, binding)
  }
  return map
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Reads every configured app and returns what it found. Writes nothing —
 * simply opening unikeys must never change an app's configuration.
 */
export function importFromApps(store: Store, catalogue: Catalogue): ImportResult {
  const chords: ImportedChord[] = []
  const statuses: AppStatus[] = []
  const appsFailed: ImportResult['appsFailed'] = []
  let appsRead = 0

  for (const app of Object.keys(APPS) as AppId[]) {
    const reading = readApp(app, store.apps[app])
    statuses.push(reading.status)

    if (reading.status.health === 'disabled') continue
    if (reading.status.health === 'ok') {
      appsRead += 1
    } else {
      appsFailed.push({
        app,
        name: APPS[app].name,
        reason: reading.status.message ?? reading.status.health
      })
    }

    for (const action of catalogue.actions) {
      const command = action.commands[app]
      if (command === undefined) continue

      const imported = resolveCell(reading, command)
      if (imported === null) continue
      chords.push({ actionId: action.id, app, ...imported })
    }
  }

  return {
    chords,
    statuses,
    actionsFound: catalogue.actions.length,
    appsRead,
    appsFailed
  }
}

/**
 * A user's own entry beats the shipped default for the same command, which is
 * what makes an override an override. A negation entry is a deliberate "not
 * bound" and must beat the default too — otherwise unikeys would show a chord
 * the user has explicitly removed.
 */
function resolveCell(
  reading: AppReading,
  command: string
): { chord: string | null; origin: 'imported' | 'default' } | null {
  const user = reading.userBindings.get(command)
  if (user) {
    const bound = user.negated || user.chord === null ? null : formatCanonical(user.chord)
    return { chord: bound, origin: 'imported' }
  }
  const fallback = reading.defaults.get(command)
  if (fallback && !fallback.negated && fallback.chord !== null) {
    return { chord: formatCanonical(fallback.chord), origin: 'default' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Reading statuses without a full import
// ---------------------------------------------------------------------------

export function appStatuses(store: Store): AppStatus[] {
  return (Object.keys(APPS) as AppId[]).map((app) => readApp(app, store.apps[app]).status)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface PlannedWrite {
  app: AppId
  path: string
  contents: string
  skipped: SkippedBinding[]
}

/**
 * Saves in one action across every affected app.
 *
 * The full new contents for every file are computed before any file is written,
 * so a format error in one app cannot leave another half-updated. Writing still
 * happens file by file, so a genuine I/O failure partway is reported per app
 * with a precise account of what was and was not written.
 */
export function writeToApps(
  request: WriteRequest,
  store: Store,
  catalogue: Catalogue,
  backups: BackupSession
): WriteResult {
  const byApp = groupByApp(request, catalogue, store)
  const planned: PlannedWrite[] = []
  const failed: FailedApp[] = []
  const skipped: SkippedBinding[] = []

  // Phase one: compute everything.
  for (const [app, managed] of byApp) {
    const plan = planWrite(app, managed, store.apps[app])
    if ('error' in plan) {
      failed.push({ app, name: APPS[app].name, error: plan.error })
      continue
    }
    planned.push(plan)
    skipped.push(...plan.skipped)
  }

  // Phase two: write.
  const written: WrittenApp[] = []
  for (const plan of planned) {
    try {
      const backupPath = backups.ensureBackup(plan.path)
      writeAtomic(plan.path, plan.contents)
      written.push({
        app: plan.app,
        name: APPS[plan.app].name,
        path: plan.path,
        backupPath,
        reloadHint: APPS[plan.app].reloadHint
      })
    } catch (error) {
      failed.push({ app: plan.app, name: APPS[plan.app].name, error: (error as Error).message })
    }
  }

  return { written, failed, skipped, backupDirectory: backups.directory }
}

function groupByApp(
  request: WriteRequest,
  catalogue: Catalogue,
  store: Store
): Map<AppId, Array<{ actionId: string; managed: ManagedBinding }>> {
  const actions = new Map<string, CatalogueAction>(catalogue.actions.map((a) => [a.id, a]))
  const grouped = new Map<AppId, Array<{ actionId: string; managed: ManagedBinding }>>()

  for (const entry of request.bindings) {
    // A disabled app is excluded from all writes, not merely hidden.
    if (!store.apps[entry.app]?.enabled) continue

    const command = actions.get(entry.actionId)?.commands[entry.app]
    if (command === undefined) continue

    const chord = entry.chord === null ? null : parseCanonical(entry.chord)
    if (entry.chord !== null && chord === null) continue

    const list = grouped.get(entry.app) ?? []
    list.push({ actionId: entry.actionId, managed: { command, chord } })
    grouped.set(entry.app, list)
  }
  return grouped
}

function planWrite(
  app: AppId,
  entries: Array<{ actionId: string; managed: ManagedBinding }>,
  config: AppConfig
): PlannedWrite | { error: string } {
  const adapter = adapterFor(app)
  const read = readConfig(app, config.configPath)

  // A missing config is not a failure: unikeys creates one at the standard
  // location so a fresh install can still be configured.
  let contents: string
  let path: string
  if (read.ok) {
    contents = read.contents
    path = read.path
  } else if (read.reason === 'not-found') {
    contents = adapter.emptyContents()
    path = config.configPath ?? candidatePaths(app)[0]
  } else {
    return { error: read.error }
  }

  const merged = adapter.merge(
    contents,
    entries.map((e) => e.managed)
  )
  if (!merged.ok) return { error: merged.error }

  const commandToAction = new Map(entries.map((e) => [e.managed.command, e.actionId]))
  return {
    app,
    path,
    contents: merged.contents,
    skipped: merged.skipped.map((s) => ({
      app,
      actionId: commandToAction.get(s.command) ?? s.command,
      chord: formatCanonical(s.chord as Chord),
      reason: s.reason
    }))
  }
}
