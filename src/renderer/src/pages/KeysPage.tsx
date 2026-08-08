import { APPS, type AppId } from '@shared/apps'
import type { Chord } from '@shared/chord'
import type { TableView } from '@shared/table/view'

import { Input } from '@/components/ui/input'
import { KeysTable, type EditTarget } from '@/components/KeysTable'

interface Props {
  view: TableView
  /** The app the rows are narrowed to, or `null` for every action. */
  appFilter: AppId | null
  onAppFilterChange: (app: AppId | null) => void
  onStartCopy: (app: AppId) => void
  editing: EditTarget | null
  onStartEdit: (target: EditTarget) => void
  onCommit: (target: EditTarget, chord: Chord | null) => void
  onCancelEdit: () => void
  onToggleLink: (actionId: string) => void
  propagationTargets: (actionId: string) => AppId[]
}

/**
 * The table, full height. What narrows it lives in `KeysControls`, which the
 * shell renders in its own top row — see the note there.
 */
export function KeysPage({
  view,
  appFilter,
  onAppFilterChange,
  onStartCopy,
  editing,
  onStartEdit,
  onCommit,
  onCancelEdit,
  onToggleLink,
  propagationTargets
}: Props): React.JSX.Element {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
      <KeysTable
        view={view}
        appFilter={appFilter}
        onAppFilterChange={onAppFilterChange}
        onStartCopy={onStartCopy}
        editing={editing}
        onStartEdit={onStartEdit}
        onCommit={onCommit}
        onCancelEdit={onCancelEdit}
        onToggleLink={onToggleLink}
        propagationTargets={propagationTargets}
      />
    </div>
  )
}

/**
 * Search and the row counts, for the shell's top row rather than a strip of
 * its own above the table.
 *
 * They belong beside Save: both are about the table as a whole, and a row that
 * held only a search box cost the table 40px of height to say what the window
 * chrome had room for anyway. It is the one page whose controls sit up there,
 * which is why the shell takes them as a slot instead of knowing about them.
 */
export function KeysControls({
  view,
  search,
  onSearchChange,
  appFilter
}: {
  view: TableView
  search: string
  onSearchChange: (search: string) => void
  appFilter: AppId | null
}): React.JSX.Element {
  return (
    <>
      <Input
        type="text"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search actions…"
        aria-label="Search actions"
        // `no-drag`, or the strip it sits in moves the window instead of
        // taking the click.
        className="no-drag h-8 w-56"
      />

      {/* The app filter itself is the pin on each column heading. It is said
          again here because the app columns scroll sideways: pinned to the
          last of them, the rows can be narrowed by a control that has left
          the screen, and a table quietly missing rows is worse than a word. */}
      <span className="text-muted-foreground text-xs">
        {view.rowCount} rows · {view.divergentCount} diverging
        {appFilter !== null && ` · ${APPS[appFilter].name} only`}
      </span>
    </>
  )
}
