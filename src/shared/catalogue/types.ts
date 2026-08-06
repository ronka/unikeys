/**
 * The action catalogue: the shipped, hand-authored set of actions and their
 * per-app command mappings. One catalogue entry is one table row.
 *
 * The catalogue is data, not code, and is validated at startup so a malformed
 * entry fails loudly rather than producing a silently broken row.
 */

import { APP_IDS, isAppId, type AppId } from '../apps'

export const CATEGORIES = ['editing', 'navigation', 'window', 'terminal'] as const

export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  editing: 'Editing',
  navigation: 'Navigation',
  window: 'Window & Panes',
  terminal: 'Terminal'
}

/**
 * Where an action came from. The MVP ships only `builtin` actions, but the
 * field exists now so user-authored actions can be added later without a
 * schema migration — the deferral most likely to be revisited.
 */
export type ActionOrigin = 'builtin' | 'user'

export interface CatalogueAction {
  /** Stable unikeys id. Never an app's command name. */
  id: string
  name: string
  category: Category
  /**
   * At most one command per app. An absent key is meaningful: the action has no
   * equivalent in that app, so the cell renders as not-applicable rather than
   * unbound, and linking skips it.
   */
  commands: Partial<Record<AppId, string>>
  origin?: ActionOrigin
}

export interface Catalogue {
  version: number
  actions: CatalogueAction[]
}

export type CatalogueValidation =
  { ok: true; catalogue: Catalogue } | { ok: false; errors: string[] }

const ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/

/**
 * Validates catalogue data. Collects every error rather than throwing on the
 * first, so a malformed catalogue reports all its problems at once.
 */
export function validateCatalogue(data: unknown): CatalogueValidation {
  const errors: string[] = []

  if (typeof data !== 'object' || data === null) {
    return { ok: false, errors: ['Catalogue must be an object.'] }
  }

  const raw = data as Record<string, unknown>
  if (typeof raw.version !== 'number') {
    errors.push('Catalogue is missing a numeric `version`.')
  }
  if (!Array.isArray(raw.actions)) {
    return { ok: false, errors: [...errors, 'Catalogue is missing an `actions` array.'] }
  }

  const seenIds = new Set<string>()
  const actions: CatalogueAction[] = []

  raw.actions.forEach((entry, index) => {
    const where = `actions[${index}]`
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`${where} is not an object.`)
      return
    }
    const action = entry as Record<string, unknown>
    const id = action.id

    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      errors.push(
        `${where} has an invalid id (expected dotted lowercase, got ${JSON.stringify(id)}).`
      )
      return
    }
    if (seenIds.has(id)) {
      errors.push(`${where} duplicates action id "${id}".`)
      return
    }
    seenIds.add(id)

    if (typeof action.name !== 'string' || action.name.trim() === '') {
      errors.push(`Action "${id}" is missing a display name.`)
    }
    if (!isCategory(action.category)) {
      errors.push(`Action "${id}" has an unknown category ${JSON.stringify(action.category)}.`)
    }
    if (action.origin !== undefined && action.origin !== 'builtin' && action.origin !== 'user') {
      errors.push(`Action "${id}" has an unknown origin ${JSON.stringify(action.origin)}.`)
    }

    const commands = validateCommands(id, action.commands, errors)
    if (commands && Object.keys(commands).length === 0) {
      errors.push(`Action "${id}" maps to no app; it would render as an entirely empty row.`)
    }

    if (isCategory(action.category) && typeof action.name === 'string' && commands) {
      actions.push({
        id,
        name: action.name,
        category: action.category,
        commands,
        origin: (action.origin as ActionOrigin | undefined) ?? 'builtin'
      })
    }
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, catalogue: { version: raw.version as number, actions } }
}

function validateCommands(
  id: string,
  value: unknown,
  errors: string[]
): Partial<Record<AppId, string>> | null {
  if (typeof value !== 'object' || value === null) {
    errors.push(`Action "${id}" is missing a \`commands\` object.`)
    return null
  }
  const commands: Partial<Record<AppId, string>> = {}
  for (const [app, command] of Object.entries(value)) {
    if (!isAppId(app)) {
      errors.push(`Action "${id}" maps unknown app "${app}"; known apps are ${APP_IDS.join(', ')}.`)
      continue
    }
    if (typeof command !== 'string' || command.trim() === '') {
      errors.push(`Action "${id}" maps app "${app}" to an empty command.`)
      continue
    }
    commands[app] = command
  }
  return commands
}

function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

/** True when the catalogue maps this action to a command in this app. */
export function isMapped(action: CatalogueAction, app: AppId): boolean {
  return action.commands[app] !== undefined
}

/** The apps a linked row should propagate to: the mapped ones, and no others. */
export function mappedApps(action: CatalogueAction, enabled: readonly AppId[]): AppId[] {
  return enabled.filter((app) => isMapped(action, app))
}
