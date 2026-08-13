#!/usr/bin/env node
/**
 * Runs unikeys against the config files checked into `dev-home/`, so every
 * supported app has a config to read without any of them being installed.
 *
 * Three steps, and none of them touch anything outside the repo:
 *
 *  1. Copy `dev-home/` to a working directory. A copy rather than the tree
 *     itself, because a save writes to it — pointing unikeys at the checked-in
 *     files would mean testing a save by dirtying the repo, and `writeAtomic`
 *     resolves symlinks before writing, so linking instead of copying would put
 *     the app's output straight back into git.
 *  2. Write the seeded store from `store.seed.json` into a `userData` beside it.
 *  3. Exec `electron-vite dev` with `UNIKEYS_DEV_HOME` and
 *     `UNIKEYS_DEV_USER_DATA` set. `realHome()` returns the first; `index.ts`
 *     redirects `app.getPath('userData')` to the second.
 *
 * Usage: npm run dev:apps [-- --keep] [-- --dmg]
 *
 *   --keep  Reuse the existing working directory instead of copying a fresh
 *           tree over it. Without it every run starts from the checked-in
 *           state, which is what makes the first-save path repeatable.
 *   --dmg   Leave `UNIKEYS_SIMULATE_SANDBOX` unset, giving the dmg build's
 *           behaviour. The default matches `npm run dev`: simulated sandbox,
 *           with the grants already seeded so the run opens on the table
 *           rather than on thirteen folder pickers.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')

const SOURCE = join(repo, 'dev-home')
const SEED = join(here, 'store.seed.json')

/** Inside the repo so it is easy to find and easy to `rm -rf`; gitignored. */
const WORKING = process.env.UNIKEYS_DEV_HOME_DIR ?? join(repo, '.dev-home')

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const dmg = args.includes('--dmg')

const home = join(WORKING, 'home')
const userData = join(WORKING, 'userData')

if (!existsSync(SOURCE)) {
  console.error(`No dev-home tree at ${SOURCE}.`)
  process.exit(1)
}

if (keep && existsSync(home)) {
  console.log(`dev-home: reusing ${home}`)
} else {
  rmSync(WORKING, { recursive: true, force: true })
  mkdirSync(WORKING, { recursive: true })
  cpSync(SOURCE, home, { recursive: true })
  // The tree's own README is documentation for the repo, not part of a home
  // directory — and it is the one file in there unikeys might otherwise find.
  rmSync(join(home, 'README.md'), { force: true })
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'unikeys-store.json'),
    readFileSync(SEED, 'utf8').replaceAll('{{HOME}}', home),
    'utf8'
  )
  console.log(`dev-home: fresh copy at ${home}`)
}

console.log(`dev-home: userData at ${userData}`)
console.log(`dev-home: ${dmg ? 'dmg build behaviour' : 'simulated sandbox, grants seeded'}`)

const env = { ...process.env, UNIKEYS_DEV_HOME: home, UNIKEYS_DEV_USER_DATA: userData }
// Deleted rather than merely left unset, because the environment is inherited:
// a developer who has exported UNIKEYS_SIMULATE_SANDBOX in their shell would
// otherwise get the sandboxed behaviour from the flag that asks for the other.
if (dmg) delete env.UNIKEYS_SIMULATE_SANDBOX
else env.UNIKEYS_SIMULATE_SANDBOX = '1'

const child = spawn('npx', ['electron-vite', 'dev'], { cwd: repo, env, stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
