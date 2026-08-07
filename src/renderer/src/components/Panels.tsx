import { APPS, type AppId } from '@shared/apps'
import { formatDisplay, parseCanonical, type Chord } from '@shared/chord'
import type { DroppedBinding, ImportResult, WriteResult } from '@shared/ipc'
import type { LinkCandidate, PendingChange, PendingLinkChange } from '@shared/table/reducer'
import type { ImportSummary } from '@shared/table/view'

export function Panel({
  title,
  children,
  onClose
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="panel" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="panel-body" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pending changes
// ---------------------------------------------------------------------------

/**
 * Everything that is about to be written to real config files. Shown before
 * saving so the decision is informed rather than a leap of faith.
 */
export function PendingChanges({
  changes,
  linkChanges,
  onSave,
  onDiscard,
  onClose,
  saving
}: {
  changes: PendingChange[]
  linkChanges: PendingLinkChange[]
  onSave: () => void
  onDiscard: () => void
  onClose: () => void
  saving: boolean
}): React.JSX.Element {
  return (
    <Panel title="Pending changes" onClose={onClose}>
      {changes.length === 0 && linkChanges.length === 0 ? (
        <p className="muted">Nothing has changed since the last save.</p>
      ) : (
        <>
          {changes.length > 0 && (
            <table className="changes-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>App</th>
                  <th>From</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={`${change.actionId}:${change.app}`}>
                    <td>{change.actionName}</td>
                    <td>{APPS[change.app].name}</td>
                    <td className="from">{describe(change.previous?.chord ?? null)}</td>
                    <td className="to">{describe(change.next.chord)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {linkChanges.length > 0 && (
            <ul>
              {linkChanges.map((change) => (
                <li key={change.actionId}>
                  {change.actionName} — {change.linked ? 'linked' : 'unlinked'}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="panel-actions">
        <button type="button" onClick={onDiscard} disabled={saving}>
          Discard all
        </button>
        <button type="button" onClick={onClose}>
          Keep editing
        </button>
        <button
          type="button"
          className="primary"
          onClick={onSave}
          disabled={saving || (changes.length === 0 && linkChanges.length === 0)}
        >
          {saving ? 'Saving…' : 'Save to apps'}
        </button>
      </div>
    </Panel>
  )
}

function describe(canonical: string | null): string {
  if (canonical === null) return 'not bound'
  const chord = parseCanonical(canonical)
  return chord ? formatDisplay(chord) : canonical
}

// ---------------------------------------------------------------------------
// Choosing a winning chord when linking a divergent row
// ---------------------------------------------------------------------------

/**
 * Linking a row whose apps disagree asks which chord wins. The reducer never
 * picks, because silently choosing would discard the binding the user actually
 * wanted.
 */
export function LinkPrompt({
  actionName,
  candidates,
  onChoose,
  onClose
}: {
  actionName: string
  candidates: LinkCandidate[]
  onChoose: (chord: Chord | null) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Panel title={`Link “${actionName}”`} onClose={onClose}>
      <p>These apps currently disagree. Which chord should they all use?</p>
      <ul className="settings-list">
        {candidates.map((candidate, i) => (
          <li key={i} className="settings-app">
            <div className="settings-app-main">
              <span className="chord">
                {candidate.chord ? formatDisplay(candidate.chord) : 'not bound'}
              </span>
              <button type="button" className="primary" onClick={() => onChoose(candidate.chord)}>
                Use this
              </button>
            </div>
            <p className="settings-path">
              {candidate.apps.map((app) => APPS[app].name).join(', ')}
            </p>
          </li>
        ))}
      </ul>
      <div className="panel-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// First-run import summary
// ---------------------------------------------------------------------------

export function ImportSummaryPanel({
  summary,
  result,
  onClose
}: {
  summary: ImportSummary
  result: ImportResult
  onClose: () => void
}): React.JSX.Element {
  return (
    <Panel title="Imported your keybindings" onClose={onClose}>
      <div className="summary-stats">
        <div className="summary-stat">
          <strong>{summary.actionsFound}</strong>
          <span>actions</span>
        </div>
        <div className="summary-stat">
          <strong>{result.appsRead}</strong>
          <span>apps read</span>
        </div>
        <div className="summary-stat">
          <strong>{summary.divergentRows}</strong>
          <span>rows where your apps disagree</span>
        </div>
      </div>

      {result.appsFailed.length > 0 && (
        <div className="summary-failed">
          <p>unikeys could not read:</p>
          <ul>
            {result.appsFailed.map((failure) => (
              <li key={failure.app}>
                <strong>{failure.name}</strong> — {failure.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="muted">Nothing was written to your apps. Start with the highlighted rows.</p>

      <div className="panel-actions">
        <button type="button" className="primary" onClick={onClose}>
          Show me the table
        </button>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// What a save actually did
// ---------------------------------------------------------------------------

/**
 * One line per app and reason rather than one per binding. A save that touches
 * ten linked rows drops ten bindings for an app the user does not have, and
 * listing each of them by raw action id buries the one thing worth reading.
 */
function groupDropped(
  dropped: readonly DroppedBinding[]
): Array<{ key: string; app: AppId; reason: string; actionIds: string[] }> {
  const groups = new Map<string, { key: string; app: AppId; reason: string; actionIds: string[] }>()
  for (const drop of dropped) {
    const key = `${drop.app}\u0000${drop.reason}`
    const group = groups.get(key) ?? { key, app: drop.app, reason: drop.reason, actionIds: [] }
    group.actionIds.push(drop.actionId)
    groups.set(key, group)
  }
  return [...groups.values()]
}

export function WriteReport({
  result,
  onClose
}: {
  result: WriteResult
  onClose: () => void
}): React.JSX.Element {
  const partial = result.failed.length > 0 && result.written.length > 0

  return (
    <Panel title={partial ? 'Saved, but not everywhere' : 'Saved'} onClose={onClose}>
      {result.written.length > 0 && (
        <>
          <p>Written:</p>
          <ul>
            {result.written.map((app) => (
              <li key={app.app}>
                <strong>{app.name}</strong> — <code>{app.path}</code>
                {app.backupPath && (
                  <>
                    <br />
                    <span className="muted">
                      Backed up to <code>{app.backupPath}</code>
                    </span>
                  </>
                )}
                <br />
                <span className="muted">{app.reloadHint}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {result.failed.length > 0 && (
        <div className="summary-failed">
          <p>Not written:</p>
          <ul>
            {result.failed.map((app) => (
              <li key={app.app}>
                <strong>{app.name}</strong> — {app.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.skipped.length > 0 && (
        <div className="summary-failed">
          <p>Chords these apps cannot express, so they were not written:</p>
          <ul>
            {result.skipped.map((skip, i) => (
              <li key={i}>
                <strong>{APPS[skip.app].name}</strong> — {skip.actionId}: {skip.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.dropped.length > 0 && (
        // Not styled as a failure: a deliberate drop is unikeys doing the right
        // thing — an app is turned off, or is not installed. Only the
        // non-deliberate ones are worth alarming the user about, and those are
        // rare enough not to warrant a second list.
        <div
          className={result.dropped.some((drop) => !drop.deliberate) ? 'summary-failed' : 'muted'}
        >
          <p>Not attempted:</p>
          <ul>
            {groupDropped(result.dropped).map((group) => (
              <li key={group.key}>
                <strong>{APPS[group.app].name}</strong>
                {group.actionIds.length === 1 ? ` — ${group.actionIds[0]}` : ''}: {group.reason}
                {group.actionIds.length > 1 && ` (${group.actionIds.length} bindings)`}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="muted">
        Backups live in <code>{result.backupDirectory}</code>
      </p>

      <div className="panel-actions">
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Panel>
  )
}
