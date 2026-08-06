import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { CATALOGUE, actionById } from '@shared/catalogue'
import type { AppId } from '@shared/apps'
import { parseCanonical, type Chord } from '@shared/chord'
import type { AppStatus, ImportResult, WriteResult } from '@shared/ipc'
import {
  canLinkWithoutWinner,
  createTableReducer,
  createTableState,
  effectiveLinked,
  linkCandidates,
  pendingChanges,
  pendingLinkChanges,
  propagationTargets,
  type LinkCandidate
} from '@shared/table/reducer'
import { buildTableView, summarizeImport } from '@shared/table/view'
import { AppSettings } from './components/AppSettings'
import { KeysTable, type EditTarget } from './components/KeysTable'
import { ImportSummaryPanel, LinkPrompt, PendingChanges, WriteReport } from './components/Panels'

type Overlay = 'none' | 'settings' | 'pending' | 'summary' | 'write-report'

function App(): React.JSX.Element {
  // The catalogue is static shipped data, so the renderer imports it directly
  // rather than waiting on IPC — there is no state in which it is absent.
  const reducer = useMemo(() => createTableReducer(CATALOGUE), [])
  const [state, dispatch] = useReducer(reducer, undefined, () => createTableState())

  const [statuses, setStatuses] = useState<AppStatus[]>([])
  const [backupDirectory, setBackupDirectory] = useState('')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [linking, setLinking] = useState<{ actionId: string; candidates: LinkCandidate[] } | null>(
    null
  )
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [writeResult, setWriteResult] = useState<WriteResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Persisting is skipped until the first load has landed, so an empty initial
  // state can never overwrite a real store on disk.
  const loaded = useRef(false)

  useEffect(() => {
    void (async () => {
      try {
        const result = await window.unikeys.load()
        setStatuses(result.statuses)
        setBackupDirectory(result.backupDirectory)
        dispatch({ type: 'hydrate', store: result.store })

        if (!result.store.firstRunCompleted) {
          const imported = await window.unikeys.importBindings(result.store)
          setStatuses(imported.statuses)
          setImportResult(imported)
          dispatch({
            type: 'importBindings',
            payload: {
              bindings: imported.chords.flatMap((entry) => {
                const chord = entry.chord === null ? null : parseCanonical(entry.chord)
                // A chord unikeys cannot parse is dropped rather than stored as
                // a value nothing downstream could render or write.
                if (entry.chord !== null && chord === null) return []
                return [
                  {
                    actionId: entry.actionId,
                    app: entry.app,
                    chord,
                    origin:
                      entry.origin === 'default' ? ('default' as const) : ('imported' as const)
                  }
                ]
              }),
              markFirstRunCompleted: true
            }
          })
          setOverlay('summary')
        }
      } catch (cause) {
        setError(`Could not start up: ${(cause as Error).message}`)
      } finally {
        loaded.current = true
      }
    })()
  }, [])

  // Linked rows and app configuration are part of the saved store, so they are
  // persisted as they change — that is what makes unikeys a sync tool rather
  // than a one-off bulk edit.
  useEffect(() => {
    if (!loaded.current) return
    void window.unikeys.persistStore(state.store).catch((cause: Error) => {
      setError(`Could not save unikeys' own state: ${cause.message}`)
    })
  }, [state.store])

  const view = useMemo(() => buildTableView(state, CATALOGUE, { search }), [state, search])
  const changes = useMemo(() => pendingChanges(state, CATALOGUE), [state])
  const linkChanges = useMemo(() => pendingLinkChanges(state, CATALOGUE), [state])

  const targetsFor = useCallback((actionId: string): AppId[] => {
    const action = actionById(actionId)
    return action ? propagationTargets(action) : []
  }, [])

  const handleCommit = (target: EditTarget, chord: Chord | null): void => {
    dispatch(
      chord === null
        ? { type: 'clearChord', actionId: target.actionId, app: target.app }
        : { type: 'setChord', actionId: target.actionId, app: target.app, chord }
    )
    setEditing(null)
  }

  const handleToggleLink = (actionId: string): void => {
    if (effectiveLinked(state, actionId)) {
      dispatch({ type: 'unlinkRow', actionId })
      return
    }

    const action = actionById(actionId)
    if (!action) return

    if (canLinkWithoutWinner(state, action)) {
      dispatch({ type: 'linkRow', actionId })
      return
    }
    // The apps disagree, so the user picks the winner rather than unikeys
    // silently discarding one of their bindings.
    setLinking({ actionId, candidates: linkCandidates(state, action) })
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const result = await window.unikeys.write(
        {
          bindings: changes.map((change) => ({
            actionId: change.actionId,
            app: change.app,
            chord: change.next.chord
          }))
        },
        state.store
      )
      setWriteResult(result)
      // Pending edits are folded in only for apps that actually took them;
      // if nothing was written the table must keep showing them as pending.
      if (result.written.length > 0) dispatch({ type: 'markSaved' })
      setOverlay('write-report')
    } catch (cause) {
      setError(`Save failed: ${(cause as Error).message}`)
      setOverlay('none')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <h1>unikeys</h1>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search actions…"
          aria-label="Search actions"
        />
        <span className="muted">
          {view.rowCount} rows · {view.divergentCount} diverging
        </span>
        <span className="spacer" />
        {changes.length > 0 && <span className="pending-count">{changes.length} pending</span>}
        <button type="button" onClick={() => setOverlay('pending')}>
          Review changes
        </button>
        <button
          type="button"
          className="primary"
          onClick={handleSave}
          disabled={saving || changes.length === 0}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => setOverlay('settings')}>
          Apps
        </button>
      </header>

      {error && <div className="banner banner-error">{error}</div>}

      {statuses.some((s) => s.enabled && s.health !== 'ok') && (
        <div className="banner banner-info">
          Some apps could not be read —{' '}
          {statuses
            .filter((s) => s.enabled && s.health !== 'ok')
            .map((s) => s.name)
            .join(', ')}
          . Open <strong>Apps</strong> to see why.
        </div>
      )}

      <div className="scroll">
        <KeysTable
          view={view}
          editing={editing}
          onStartEdit={setEditing}
          onCommit={handleCommit}
          onCancelEdit={() => setEditing(null)}
          onToggleLink={handleToggleLink}
          propagationTargets={targetsFor}
        />
      </div>

      {overlay === 'settings' && (
        <div className="panel" role="dialog" aria-modal="true" aria-label="Apps">
          <div className="panel-body">
            <AppSettings
              statuses={statuses}
              store={state.store}
              backupDirectory={backupDirectory}
              onToggle={(app, enabled) => dispatch({ type: 'setAppEnabled', app, enabled })}
              onChoosePath={(app) => {
                void window.unikeys.chooseConfigPath(app).then((path) => {
                  if (path) dispatch({ type: 'setAppConfigPath', app, path })
                })
              }}
              onClearPath={(app) => dispatch({ type: 'setAppConfigPath', app, path: null })}
              onRevealBackups={() => void window.unikeys.revealBackups()}
              onClose={() => setOverlay('none')}
            />
          </div>
        </div>
      )}

      {overlay === 'pending' && (
        <PendingChanges
          changes={changes}
          linkChanges={linkChanges}
          saving={saving}
          onSave={() => void handleSave()}
          onDiscard={() => {
            dispatch({ type: 'discardPending' })
            setOverlay('none')
          }}
          onClose={() => setOverlay('none')}
        />
      )}

      {overlay === 'summary' && importResult && (
        <ImportSummaryPanel
          summary={summarizeImport(state, CATALOGUE)}
          result={importResult}
          onClose={() => setOverlay('none')}
        />
      )}

      {overlay === 'write-report' && writeResult && (
        <WriteReport result={writeResult} onClose={() => setOverlay('none')} />
      )}

      {linking && (
        <LinkPrompt
          actionName={actionById(linking.actionId)?.name ?? linking.actionId}
          candidates={linking.candidates}
          onChoose={(chord) => {
            dispatch({ type: 'linkRow', actionId: linking.actionId, winningChord: chord })
            setLinking(null)
          }}
          onClose={() => setLinking(null)}
        />
      )}
    </div>
  )
}

export default App
