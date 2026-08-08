/**
 * Reading from and writing to the supported apps.
 *
 * This module owns the two pipelines that connect unikeys' store to the real
 * world: the non-destructive first-run import, and the transactional save.
 * Everything format-specific happens behind an adapter; nothing here knows what
 * a `keybind =` line or a `<keyboard-shortcut>` element looks like.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { adapterFor } from '../shared/adapters'
import type { ManagedBinding, ParsedBinding } from '../shared/adapters/types'
import { APPS, type AppId } from '../shared/apps'
import { formatCanonical, parseCanonical, type Chord } from '../shared/chord'
import type { Catalogue, CatalogueAction } from '../shared/catalogue/types'
import type {
  AppStatus,
  DroppedBinding,
  FailedApp,
  ImportedChord,
  ImportResult,
  SkippedBinding,
  WriteRequest,
  WriteResult,
  WrittenApp
} from '../shared/ipc'
import type { AppConfig, Store } from '../shared/store/types'
import type { ReadFailure } from './config-files'
import {
  BackupSession,
  candidatePaths,
  configPathRequiredMessage,
  readConfig,
  writeAtomic,
  writeTarget
} from './config-files'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isInstalled(app: AppId): boolean {
  return APPS[app].installPaths.some((path) => existsSync(expandHome(path)))
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
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

/**
 * Why a config could not be read, and whether that is a problem at all.
 *
 * A pure classification, kept out of `readApp` so the caller stays one linear
 * pass: the four answers differ only in these three fields, and inlining them
 * meant repeating the whole `AppReading` envelope once per answer.
 */
function diagnose(
  app: AppId,
  override: string | null,
  read: ReadFailure,
  installed: boolean
): Pick<AppStatus, 'health' | 'message' | 'plannedPath'> {
  // Checked before anything to do with a missing app: a permissions problem
  // reported as "not installed" sends the user off to reinstall an app they
  // already have.
  if (read.reason === 'unreadable') {
    return { health: 'config-unreadable', message: `Could not read ${read.path}: ${read.error}` }
  }

  // An app with no standard config location was never looked for, so neither
  // "not installed" nor "not found" describes it — both imply a search that did
  // not happen, and "No config found. Looked in: " with nothing after it is a
  // sentence that trails off. The message says what to point at instead.
  if (APPS[app].configPaths.length === 0 && !override) {
    return { health: 'config-path-required', message: configPathRequiredMessage(app) }
  }

  if (!installed) {
    return {
      health: 'not-installed',
      message: `No config found. Looked in: ${read.searched.join(', ')}`
    }
  }

  // A missing config on an app the user has is not a failure: `planWrite`
  // creates one on the first save. So the question here is the one the save
  // itself will ask — is there a location unikeys may write to? Deriving the
  // answer from `writeTarget` rather than marking the apps whose config unikeys
  // owns is what stops the status and the save from ever disagreeing.
  const target = writeTarget(app, override)
  return target.ok
    ? {
        health: 'config-not-created',
        plannedPath: target.path,
        message: 'unikeys creates this file the first time you save.'
      }
    : { health: 'config-not-found', message: target.error }
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
    return {
      status: { ...base, ...diagnose(app, config.configPath, read, installed) },
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
    } else if (reading.status.health !== 'config-not-created') {
      // A config unikeys is going to create on the first save is neither read
      // nor failed, so it is the one unhealthy state that reports nothing here:
      // listing it under "could not read" turns the ordinary state of a fresh
      // install into an error the user goes looking for a fix to. Note it is
      // not `continue`d — its app's shipped defaults still import below.
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

/**
 * App health only depends on the app configuration, so it takes just that —
 * the renderer can ask for a refresh without shipping the whole store over IPC
 * on every chord edit.
 */
export function appStatuses(apps: Store['apps']): AppStatus[] {
  return (Object.keys(APPS) as AppId[]).map((app) => readApp(app, apps[app]).status)
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
  const { byApp, dropped } = groupByApp(request, catalogue, store)
  const planned: PlannedWrite[] = []
  const failed: FailedApp[] = []
  const skipped: SkippedBinding[] = []

  // Phase one: compute everything. A throw here is caught per app so one app's
  // unreadable directory cannot abort the save for every other app.
  for (const [app, managed] of byApp) {
    try {
      const plan = planWrite(app, managed, store.apps[app])
      if ('error' in plan) {
        failed.push({ app, name: APPS[app].name, error: plan.error })
        continue
      }
      planned.push(plan)
      skipped.push(...plan.skipped)
    } catch (error) {
      failed.push({ app, name: APPS[app].name, error: (error as Error).message })
    }
  }

  // Phase two: write.
  const written: WrittenApp[] = []
  for (const plan of planned) {
    try {
      const backupPath = backups.ensureBackup(plan.path, plan.app)
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

  return { written, failed, skipped, dropped, backupDirectory: backups.directory }
}

interface GroupedWrites {
  byApp: Map<AppId, Array<{ actionId: string; managed: ManagedBinding }>>
  dropped: DroppedBinding[]
}

/**
 * Sorts the requested bindings per app, recording anything it declines to write.
 *
 * Nothing is dropped silently. An edit that vanishes here would otherwise stay
 * pending forever with no explanation, and the user would keep pressing Save
 * with nothing happening.
 */
function groupByApp(request: WriteRequest, catalogue: Catalogue, store: Store): GroupedWrites {
  const actions = new Map<string, CatalogueAction>(catalogue.actions.map((a) => [a.id, a]))
  const byApp = new Map<AppId, Array<{ actionId: string; managed: ManagedBinding }>>()
  const dropped: DroppedBinding[] = []

  // Computed once: detection stats the filesystem, and doing it per binding
  // would mean hundreds of `existsSync` calls for a single save.
  const installed = new Set((Object.keys(APPS) as AppId[]).filter(isInstalled))

  for (const entry of request.bindings) {
    // A disabled app is excluded from all writes, not merely hidden. This is
    // deliberate and retrying will not change it, so the edit is settled rather
    // than left pending.
    if (!store.apps[entry.app]?.enabled) {
      dropped.push({
        app: entry.app,
        actionId: entry.actionId,
        reason: `${APPS[entry.app].name} is turned off in unikeys, so nothing was written to it.`,
        deliberate: true
      })
      continue
    }

    // An app whose config has no standard location is read-only until the user
    // names one. Checked before installation, because the fix is the same
    // whether or not the app is on this Mac, and because writing anywhere here
    // would mean guessing at a vault — the one thing unikeys must not do.
    if (APPS[entry.app].configPaths.length === 0 && !store.apps[entry.app].configPath) {
      dropped.push({
        app: entry.app,
        actionId: entry.actionId,
        reason: configPathRequiredMessage(entry.app),
        deliberate: true
      })
      continue
    }

    // An app the user does not have is not a failure to report and retry: there
    // is no config to write and no action they can take. Without this, matching
    // a row leaves a cell pending forever for an app they will never
    // install. The chord still lands in unikeys' store, so it is there if they
    // do. A manual path overrides detection — the user pointing unikeys at a
    // config is a stronger statement than an app missing from /Applications.
    if (!installed.has(entry.app) && !store.apps[entry.app].configPath) {
      dropped.push({
        app: entry.app,
        actionId: entry.actionId,
        reason: `${APPS[entry.app].name} is not installed, so there is nothing to write to.`,
        deliberate: true
      })
      continue
    }

    const command = actions.get(entry.actionId)?.commands[entry.app]
    if (command === undefined) {
      dropped.push({
        app: entry.app,
        actionId: entry.actionId,
        reason: `The catalogue maps no ${APPS[entry.app].name} command for this action.`,
        deliberate: true
      })
      continue
    }

    const chord = entry.chord === null ? null : parseCanonical(entry.chord)
    if (entry.chord !== null && chord === null) {
      // Not deliberate: the stored chord is unreadable, which is a bug or a
      // hand-edited store, and the user should be able to see and fix it.
      dropped.push({
        app: entry.app,
        actionId: entry.actionId,
        reason: `unikeys could not read the stored chord "${entry.chord}".`,
        deliberate: false
      })
      continue
    }

    const list = byApp.get(entry.app) ?? []
    list.push({ actionId: entry.actionId, managed: { command, chord } })
    byApp.set(entry.app, list)
  }
  return { byApp, dropped }
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
    // Creating the config is fine, but only at a path that actually exists as a
    // location. A candidate containing `*` is a search pattern; writing to it
    // literally would create a `WebStorm*` directory and report success for a
    // file the IDE will never read.
    const target = writeTarget(app, config.configPath)
    if (!target.ok) return { error: target.error }
    contents = adapter.emptyContents()
    path = target.path
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
