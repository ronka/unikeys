/**
 * The adapter registry.
 *
 * Adapters are keyed by format rather than by app, which is what lets Cursor
 * reuse the VSCode adapter — the fork shares the `keybindings.json` format and
 * only the config path differs. Nothing about a specific app is hardcoded
 * anywhere above this map.
 */

import { APPS, type AppId, type FormatId } from '../apps'
import { cmuxAdapter } from './cmux'
import { ghosttyAdapter } from './ghostty'
import { iterm2Adapter } from './iterm2'
import { jetbrainsAdapter } from './jetbrains'
import type { Adapter } from './types'
import { vscodeAdapter } from './vscode'

export const ADAPTERS: Record<FormatId, Adapter> = {
  'vscode-keybindings': vscodeAdapter,
  'jetbrains-keymap': jetbrainsAdapter,
  'ghostty-config': ghosttyAdapter,
  'cmux-config': cmuxAdapter,
  'iterm2-dynamic-profile': iterm2Adapter
}

export function adapterFor(app: AppId): Adapter {
  return ADAPTERS[APPS[app].format]
}

export * from './types'
