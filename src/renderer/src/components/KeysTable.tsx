import type { AppId } from '@shared/apps'
import { APPS } from '@shared/apps'
import type { Chord } from '@shared/chord'
import type { CellState, RowView, TableView } from '@shared/table/view'
import { cn } from '@/lib/utils'
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

/*
 * Sticky layering, bottom to top: the pinned action columns (z-2), then category
 * headings (z-3), then an open chord editor (z-4), then the header row (z-5),
 * then the header's own pinned corner (z-6). A pinned heading has to outrank the
 * pinned columns, or the rows sliding under it push their action name and link
 * button back through it — which reads as a half-drawn row welded below the
 * header. The editor sits above both deliberately: it opens leftwards, straight
 * over them. The whole ladder stays below z-10, which is the sidebar.
 */

/* The header is given an explicit height rather than letting padding and
   line-height produce one, because the category heading's `top` has to equal it
   exactly. As an emergent value the two drift apart the moment the base font
   changes. */
const HEAD =
  'sticky top-0 z-5 h-[33px] border-b border-input bg-card px-[10px] py-0 text-left font-semibold whitespace-nowrap text-muted-foreground'

/* Both leading columns stay put while the app columns scroll: which action a row
   is, and whether it is linked, are what make a chord four columns to the right
   mean anything.

   The width is fixed rather than a minimum so the link column's `left` offset is
   exact — under auto layout the action column's width follows its content and
   the two would drift apart. */
const ACTION_COL = 'w-[240px] min-w-[240px] left-0'
const LINK_COL = 'left-[240px]'

/* Opaque backgrounds, the row tint and the divergence markers live in
   `@layer utilities` in main.css — see the note there. They cannot be utilities
   on these elements because they compose with each other by specificity, which
   is also why `action-cell` and `link-cell` stay as real class names: the CSS
   has to tell the two apart, since only the action cell carries the divergence
   marker and only the link cell carries the end-of-pinned-columns separator. */
const PINNED_CELL = 'sticky z-2 border-b border-border'

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
    return <p className="text-muted-foreground p-10 text-center">No actions match your filters.</p>
  }

  return (
    /* The app columns are allowed to overrun the window and scroll sideways, so
       the table takes its content's width and only stretches to fill when there
       is room to spare. Squeezing five columns into the viewport instead would
       make every chord fight for space.

       `border-separate` rather than collapsed: collapsed borders belong to the
       table, not the cell, so they do not travel with a sticky cell and the
       action column would scroll out from under its own row lines. Tailwind's
       preflight sets `border-collapse: collapse` on every table, so this is
       load-bearing, not decoration. */
    <table className="keys-table w-max min-w-full border-separate border-spacing-0 text-[13px]">
      <thead>
        <tr>
          <th className={cn(HEAD, ACTION_COL, 'z-6')}>Action</th>
          <th className={cn(HEAD, LINK_COL, 'link-head z-6')}>Link</th>
          {view.apps.map((app) => (
            <th key={app} className={HEAD}>
              {APPS[app].name}
            </th>
          ))}
        </tr>
      </thead>

      {view.groups.map((group) => (
        <tbody key={group.category}>
          <tr>
            {/* The `+ 2` is the two leading columns, not the app count. The
                label is wrapped so it can stay pinned to the left edge while
                the app columns scroll out from under this full-width cell. */}
            <th
              colSpan={view.apps.length + 2}
              className="bg-background text-faint sticky top-[33px] z-3 border-b border-border px-[10px] pt-[14px] pb-[6px] text-left text-[11px] tracking-[0.08em] uppercase"
            >
              <span className="sticky left-[10px] inline-block">{group.label}</span>
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
      {/* Extra left padding keeps the name clear of the divergence marker. */}
      <td className={cn(PINNED_CELL, ACTION_COL, 'action-cell py-[6px] pr-[10px] pl-[14px]')}>
        <span className="block">{row.action.name}</span>
        <span className="text-faint block font-mono text-[10px]">{row.action.id}</span>
      </td>

      <td
        className={cn(
          PINNED_CELL,
          LINK_COL,
          'link-cell w-[1%] px-[8px] py-[6px] whitespace-nowrap'
        )}
      >
        <button
          type="button"
          className={cn(
            'rounded-md border px-[8px] py-[2px] text-[11px]',
            row.linked
              ? 'border-primary bg-[var(--accent-dim)] text-foreground'
              : 'border-input bg-card text-foreground hover:bg-accent'
          )}
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
          <td
            key={app}
            className={cn(
              'relative min-w-[150px] border-b border-border px-[6px] py-[4px] align-middle',
              // The open editor paints over neighbouring rows — including the
              // sticky category headings and the pinned columns it opens towards.
              isEditing && 'z-4'
            )}
          >
            {/* The cell stays mounted while editing so the column keeps its width
                and the row its height; the editor floats above it rather than
                shoving every other column sideways. Dimmed rather than hidden,
                which is what keeps the table from jumping on click. */}
            <div className={isEditing ? 'opacity-25' : undefined} inert={isEditing}>
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
              <div
                className={cn(
                  'absolute top-1/2 -translate-y-1/2',
                  index === apps.length - 1 ? 'right-0 left-auto' : 'left-0'
                )}
              >
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

const CHORD = 'font-mono text-[13px] tracking-[0.02em]'

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
      <span
        className="text-faint inline-block px-[6px] py-[3px]"
        title={`${appName} has no equivalent for ${actionName}`}
      >
        —
      </span>
    )
  }

  const chordTone = cell.pending
    ? 'text-pending'
    : cell.kind === 'unbound'
      ? 'text-faint italic'
      : cell.origin === 'default'
        ? 'text-muted-foreground'
        : 'text-foreground font-semibold'

  return (
    <button
      type="button"
      className="hover:border-input hover:bg-accent flex w-full items-center gap-[6px] border border-transparent bg-transparent px-[6px] py-[3px] text-left"
      onClick={onEdit}
      aria-label={`${actionName} in ${appName}`}
    >
      {cell.kind === 'bound' ? (
        <>
          <span className={cn(CHORD, chordTone)}>{cell.display}</span>
          {/* Origin is what explains why the apps diverged in the first place,
              so it stays visible rather than hiding behind a tooltip. */}
          {cell.origin === 'default' && (
            <span
              className="text-faint rounded-[3px] border border-border px-[3px] text-[9px] tracking-[0.06em] uppercase"
              title="This app's shipped default"
            >
              def
            </span>
          )}
        </>
      ) : (
        <span className={cn(CHORD, chordTone)}>not bound</span>
      )}
    </button>
  )
}
