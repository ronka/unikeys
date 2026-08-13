/**
 * The grant layer: what a sandboxed build asks for, what it accepts, and what
 * it refuses to touch.
 *
 * `process.mas` is the switch the real build sets, so these tests set it too
 * rather than mocking a module — it is the actual condition the code branches
 * on, and faking it any further would test the fake. Every test restores it,
 * because leaving it on would silently sandbox the rest of the suite.
 *
 * What these tests cannot do is deny a path: there is no real sandbox here, so
 * every `existsSync` succeeds whatever bookmarks are held. So they check the
 * decisions unikeys makes — which directory it asks for, which folders it
 * accepts, whether it says it has looked — and never that macOS enforced
 * anything. Where a case depends on a denial, it is written as the sequence of
 * states the user passes through instead.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ConfigLocation, Grants } from '../shared/store/types'
import {
  grantDirectory,
  grantMismatch,
  readConfig,
  symlinkEscape,
  writeTarget
} from './config-files'
import { isSandboxed, outsideContainer } from './grants'

function pretendSandboxed(): void {
  Object.defineProperty(process, 'mas', { value: true, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'mas', { value: undefined, configurable: true })
})

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `unikeys-${prefix}-`))
}

/** Bookmarks for the given directories. The values are opaque to every caller. */
function granting(...directories: string[]): Grants {
  return Object.fromEntries(directories.map((directory) => [directory, `bookmark:${directory}`]))
}

function at(configPath: string | null, ...granted: string[]): ConfigLocation {
  return { configPath, grants: granting(...granted) }
}

const NOWHERE: ConfigLocation = { configPath: null, grants: {} }

describe('which directory gets granted', () => {
  it('is the folder holding the config, not the config itself', () => {
    // A file grant would let unikeys read a config it could never save, because
    // `writeAtomic` publishes through a temp file created beside the target.
    expect(grantDirectory('vscode', NOWHERE)).toBe(
      join(homedir(), 'Library/Application Support/Code/User')
    )
  })

  it('is the parent of the versioned directory for JetBrains', () => {
    // Expanding `WebStorm*` means listing `.../JetBrains/`, and listing a
    // directory needs that directory granted rather than its children.
    expect(grantDirectory('webstorm', NOWHERE)).toBe(
      join(homedir(), 'Library/Application Support/JetBrains')
    )
    expect(grantDirectory('intellij', NOWHERE)).toBe(grantDirectory('webstorm', NOWHERE))
  })

  it('follows a hand-picked path instead of the standard location', () => {
    const dir = temp('override')
    writeFileSync(join(dir, 'keybindings.json'), '[]')
    expect(grantDirectory('vscode', at(join(dir, 'keybindings.json')))).toBe(dir)
  })

  it('is under the real home, not the container the sandbox renames it to', () => {
    // App Sandbox rewrites `HOME` to the app's container, so a standard path
    // built from `os.homedir()` comes out as
    // `~/Library/Containers/com.ronkaa.unikeys/Data/Library/Application Support/Code/User`
    // — a folder inside unikeys' own container that VSCode has never written to.
    // The picker then opens at a path that does not exist and the refusal names
    // somewhere the user has never been.
    const home = process.env.HOME
    process.env.HOME = join(home ?? '', 'Library/Containers/com.ronkaa.unikeys/Data')
    pretendSandboxed()
    try {
      expect(grantDirectory('vscode', NOWHERE)).toBe(
        join(userInfo().homedir, 'Library/Application Support/Code/User')
      )
      expect(grantDirectory('vscode', NOWHERE)).not.toContain('Containers')
    } finally {
      process.env.HOME = home
    }
  })

  it('recovers the real home from a container path when the passwd lookup cannot', () => {
    // The backstop under `realHome`, and the only place it can be exercised: a
    // container-shaped `HOME` exists only in a signed store build, so nothing
    // else reaches this line before the certificates do.
    expect(outsideContainer('/Users/x/Library/Containers/com.ronkaa.unikeys/Data')).toBe('/Users/x')
    expect(outsideContainer('/Users/x')).toBe('/Users/x')
  })

  it('is nothing for an app with no standard location', () => {
    // Obsidian's hotkeys live in whichever vault is open, so there is no folder
    // to ask for until the user has said which one they mean.
    expect(grantDirectory('obsidian', NOWHERE)).toBeNull()
  })
})

describe('refusing the wrong folder', () => {
  it('accepts the folder unikeys asked for even when the config is not there yet', () => {
    // The ordinary state of an app the user just installed: unikeys creates the
    // file on the first save, so demanding it up front refuses a correct grant.
    const dir = temp('empty')
    expect(grantMismatch('vscode', dir, dir, granting(dir))).toBeNull()
  })

  it('accepts a different folder that actually holds the config', () => {
    const dir = temp('elsewhere')
    writeFileSync(join(dir, 'keybindings.json'), '[]')
    expect(grantMismatch('vscode', dir, '/somewhere/else', granting(dir))).toBeNull()
  })

  it('rejects a folder with neither the right path nor the config in it', () => {
    const dir = temp('wrong')
    const error = grantMismatch('vscode', dir, '/expected/place', granting(dir))
    expect(error).not.toBeNull()
    // The message has to name both, or the user has no way to tell what they
    // did wrong — the picker just reopens.
    expect(error).toContain('/expected/place')
    expect(error).toContain(dir)
    expect(error).toContain('keybindings.json')
  })

  it('refuses the versioned JetBrains folder even though the keymaps are visibly in it', () => {
    // The trap: `.../JetBrains/WebStorm2024.3` is where a user can see their
    // keymaps, so it is the natural thing to pick — but `expandGlob` has to
    // list `.../JetBrains` itself, one level up. Accepting the inner folder
    // stores a grant that reads fine here and then makes every later read
    // report the fresh grant as stale, which re-granting cannot fix.
    const jetbrains = temp('jetbrains')
    const versioned = join(jetbrains, 'WebStorm2024.3')
    mkdirSync(join(versioned, 'keymaps'), { recursive: true })

    expect(grantMismatch('webstorm', versioned, jetbrains, granting(versioned))).not.toBeNull()
    expect(grantMismatch('webstorm', jetbrains, jetbrains, granting(jetbrains))).toBeNull()
  })

  it('accepts an unrelated folder for a globbed app, so a repo grant can be re-pointed', () => {
    // The other half of the JetBrains rule. Refusing everything but the exact
    // folder asked for is right for anything *inside* it, and a dead end
    // anywhere else: a keymap symlinked into a dotfiles repo needs that repo
    // granted, and the repo is nowhere near `.../JetBrains`. With no landmark
    // to judge it by there is nothing to check, and refusing leaves the user
    // no way to grant the one folder that would work.
    const jetbrains = temp('jetbrains-elsewhere')
    const repo = temp('jetbrains-repo')
    writeFileSync(join(repo, 'MyKeymap.xml'), '<keymap/>')

    expect(grantMismatch('webstorm', repo, jetbrains, granting(repo))).toBeNull()
  })

  it('is not fooled by /tmp versus /private/tmp', () => {
    // `/tmp` is a symlink to `/private/tmp` on macOS, so the same folder has
    // two spellings — and the open panel returns whichever one it likes. Path
    // equality alone would refuse the user's correct choice.
    const dir = mkdtempSync(join('/tmp', 'unikeys-resolve-'))
    expect(grantMismatch('vscode', dir, realpathSync(dir), granting(dir))).toBeNull()
    expect(grantMismatch('vscode', realpathSync(dir), dir, granting(dir))).toBeNull()
  })
})

describe('a config symlinked out of the granted folder', () => {
  it('is reported with the directory that really has to be granted', () => {
    // The dotfiles-repo setup: the link reads fine through the grant, then
    // `writeAtomic` resolves it and tries to write into a repo the sandbox has
    // never been let into.
    const granted = temp('granted')
    const repo = temp('dotfiles')
    writeFileSync(join(repo, 'keybindings.json'), '[]')
    const link = join(granted, 'keybindings.json')
    symlinkSync(join(repo, 'keybindings.json'), link)

    // Resolved, because the resolved path is the one that has to be granted —
    // handing the UI the symlink's own directory would ask for the folder that
    // already works.
    expect(symlinkEscape(link, granting(granted))).toBe(realpathSync(repo))
  })

  it('stops being reported once the repo is granted too', () => {
    // The assertion the single-grant model could not satisfy. Holding the
    // repo's grant *alongside* the standard location's is what ends the ask;
    // replacing one with the other only moves which half is out of reach.
    const granted = temp('granted-both')
    const repo = temp('dotfiles-both')
    writeFileSync(join(repo, 'keybindings.json'), '[]')
    const link = join(granted, 'keybindings.json')
    symlinkSync(join(repo, 'keybindings.json'), link)

    expect(symlinkEscape(link, granting(granted, realpathSync(repo)))).toBeNull()
  })

  it('is not reported when the link stays inside the grant', () => {
    const granted = temp('inside')
    mkdirSync(join(granted, 'nested'))
    writeFileSync(join(granted, 'nested/keybindings.json'), '[]')
    const link = join(granted, 'keybindings.json')
    symlinkSync(join(granted, 'nested/keybindings.json'), link)

    expect(symlinkEscape(link, granting(granted))).toBeNull()
  })

  it('is not reported for an ordinary file', () => {
    const granted = temp('plain')
    const file = join(granted, 'keybindings.json')
    writeFileSync(file, '[]')
    expect(symlinkEscape(file, granting(granted))).toBeNull()
  })

  it('settles after the user grants both folders, rather than alternating', () => {
    // The whole point of holding grants as a collection, written as the
    // sequence the user actually walks. With one grant per app, round two
    // replaced round one's — and the next read asked for the folder that had
    // just been given up, forever.
    pretendSandboxed()
    const vault = temp('settle-vault')
    const repo = temp('settle-repo')
    const dotObsidian = join(vault, '.obsidian')
    mkdirSync(dotObsidian)
    writeFileSync(join(repo, 'hotkeys.json'), '{}')
    symlinkSync(join(repo, 'hotkeys.json'), join(dotObsidian, 'hotkeys.json'))

    // Round one: the user points unikeys at the vault and grants it.
    const afterFirst = at(dotObsidian, dotObsidian)
    const escaped = readConfig('obsidian', afterFirst)
    expect(escaped).toMatchObject({ reason: 'grant-required', directory: realpathSync(repo) })

    // Round two: they grant the repo the link leads to. Both are held now.
    const afterSecond = at(dotObsidian, dotObsidian, realpathSync(repo))
    expect(readConfig('obsidian', afterSecond)).toMatchObject({ ok: true })
  })
})

describe('the folder the sandboxed picker hands back', () => {
  // Under sandbox the panel asks for a directory and nothing else, because a
  // file-scoped grant could not cover the temp file `writeAtomic` puts beside
  // its target. So *every* app's config path arrives as a folder, and the
  // filename has to be derived. It used to be looked up in a table that knew
  // only about Obsidian, which meant picking the correct `.../Cursor/User` fell
  // through to the JetBrains branch and reported a VSCode-family folder as
  // holding no keymap `.xml`.
  const cases = [
    { app: 'cursor', file: 'keybindings.json' },
    { app: 'vscode', file: 'keybindings.json' },
    { app: 'zed', file: 'keymap.json' },
    { app: 'ghostty', file: 'config' },
    { app: 'warp', file: 'keybindings.yaml' },
    { app: 'obsidian', file: 'hotkeys.json' }
  ] as const

  for (const { app, file } of cases) {
    it(`resolves a directory to ${app}'s ${file}`, () => {
      const dir = temp(`dir-${app}`)
      expect(writeTarget(app, at(dir))).toEqual({ ok: true, path: join(dir, file) })

      writeFileSync(join(dir, file), file.endsWith('.yaml') ? 'keybindings: []' : '{}')
      expect(readConfig(app, at(dir))).toMatchObject({ ok: true, path: join(dir, file) })
    })
  }

  it('still refuses to invent a filename for a JetBrains keymap', () => {
    // The one app where the name is not knowable: a keymap is called whatever
    // the user called it, so an empty folder is an error rather than a path.
    const dir = temp('dir-webstorm')
    expect(writeTarget('webstorm', at(dir)).ok).toBe(false)

    writeFileSync(join(dir, 'Mine.xml'), '<keymap/>')
    expect(writeTarget('webstorm', at(dir))).toEqual({ ok: true, path: join(dir, 'Mine.xml') })
  })
})

describe('reading without a grant', () => {
  it('is a state of its own, not "config not found"', () => {
    // The distinction is the point: "unikeys looked and found nothing" sends
    // the user to check whether the app is installed, when the truth is that
    // unikeys was never allowed to look.
    pretendSandboxed()
    const read = readConfig('vscode', NOWHERE)

    expect(read.ok).toBe(false)
    expect(read).toMatchObject({
      reason: 'grant-required',
      stale: false,
      directory: join(homedir(), 'Library/Application Support/Code/User')
    })
  })

  it('reports a granted folder that has gone away as stale', () => {
    pretendSandboxed()
    // The folder the grant pointed at is gone, so the config's own directory
    // no longer exists. Outside a real sandbox the redeem is a no-op, so what
    // makes this stale is the directory being absent — which is exactly the
    // condition a sandboxed build hits when a redeemed bookmark opens nothing.
    const gone = join(temp('stale'), 'moved-away', 'keybindings.json')
    const read = readConfig('vscode', at(gone, dirname(gone)))

    expect(read).toMatchObject({ reason: 'grant-required', stale: true })
  })

  it('does not call a folder stale when the grant it holds was for somewhere else', () => {
    // Staleness is a claim that something the user already did has come undone,
    // so it is asked of the directory rather than of the app: holding a grant
    // for a different folder is not evidence that this one moved.
    pretendSandboxed()
    const gone = join(temp('unrelated'), 'moved-away', 'keybindings.json')
    const read = readConfig('vscode', at(gone, temp('somewhere-else')))

    expect(read).toMatchObject({ reason: 'grant-required', stale: false })
  })

  it('does not call a granted directory stale just because it was named directly', () => {
    // The Obsidian shape: the override names the `.obsidian` folder itself, and
    // that folder is what the user granted. Deciding "is this a directory?"
    // outside the grant would answer `false` in a real sandbox, walk up to the
    // vault root — which is deliberately out of bounds — and report a working
    // grant as stale.
    pretendSandboxed()
    const vault = temp('vault')
    const dotObsidian = join(vault, '.obsidian')
    mkdirSync(dotObsidian)
    writeFileSync(join(dotObsidian, 'hotkeys.json'), '{}')

    expect(grantDirectory('obsidian', at(dotObsidian, dotObsidian))).toBe(dotObsidian)
    expect(readConfig('obsidian', at(dotObsidian, dotObsidian))).toMatchObject({ ok: true })
  })

  it('leaves the dmg build alone', () => {
    // Outside the sandbox there is no grant and no prompt: `isSandboxed` is
    // false, so every path through `config-files.ts` behaves exactly as it did
    // before grants existed.
    expect(isSandboxed()).toBe(false)
    const read = readConfig('vscode', at('/nonexistent/keybindings.json'))
    expect(read).toMatchObject({ reason: 'not-found' })
  })
})

describe('writing without a grant', () => {
  it('never picks a path to write to', () => {
    // The refusal that matters most for review: without it the save falls
    // through to "config not found" and *creates* the file, which is unikeys
    // writing into a folder the user never granted.
    pretendSandboxed()
    const read = readConfig('vscode', NOWHERE)
    expect(read).toMatchObject({ reason: 'grant-required' })
  })

  it('still resolves a target once the folder is granted', () => {
    pretendSandboxed()
    const dir = temp('granted-write')
    expect(writeTarget('vscode', at(join(dir, 'keybindings.json'), dir))).toEqual({
      ok: true,
      path: join(dir, 'keybindings.json')
    })
  })
})
