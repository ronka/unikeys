/**
 * Loads the shipped action catalogue.
 *
 * The catalogue is data (`catalogue.json`), not code. It is validated once at
 * module load, and a malformed entry throws with every problem listed rather
 * than producing a silently broken table row. The loader is deliberately
 * indifferent to where the data came from: `loadCatalogue` accepts any parsed
 * value, so user-authored actions (`"origin": "user"`) can be merged in later
 * without changing this module's shape.
 */

import catalogueData from './catalogue.json'
import {
  CATEGORIES,
  validateCatalogue,
  type Catalogue,
  type CatalogueAction,
  type Category
} from './types'

/**
 * Validates catalogue data and returns it, or throws an error naming every
 * problem found. Defaults to the shipped catalogue.
 */
export function loadCatalogue(data: unknown = catalogueData): Catalogue {
  const result = validateCatalogue(data)
  if (!result.ok) {
    throw new Error(
      `Invalid action catalogue (${result.errors.length} problem${
        result.errors.length === 1 ? '' : 's'
      }):\n${result.errors.map((error) => `  - ${error}`).join('\n')}`
    )
  }
  return result.catalogue
}

/** The shipped catalogue, validated at load. */
export const CATALOGUE: Catalogue = loadCatalogue()

/** The shipped actions, in catalogue order. */
export const ACTIONS: readonly CatalogueAction[] = CATALOGUE.actions

const BY_ID = new Map(CATALOGUE.actions.map((action) => [action.id, action]))

/** The catalogue action with this id, or undefined when there is no such action. */
export function actionById(id: string): CatalogueAction | undefined {
  return BY_ID.get(id)
}

export interface CategoryGroup {
  category: Category
  actions: CatalogueAction[]
}

/**
 * The catalogue grouped for display: categories in `CATEGORIES` order, actions
 * in catalogue order within each. Empty categories are omitted.
 */
export function actionsByCategory(catalogue: Catalogue = CATALOGUE): CategoryGroup[] {
  return CATEGORIES.map((category) => ({
    category,
    actions: catalogue.actions.filter((action) => action.category === category)
  })).filter((group) => group.actions.length > 0)
}

export * from './types'
