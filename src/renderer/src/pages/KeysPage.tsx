import { APPS, type AppId } from '@shared/apps'
import type { Chord } from '@shared/chord'
import type { TableView } from '@shared/table/view'

import { Input } from '@/components/ui/input'
import { KeysTable, type EditTarget } from '@/components/KeysTable'

interface Props {
  view: TableView
  search: string
  onSearchChange: (search: string) => void
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

/** The table itself, plus the controls that narrow what it shows. */
export function KeysPage({
  view,
  search,
  onSearchChange,
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
    <>
      <div className="flex shrink-0 items-center gap-3 px-4 pt-1 pb-3">
        <Input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search actions…"
          aria-label="Search actions"
          className="h-8 w-56"
        />

        {/* The app filter itself is the pin on each column heading. It is said
            again here because the app columns scroll sideways: pinned to the
            last of them, the rows can be narrowed by a control that has left
            the screen, and a table quietly missing rows is worse than a word. */}
        <span className="text-muted-foreground text-xs">
          {view.rowCount} rows · {view.divergentCount} diverging
          {appFilter !== null && ` · ${APPS[appFilter].name} only`}
        </span>
      </div>

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
    </>
  )
}
