/**
 * The applications unikeys supports, and the config format each one uses.
 *
 * An `AppId` is a column in the table. A `FormatId` is an adapter — Cursor and
 * VSCode share one, which is why the two concepts are separate.
 *
 * Column order follows `APP_IDS`. Keep the `APPS` literal below in the same
 * order: `apps-service.ts` iterates `Object.keys(APPS)` when building statuses,
 * so a literal that disagrees with `APP_IDS` silently reorders the status list
 * against the columns.
 */

export const APP_IDS = [
  'vscode',
  'cursor',
  'kiro',
  'antigravity',
  'zed',
  'webstorm',
  'intellij',
  'pycharm',
  'ghostty',
  'cmux',
  'iterm2',
  'warp',
  'obsidian'
] as const

export type AppId = (typeof APP_IDS)[number]

/**
 * What kind of app this is, for grouping on the Apps page. The order here is
 * the order the groups appear in, chosen to run with `APP_IDS` rather than
 * against it — nothing enforces that, so a reordering of one wants a look at
 * the other.
 */
export const CATEGORY_IDS = ['ide', 'terminal', 'notes'] as const

export type CategoryId = (typeof CATEGORY_IDS)[number]

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  ide: 'Editors',
  terminal: 'Terminals',
  notes: 'Notes'
}

export type FormatId =
  | 'vscode-keybindings'
  | 'jetbrains-keymap'
  | 'zed-keymap'
  | 'ghostty-config'
  | 'cmux-config'
  | 'iterm2-dynamic-profile'
  | 'warp-keybindings'
  | 'obsidian-hotkeys'

export interface AppDescriptor {
  id: AppId
  /** Human-readable name, used in column headers and error messages. */
  name: string
  /** Which adapter parses and merges this app's config. */
  format: FormatId
  /**
   * Which group the app appears under on the Apps page. It lives on the
   * descriptor rather than in a list beside the page so that the exhaustive
   * `Record<AppId, AppDescriptor>` below forces a category onto app number
   * seven instead of quietly leaving it out of every group.
   */
  category: CategoryId
  /**
   * Standard macOS config locations, most likely first. Paths are relative to
   * the user's home directory. Resolution happens in the main process; nothing
   * here touches the filesystem.
   *
   * Empty for an app whose config has no standard location at all — Obsidian
   * keeps its hotkeys inside whichever vault is open, so unikeys cannot guess
   * a path and the user has to point at one.
   */
  configPaths: string[]
  /**
   * Standard macOS install locations used for detection. A leading `~` is
   * expanded by the caller. `~/Applications` matters because JetBrains Toolbox
   * installs there by default, and a Toolbox user is the likeliest WebStorm
   * user of all.
   */
  installPaths: string[]
  /** What the user must do for a written config to take effect. */
  reloadHint: string
}

export const APPS: Record<AppId, AppDescriptor> = {
  vscode: {
    id: 'vscode',
    name: 'VSCode',
    format: 'vscode-keybindings',
    category: 'ide',
    configPaths: ['Library/Application Support/Code/User/keybindings.json'],
    installPaths: ['/Applications/Visual Studio Code.app', '~/Applications/Visual Studio Code.app'],
    reloadHint: 'VSCode picks up keybindings.json automatically; no restart needed.'
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    format: 'vscode-keybindings',
    category: 'ide',
    configPaths: ['Library/Application Support/Cursor/User/keybindings.json'],
    installPaths: ['/Applications/Cursor.app', '~/Applications/Cursor.app'],
    reloadHint: 'Cursor picks up keybindings.json automatically; no restart needed.'
  },
  kiro: {
    id: 'kiro',
    name: 'Kiro',
    format: 'vscode-keybindings',
    category: 'ide',
    configPaths: ['Library/Application Support/Kiro/User/keybindings.json'],
    installPaths: ['/Applications/Kiro.app', '~/Applications/Kiro.app'],
    reloadHint: 'Kiro picks up keybindings.json automatically; no restart needed.'
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    format: 'vscode-keybindings',
    category: 'ide',
    configPaths: ['Library/Application Support/Antigravity/User/keybindings.json'],
    installPaths: ['/Applications/Antigravity.app', '~/Applications/Antigravity.app'],
    reloadHint: 'Antigravity picks up keybindings.json automatically; no restart needed.'
  },
  zed: {
    id: 'zed',
    name: 'Zed',
    format: 'zed-keymap',
    category: 'ide',
    configPaths: ['.config/zed/keymap.json'],
    installPaths: ['/Applications/Zed.app', '~/Applications/Zed.app'],
    reloadHint: 'Zed reloads keymap.json as soon as it is saved; no restart needed.'
  },
  webstorm: {
    id: 'webstorm',
    name: 'WebStorm',
    format: 'jetbrains-keymap',
    category: 'ide',
    // The version segment is a glob resolved by the main process, since
    // JetBrains nests keymaps under a versioned support directory.
    configPaths: ['Library/Application Support/JetBrains/WebStorm*/keymaps'],
    installPaths: [
      '/Applications/WebStorm.app',
      '~/Applications/WebStorm.app',
      '~/Applications/JetBrains Toolbox/WebStorm.app'
    ],
    reloadHint: 'WebStorm must be restarted before keymap changes take effect.'
  },
  intellij: {
    id: 'intellij',
    name: 'IntelliJ IDEA',
    format: 'jetbrains-keymap',
    category: 'ide',
    // Ultimate first, then Community: `configPaths` is tried in order, and a
    // machine with both should get the edition the user is more likely running.
    configPaths: [
      'Library/Application Support/JetBrains/IntelliJIdea*/keymaps',
      'Library/Application Support/JetBrains/IdeaIC*/keymaps'
    ],
    installPaths: [
      '/Applications/IntelliJ IDEA.app',
      '~/Applications/IntelliJ IDEA.app',
      '~/Applications/JetBrains Toolbox/IntelliJ IDEA.app',
      '/Applications/IntelliJ IDEA Community Edition.app',
      '~/Applications/IntelliJ IDEA Community Edition.app',
      '~/Applications/JetBrains Toolbox/IntelliJ IDEA Community Edition.app'
    ],
    reloadHint: 'IntelliJ IDEA must be restarted before keymap changes take effect.'
  },
  pycharm: {
    id: 'pycharm',
    name: 'PyCharm',
    format: 'jetbrains-keymap',
    category: 'ide',
    configPaths: [
      'Library/Application Support/JetBrains/PyCharm*/keymaps',
      'Library/Application Support/JetBrains/PyCharmCE*/keymaps'
    ],
    installPaths: [
      '/Applications/PyCharm.app',
      '~/Applications/PyCharm.app',
      '~/Applications/JetBrains Toolbox/PyCharm.app',
      '/Applications/PyCharm CE.app',
      '~/Applications/PyCharm CE.app',
      '~/Applications/JetBrains Toolbox/PyCharm CE.app'
    ],
    reloadHint: 'PyCharm must be restarted before keymap changes take effect.'
  },
  ghostty: {
    id: 'ghostty',
    name: 'Ghostty',
    format: 'ghostty-config',
    category: 'terminal',
    configPaths: [
      'Library/Application Support/com.mitchellh.ghostty/config',
      '.config/ghostty/config'
    ],
    installPaths: ['/Applications/Ghostty.app', '~/Applications/Ghostty.app'],
    reloadHint: 'Reload Ghostty config with ⌘⇧, or restart Ghostty.'
  },
  cmux: {
    id: 'cmux',
    name: 'cmux',
    format: 'cmux-config',
    category: 'terminal',
    // cmux writes this template itself on first launch, so the file usually
    // already exists — as one object of `$schema` and `schemaVersion` with
    // every setting commented out.
    configPaths: ['.config/cmux/cmux.json'],
    installPaths: ['/Applications/cmux.app', '~/Applications/cmux.app'],
    reloadHint: 'Reload cmux config with ⌘⇧, or restart cmux.'
  },
  iterm2: {
    id: 'iterm2',
    name: 'iTerm2',
    format: 'iterm2-dynamic-profile',
    category: 'terminal',
    // Not iTerm2's real preferences: those are a binary plist, and iTerm2
    // overwrites them from memory when it quits. This is a Dynamic Profile —
    // a JSON file unikeys owns outright, which iTerm2 watches and reloads live.
    configPaths: ['Library/Application Support/iTerm2/DynamicProfiles/unikeys.json'],
    // The bundle is called iTerm.app, not iTerm2.app.
    installPaths: ['/Applications/iTerm.app', '~/Applications/iTerm.app'],
    // A Dynamic Profile is a new profile, not an edit to the user's, and iTerm2
    // gives it no way to declare itself the default — so unlike every other app
    // here, one manual step stands between a successful write and any effect.
    reloadHint:
      'iTerm2 reloads this file immediately, but the bindings only apply to its "unikeys" ' +
      'profile. Once, in iTerm2: Settings → Profiles → unikeys → Other Actions → Set as Default.'
  },
  warp: {
    id: 'warp',
    name: 'Warp',
    format: 'warp-keybindings',
    category: 'terminal',
    configPaths: ['.warp/keybindings.yaml'],
    installPaths: ['/Applications/Warp.app', '~/Applications/Warp.app'],
    reloadHint: 'Warp applies keybindings.yaml when it next launches; restart Warp.'
  },
  obsidian: {
    id: 'obsidian',
    name: 'Obsidian',
    format: 'obsidian-hotkeys',
    category: 'notes',
    // Obsidian keeps hotkeys inside the vault, at `<vault>/.obsidian/hotkeys.json`,
    // and there is no vault-independent location — so there is nothing to look
    // in and the user has to name a path. See the `config-path-required` health.
    configPaths: [],
    installPaths: ['/Applications/Obsidian.app', '~/Applications/Obsidian.app'],
    reloadHint: 'Obsidian applies hotkeys.json after the app or the vault is reloaded.'
  }
}

export function appName(id: AppId): string {
  return APPS[id].name
}

export function isAppId(value: unknown): value is AppId {
  return typeof value === 'string' && (APP_IDS as readonly string[]).includes(value)
}
