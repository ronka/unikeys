/**
 * The checked-in `dev-home/` tree, held to the thing it claims to be: a home
 * directory in which every app unikeys supports is installed and configured.
 *
 * The claim is easy to break silently. Thirteen relative config paths and
 * thirteen bundle names are copied from `APPS` by hand, and a typo in any of
 * them shows up not as an error but as a column that reads "no config found" —
 * which is also what a genuinely broken adapter looks like. So the tree is
 * walked here rather than by eye, and app number fourteen fails this file on
 * the day it is added rather than the day someone tries to demo it.
 *
 * These are real reads of real files through `readConfig`, the same function
 * the app uses, with `UNIKEYS_DEV_HOME` doing exactly what it does in
 * `npm run dev:apps`. Nothing is mocked and nothing is written: the tests read
 * the repo's own copy, never the working copy a run makes.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { adapterFor } from '../shared/adapters'
import { APP_IDS, type AppId } from '../shared/apps'
import { CATALOGUE } from '../shared/catalogue'
import { NO_GRANTS, type ConfigLocation } from '../shared/store/types'
import { isInstalled } from './apps-service'
import { readConfig } from './config-files'
import { devHomeFor, realHome } from './grants'
import SEED from '../../tools/dev-home/store.seed.json'

const DEV_HOME = resolve(__dirname, '..', '..', 'dev-home')

/**
 * Kiro's `User/` directory exists with no `keybindings.json` in it, which is
 * what a real install looks like until the user changes a binding. Listed here
 * rather than fixed, because that state is worth having a column in.
 */
const NO_CONFIG_YET: readonly AppId[] = ['kiro']

/**
 * Obsidian keeps its hotkeys inside a vault and has no standard location, so
 * its column only resolves through a hand-set path. Read from the seed the
 * runner writes, so the tree and the store cannot drift apart over where the
 * demo vault is.
 */
function obsidianVault(): string {
  const configured = SEED.apps.obsidian.configPath
  return configured.replaceAll('{{HOME}}', DEV_HOME)
}

function locationOf(app: AppId): ConfigLocation {
  // No grants anywhere: `isSandboxed()` is false under vitest, so nothing here
  // asks for one. The seeded grants are a `npm run dev:apps` concern.
  return { configPath: app === 'obsidian' ? obsidianVault() : null, grants: NO_GRANTS }
}

const previousHome = process.env.UNIKEYS_DEV_HOME

beforeAll(() => {
  process.env.UNIKEYS_DEV_HOME = DEV_HOME
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.UNIKEYS_DEV_HOME
  else process.env.UNIKEYS_DEV_HOME = previousHome
})

describe('dev-home', () => {
  it('is where realHome points once UNIKEYS_DEV_HOME is set', () => {
    expect(realHome()).toBe(DEV_HOME)
  })

  it('is ignored in a packaged build', () => {
    // The one branch a test can reach only through the split-out decision. A
    // shipped app must never take its home from the environment, whatever is
    // exported into it.
    expect(devHomeFor(DEV_HOME, 'packaged')).toBeNull()
    expect(devHomeFor(DEV_HOME, 'unpackaged')).toBe(DEV_HOME)
    expect(devHomeFor(DEV_HOME, 'no-electron')).toBe(DEV_HOME)
  })

  it.each(APP_IDS)('has a stand-in bundle so %s reports as installed', (app) => {
    expect(isInstalled(app)).toBe(true)
  })

  it.each(APP_IDS.filter((app) => !NO_CONFIG_YET.includes(app)))(
    'has a config %s can be read from',
    (app) => {
      const read = readConfig(app, locationOf(app))
      // Asserted through the outcome rather than a bare `read.ok`, so a failure
      // names the paths that were searched instead of printing `false`.
      expect(read.ok ? read.path : read).toEqual(expect.any(String))
    }
  )

  it.each(APP_IDS.filter((app) => !NO_CONFIG_YET.includes(app)))(
    'has a config %s parses to at least one binding it maps',
    (app) => {
      const read = readConfig(app, locationOf(app))
      if (!read.ok) throw new Error(`unreadable: ${JSON.stringify(read)}`)

      // Readable is not the bar — the point of the tree is a populated table.
      // A config the adapter parses to nothing, or to commands the catalogue
      // has never heard of, gives a column as empty as a missing file does.
      const parsed = adapterFor(app).parse(read.contents)
      if (!parsed.ok) throw new Error(`unparseable: ${JSON.stringify(parsed)}`)

      const known = new Set(CATALOGUE.actions.map((action) => action.commands[app]).filter(Boolean))
      const mapped = parsed.bindings.filter((binding) => known.has(binding.command))
      expect(mapped.length).toBeGreaterThan(0)
    }
  )

  it.each(NO_CONFIG_YET)('leaves %s in the not-yet-created state', (app) => {
    const read = readConfig(app, locationOf(app))
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.reason).toBe('not-found')
  })

  it('keeps the demo vault where the seeded store says it is', () => {
    expect(existsSync(join(obsidianVault(), 'hotkeys.json'))).toBe(true)
  })

  it('grants every app the tree root under simulated sandbox', () => {
    // One entry covers all thirteen because `coveredByGrant` is containment
    // based — but each app still needs its own, since grants are per app.
    for (const app of APP_IDS) {
      expect(Object.keys(SEED.apps[app].grants)).toEqual(['{{HOME}}'])
    }
  })
})
