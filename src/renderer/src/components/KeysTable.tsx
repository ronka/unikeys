import type { AppId } from '@shared/apps'
import { APPS } from '@shared/apps'
import type { Chord } from '@shared/chord'
import type { CellState, RowView, TableView } from '@shared/table/view'
import { ChordInput } from './ChordInput'

export interface EditTarget {
  actionId: string
  app: AppId
}

interface Props {
  view: TableView
  editing: EditTarget | null
  onStartEdit: (target: EditTarget) => void
  onCommit: (target: EditTarget, chord: Chord | null) => void
  onCancelEdit: () => void
  onToggleLink: (actionId: string) => void
  /** Every app a linked row's edit will reach, for expressibility warnings. */
  propagationTargets: (actionId: string) => AppId[]
}

export function KeysTable({
  view,
  editing,
  onStartEdit,
  onCommit,
  onCancelEdit,
  onToggleLink,
  propagationTargets
}: Props): React.JSX.Element {
  if (view.rowCount === 0) {
    return <p className="empty-state">No actions match your filters.</p>
  }

  return (
    <table className="keys-table">
      <thead>
        <tr>
          <th className="action-head">Action</th>
          <th className="link-head">Link</th>
          {view.apps.map((app) => (
            <th key={app}>{APPS[app].name}</th>
          ))}
        </tr>
      </thead>

      {view.groups.map((group) => (
        <tbody key={group.category}>
          <tr className="category-row">
            {/* The `+ 2` is the two leading columns, not the app count. The
                label is wrapped so it can stay pinned to the left edge while
                the app columns scroll out from under this full-width cell. */}
            <th colSpan={view.apps.length + 2}>
              <span className="category-label">{group.label}</span>
            </th>
          </tr>
          {group.rows.map((row) => (
            <Row
              key={row.action.id}
              row={row}
              apps={view.apps}
              editing={editing}
              onStartEdit={onStartEdit}
              onCommit={onCommit}
              onCancelEdit={onCancelEdit}
              onToggleLink={onToggleLink}
              propagationTargets={propagationTargets}
            />
          ))}
        </tbody>
      ))}
    </table>
  )
}

function Row({
  row,
  apps,
  editing,
  onStartEdit,
  onCommit,
  onCancelEdit,
  onToggleLink,
  propagationTargets
}: Omit<Props, 'view'> & { row: RowView; apps: AppId[] }): React.JSX.Element {
  // Agreement is the quiet state and divergence is the one worth finding, so
  // only the row marker differs — the cells themselves stay unstyled.
  const className = [
    row.divergent ? 'row-divergent' : 'row-agree',
    row.hasPending ? 'row-pending' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <tr className={className}>
      <td className="action-cell">
        <span className="action-name">{row.action.name}</span>
        <span className="action-id">{row.action.id}</span>
      </td>

      <td className="link-cell">
        <button
          type="button"
          className={`link-button${row.linked ? ' linked' : ''}`}
          aria-pressed={row.linked}
          title={
            row.linked
              ? 'Linked — editing any cell updates every mapped app'
              : 'Link this row so every mapped app shares one chord'
          }
          onClick={() => onToggleLink(row.action.id)}
        >
          {row.linked ? '⛓ Linked' : 'Link'}
        </button>
      </td>

      {apps.map((app, index) => {
        const cell = row.cells[app]
        const isEditing = editing?.actionId === row.action.id && editing.app === app

        return (
          <td key={app} className={`cell${isEditing ? ' cell-editing' : ''}`}>
            {/* The cell stays mounted while editing so the column keeps its width
                and the row its height; the editor floats above it rather than
                shoving every other column sideways. */}
            <div className="cell-content" inert={isEditing}>
              <Cell
                cell={cell}
                onEdit={() => onStartEdit({ actionId: row.action.id, app })}
                appName={APPS[app].name}
                actionName={row.action.name}
              />
            </div>
            {isEditing && (
              // The last column opens leftwards so the editor stays inside the
              // table's right edge rather than hanging off the end of it.
              <div className={`chord-popover${index === apps.length - 1 ? ' align-right' : ''}`}>
                <ChordInput
                  value={cell?.kind === 'bound' ? cell.chord : null}
                  targets={row.linked ? propagationTargets(row.action.id) : [app]}
                  onCommit={(chord) => onCommit({ actionId: row.action.id, app }, chord)}
                  onCancel={onCancelEdit}
                />
              </div>
            )}
          </td>
        )
      })}
    </tr>
  )
}

function Cell({
  cell,
  onEdit,
  appName,
  actionName
}: {
  cell: CellState | undefined
  onEdit: () => void
  appName: string
  actionName: string
}): React.JSX.Element | null {
  if (cell === undefined) return null

  // Not-applicable is not clickable: there is no command to bind to, so
  // offering an edit would promise something unikeys cannot deliver.
  if (cell.kind === 'not-applicable') {
    return (
      <span className="cell-na-mark" title={`${appName} has no equivalent for ${actionName}`}>
        —
      </span>
    )
  }

  const classes = ['cell-button']
  if (cell.pending) classes.push('cell-pending')
  if (cell.kind === 'unbound') classes.push('cell-unbound')
  else classes.push(cell.origin === 'default' ? 'cell-default' : 'cell-user')

  return (
    <button
      type="button"
      className={classes.join(' ')}
      onClick={onEdit}
      aria-label={`${actionName} in ${appName}`}
    >
      {cell.kind === 'bound' ? (
        <>
          <span className="chord">{cell.display}</span>
          {/* Origin is what explains why the apps diverged in the first place. */}
          {cell.origin === 'default' && (
            <span className="origin-mark" title="This app's shipped default">
              def
            </span>
          )}
        </>
      ) : (
        <span className="chord">not bound</span>
      )}
    </button>
  )
}
