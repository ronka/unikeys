import { APPS, type AppId } from '@shared/apps'
import type { Chord } from '@shared/chord'
import type { TableView } from '@shared/table/view'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { KeysTable, type EditTarget } from '@/components/KeysTable'

interface Props {
  view: TableView
  search: string
  onSearchChange: (search: string) => void
  appFilter: AppId | 'all'
  onAppFilterChange: (app: AppId | 'all') => void
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

        <Select
          value={appFilter}
          onValueChange={(value) => onAppFilterChange(value as AppId | 'all')}
        >
          <SelectTrigger size="sm" className="w-40" aria-label="Filter by app">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All apps</SelectItem>
            {/* The enabled columns, not `APP_IDS` — an app with no column would
                filter the table against something the user cannot see. */}
            {view.apps.map((app) => (
              <SelectItem key={app} value={app}>
                {APPS[app].name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-muted-foreground text-xs">
          {view.rowCount} rows · {view.divergentCount} diverging
        </span>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <KeysTable
          view={view}
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
