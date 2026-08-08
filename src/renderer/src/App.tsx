import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { CATALOGUE, actionById } from '@shared/catalogue'
import { type AppId } from '@shared/apps'
import { parseCanonical, type Chord } from '@shared/chord'
import type { AppStatus, ImportResult, WriteResult } from '@shared/ipc'
import type { CellRef } from '@shared/table/reducer'
import {
  canLinkWithoutWinner,
  createTableReducer,
  createTableState,
  effectiveLinked,
  hasPendingChanges,
  linkCandidates,
  pendingChanges,
  pendingLinkChanges,
  propagationTargets,
  type LinkCandidate
} from '@shared/table/reducer'
import { isCellUnseen } from '@shared/store/types'
import { buildTableView, summarizeImport } from '@shared/table/view'
import { type EditTarget } from './components/KeysTable'
import { ImportSummaryPanel, LinkPrompt, WriteReport } from './components/Panels'
import { AppShell, type View } from './components/AppShell'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { AppsPage } from './pages/AppsPage'
import { KeysPage } from './pages/KeysPage'
import { PendingPage } from './pages/PendingPage'
import { SettingsPage } from './pages/SettingsPage'

/**
 * What is left in modals after the sidebar took over navigation: both are the
 * result of an action the user just took, not places they can go, so neither
 * belongs in the nav.
 */
type Overlay = 'none' | 'summary' | 'write-report'

function App(): React.JSX.Element {
  // The catalogue is static shipped data, so the renderer imports it directly
  // rather than waiting on IPC — there is no state in which it is absent.
  const reducer = useMemo(() => createTableReducer(CATALOGUE), [])
  const [state, dispatch] = useReducer(reducer, undefined, () => createTableState())

  const [statuses, setStatuses] = useState<AppStatus[]>([])
  const [backupDirectory, setBackupDirectory] = useState('')
  const [search, setSearch] = useState('')
  const [appFilter, setAppFilter] = useState<AppId | 'all'>('all')
  const [editing, setEditing] = useState<EditTarget | null>(null)
  // `page`, not `view` — `view` below is the memoised table view, which is
  // threaded through the table, the filter and the counts.
  const [page, setPage] = useState<View>('keys')
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
    // StrictMode double-invokes effects, and a second startup landing after the
    // first would drop any pending edits via `hydrate`. The flag makes the
    // later run a no-op rather than a rerun.
    let cancelled = false

    void (async () => {
      try {
        const result = await window.unikeys.load()
        if (cancelled) return
        setStatuses(result.statuses)
        setBackupDirectory(result.backupDirectory)
        dispatch({ type: 'hydrate', store: result.store })

        const firstRun = !result.store.firstRunCompleted

        // Import runs on every launch, and writes only into cells the store has
        // no entry for. That one rule covers everything that would otherwise
        // never appear: a column unikeys gained in an update, a row added to the
        // catalogue, a default an adapter only learned about later. It cannot
        // touch a cell the user has set or deliberately cleared, because those
        // already have an entry — so re-reading costs a few small config files
        // and changes nothing until there is genuinely something new to fill.
        const imported = await window.unikeys.importBindings(result.store)
        if (cancelled) return
        setStatuses(imported.statuses)
        dispatch({
          type: 'importBindings',
          payload: {
            bindings: imported.chords.flatMap((entry) => {
              if (!isCellUnseen(result.store, entry.actionId, entry.app)) return []
              const chord = entry.chord === null ? null : parseCanonical(entry.chord)
              // A chord unikeys cannot parse is dropped rather than stored as
              // a value nothing downstream could render or write.
              if (entry.chord !== null && chord === null) return []
              return [
                {
                  actionId: entry.actionId,
                  app: entry.app,
                  chord,
                  origin: entry.origin === 'default' ? ('default' as const) : ('imported' as const)
                }
              ]
            }),
            markFirstRunCompleted: true
          }
        })
        // The summary reports on the whole table, which only tells the truth
        // on a real first run.
        if (firstRun) {
          setImportResult(imported)
          setOverlay('summary')
        }
      } catch (cause) {
        setError(`Could not start up: ${(cause as Error).message}`)
      } finally {
        loaded.current = true
      }
    })()

    return () => {
      cancelled = true
    }
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

  // App health depends on the app configuration, so it is re-read whenever that
  // changes — otherwise the settings panel keeps describing the previous setup.
  useEffect(() => {
    if (!loaded.current) return
    void window.unikeys
      .refreshStatuses(state.store.apps)
      .then(setStatuses)
      .catch(() => {
        // A failed refresh leaves the previous statuses on screen, which is
        // better than blanking the panel; the next change retries.
      })
  }, [state.store.apps])

  // An app the user simply does not have is not a problem to warn about — it is
  // the normal state of any machine that does not run all five. Only apps that
  // are present but unreadable belong in the banner.
  const unreadable = useMemo(
    () => statuses.filter((s) => s.enabled && s.health !== 'ok' && s.health !== 'not-installed'),
    [statuses]
  )

  const view = useMemo(
    () =>
      buildTableView(state, CATALOGUE, {
        search,
        appFilter: appFilter === 'all' ? undefined : appFilter
      }),
    [state, search, appFilter]
  )
  const changes = useMemo(() => pendingChanges(state, CATALOGUE), [state])
  const linkChanges = useMemo(() => pendingLinkChanges(state, CATALOGUE), [state])

  // Link changes count too: a row that was only linked still needs saving, and
  // gating on chord edits alone made linking impossible to persist.
  const dirty = hasPendingChanges(state)
  const pendingCount = changes.length + linkChanges.length

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
    // Linking is unikeys' own state, so a row that was only linked or unlinked
    // has nothing to write. Without this it could never be saved at all, and
    // the link would be lost on restart.
    if (changes.length === 0) {
      if (linkChanges.length > 0) dispatch({ type: 'markSaved', cells: [] })
      return
    }

    setSaving(true)
    setError(null)
    // Captured now: an edit the user makes while the write is in flight is not
    // part of this request and must not be marked saved by it.
    const sent = changes.map((change) => ({
      actionId: change.actionId,
      app: change.app,
      chord: change.next.chord
    }))

    try {
      const result = await window.unikeys.write({ bindings: sent }, state.store)
      setWriteResult(result)
      dispatch({ type: 'markSaved', cells: savedCells(sent, result) })
      setOverlay('write-report')
    } catch (cause) {
      setError(`Save failed: ${(cause as Error).message}`)
      setOverlay('none')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppShell
      page={page}
      onNavigate={setPage}
      pendingCount={pendingCount}
      dirty={dirty}
      saving={saving}
      onSave={() => void handleSave()}
      // ⌘B must not fire while a chord is being recorded or a modal is up.
      shortcutBlocked={editing !== null || overlay !== 'none' || linking !== null}
      banners={
        <div className="empty:hidden shrink-0 space-y-2 px-6 pb-2">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {unreadable.length > 0 && (
            <Alert>
              <AlertDescription className="flex flex-wrap items-center gap-2">
                <span>
                  Some apps could not be read — {unreadable.map((s) => s.name).join(', ')}.
                </span>
                <Button size="xs" variant="outline" onClick={() => setPage('apps')}>
                  Open Apps to see why
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </div>
      }
    >
      {page === 'keys' && (
        <KeysPage
          view={view}
          search={search}
          onSearchChange={setSearch}
          appFilter={appFilter}
          onAppFilterChange={setAppFilter}
          editing={editing}
          onStartEdit={setEditing}
          onCommit={handleCommit}
          onCancelEdit={() => setEditing(null)}
          onToggleLink={handleToggleLink}
          propagationTargets={targetsFor}
        />
      )}

      {page === 'pending' && (
        <PendingPage
          changes={changes}
          linkChanges={linkChanges}
          saving={saving}
          onSave={() => void handleSave()}
          onDiscard={() => {
            dispatch({ type: 'discardPending' })
            setPage('keys')
          }}
        />
      )}

      {page === 'apps' && (
        <AppsPage
          statuses={statuses}
          store={state.store}
          onToggle={(app, enabled) => {
            // Disabling the filtered app drops its column, so the filter
            // goes with it. Clearing the state — rather than falling back
            // at render — keeps the app from silently springing back to a
            // filter the user never reselected.
            if (!enabled && appFilter === app) setAppFilter('all')
            dispatch({ type: 'setAppEnabled', app, enabled })
          }}
          onChoosePath={(app) => {
            void window.unikeys.chooseConfigPath(app).then((path) => {
              if (path) dispatch({ type: 'setAppConfigPath', app, path })
            })
          }}
          onClearPath={(app) => dispatch({ type: 'setAppConfigPath', app, path: null })}
        />
      )}

      {page === 'settings' && (
        <SettingsPage
          backupDirectory={backupDirectory}
          onRevealBackups={() => void window.unikeys.revealBackups()}
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
    </AppShell>
  )
}

/**
 * Exactly the cells that reached disk.
 *
 * A cell counts as saved when its app was written and the adapter did not skip
 * its chord, or when unikeys deliberately declined to write it (the app is off,
 * or the catalogue maps no command). Everything else — a failed app, an
 * inexpressible chord, an unreadable stored chord — stays pending so the user
 * can see it and retry.
 */
function savedCells(sent: readonly CellRef[], result: WriteResult): CellRef[] {
  const writtenApps = new Set(result.written.map((app) => app.app))
  const key = (ref: CellRef): string => `${ref.actionId}\u0000${ref.app}`

  const settled = new Set(result.dropped.filter((drop) => drop.deliberate).map((drop) => key(drop)))
  const unexpressible = new Set(result.skipped.map((skip) => key(skip)))

  return sent.filter(
    (cell) => (writtenApps.has(cell.app) && !unexpressible.has(key(cell))) || settled.has(key(cell))
  )
}

export default App
