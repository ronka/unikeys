import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { X } from 'lucide-react'

import { CATALOGUE, actionById } from '@shared/catalogue'
import { type AppId } from '@shared/apps'
import { parseCanonical, type Chord } from '@shared/chord'
import {
  isHealthProblem,
  type AppStatus,
  type GrantOutcome,
  type ImportResult,
  type WriteResult
} from '@shared/ipc'
import { buildSaveEntry } from '@shared/history/entry'
import { describeRevert, planRevert } from '@shared/history/revert'
import type { HistoryEntry, NewHistoryEntry } from '@shared/history/types'
import {
  canMatchWithoutWinner,
  createTableReducer,
  createTableState,
  hasPendingChanges,
  matchCandidates,
  pendingChanges,
  plannedCopy,
  type ImportedBinding,
  type MatchCandidate
} from '@shared/table/reducer'
import { savedCells } from '@shared/table/save-outcome'
import { isCellUnseen, type Store } from '@shared/store/types'
import { buildTableView, summarizeImport } from '@shared/table/view'
import { type EditTarget } from './components/KeysTable'
import {
  CopyBindingsPrompt,
  ImportSummaryPanel,
  MatchRowPrompt,
  PendingChangesPrompt,
  WriteReport
} from './components/Panels'
import { AppShell, type View } from './components/AppShell'
import { OnboardingWizard } from './components/OnboardingWizard'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { AppsPage } from './pages/AppsPage'
import { HistoryPage } from './pages/HistoryPage'
import { KeysControls, KeysPage } from './pages/KeysPage'
import { SettingsPage } from './pages/SettingsPage'

/**
 * What is left in modals after the sidebar took over navigation. Two are the
 * result of an action the user just took, not places they can go; the third —
 * the pending review — is a step inside the save rather than a destination, and
 * reads better next to the button than behind a nav item.
 *
 * One value for all of them, so only ever one of them is on screen.
 */
type Overlay = 'none' | 'pending' | 'summary' | 'write-report' | 'onboarding'

/**
 * What an import is allowed to change, judged against the given store: only
 * cells it has no entry for at all. Shared by the startup import and the
 * wizard's re-import, so the backfill rule cannot fork — and a chord unikeys
 * cannot parse is dropped rather than stored as a value nothing downstream
 * could render or write.
 */
function mapImported(imported: ImportResult, store: Store): ImportedBinding[] {
  return imported.chords.flatMap((entry) => {
    if (!isCellUnseen(store, entry.actionId, entry.app)) return []
    const chord = entry.chord === null ? null : parseCanonical(entry.chord)
    if (entry.chord !== null && chord === null) return []
    return [
      {
        actionId: entry.actionId,
        app: entry.app,
        chord,
        origin: entry.origin === 'default' ? ('default' as const) : ('imported' as const)
      }
    ]
  })
}

function App(): React.JSX.Element {
  // The catalogue is static shipped data, so the renderer imports it directly
  // rather than waiting on IPC — there is no state in which it is absent.
  const reducer = useMemo(() => createTableReducer(CATALOGUE), [])
  const [state, dispatch] = useReducer(reducer, undefined, () => createTableState())

  const [statuses, setStatuses] = useState<AppStatus[]>([])
  const [backupDirectory, setBackupDirectory] = useState('')
  /**
   * Whether this build runs under App Sandbox, and so whether granting a folder
   * is a thing the user can be asked to do at all. Defaults to `false` so the
   * Apps page never flashes a "Grant access…" button in the dmg build during
   * the moment before `load` returns.
   */
  const [sandboxed, setSandboxed] = useState(false)
  /**
   * Why the last grant attempt was refused, keyed by app. Held here rather than
   * on `AppStatus` because it is the outcome of something the user just did,
   * not a property of their machine — a re-read of every app would otherwise
   * wipe it before they had finished reading it.
   */
  const [grantErrors, setGrantErrors] = useState<Partial<Record<AppId, string>>>({})
  const [search, setSearch] = useState('')
  const [appFilter, setAppFilter] = useState<AppId | null>(null)
  const [editing, setEditing] = useState<EditTarget | null>(null)
  // `page`, not `view` — `view` below is the memoised table view, which is
  // threaded through the table, the filter and the counts.
  const [page, setPage] = useState<View>('keys')
  const [overlay, setOverlay] = useState<Overlay>('none')
  /** The row whose apps disagree, while the pick-a-chord dialog is up. */
  const [matching, setMatching] = useState<{
    actionId: string
    candidates: MatchCandidate[]
  } | null>(null)
  /** The app whose bindings are being handed to others, while the picker is up. */
  const [copying, setCopying] = useState<AppId | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [writeResult, setWriteResult] = useState<WriteResult | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Separate from `error`: what a revert could not put back is worth saying, but
  // it is the tool reporting its limits, not something having gone wrong.
  const [notice, setNotice] = useState<string | null>(null)

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
        setSandboxed(result.sandboxed)
        dispatch({ type: 'hydrate', store: result.store })

        // Its own request, and its own failure: the log is a record of the past,
        // so a damaged one is worth reporting but must not stop unikeys opening.
        void window.unikeys
          .loadHistory()
          .then((loaded) => {
            if (cancelled) return
            setHistory(loaded.entries)
            if (loaded.error) setNotice(`Could not read the save history: ${loaded.error}`)
          })
          .catch((cause: Error) => {
            if (!cancelled) setNotice(`Could not read the save history: ${cause.message}`)
          })

        const firstRun = !result.store.firstRunCompleted
        // Read off the raw load, before any dispatch: the import below forces
        // `firstRunCompleted` on, so only this moment can tell a genuinely
        // un-onboarded store apart from one mid-way through its first launch.
        const needsOnboarding = !result.store.onboardingCompleted

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
            bindings: mapImported(imported, result.store),
            markFirstRunCompleted: true
          }
        })
        if (needsOnboarding) {
          setImportResult(imported)
          setOverlay('onboarding')
        } else if (firstRun) {
          // The summary reports on the whole table, which only tells the truth
          // on a real first run. Reachable without onboarding only through a
          // hand-edited store, but that is exactly the state it still covers.
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

  // App configuration is part of the saved store rather than a pending edit —
  // switching an app off is not something you review before saving — so it is
  // persisted as it changes.
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
  // the normal state of any machine that does not run all thirteen. Only apps
  // that are present but unreadable belong in the banner; `isHealthProblem`
  // draws that line once, so this and the Apps page cannot disagree about it.
  const unreadable = useMemo(
    () => statuses.filter((s) => s.enabled && isHealthProblem(s.health)),
    [statuses]
  )

  /**
   * Which apps the unreadable banner was dismissed for, so dismissing it is an
   * answer to what it said rather than a promise never to mention apps again. A
   * different set of apps is a different problem, and says so.
   */
  const unreadableApps = unreadable.map((status) => status.app).join(',')
  const [dismissedUnreadable, setDismissedUnreadable] = useState<string | null>(null)

  const view = useMemo(
    () => buildTableView(state, CATALOGUE, { search, appFilter: appFilter ?? undefined }),
    [state, search, appFilter]
  )
  const changes = useMemo(() => pendingChanges(state, CATALOGUE), [state])

  const dirty = hasPendingChanges(state)
  const pendingCount = changes.length

  const handleCommit = (target: EditTarget, chord: Chord | null): void => {
    dispatch(
      chord === null
        ? { type: 'clearChord', actionId: target.actionId, app: target.app }
        : { type: 'setChord', actionId: target.actionId, app: target.app, chord }
    )
    setEditing(null)
  }

  // Shared by the Apps page and the onboarding wizard, so the wizard's grant
  // button and the card's cannot drift apart. Returns the outcome because the
  // wizard advances or stays on it; the Apps page ignores the return value.
  const handleGrant = async (app: AppId, at?: string): Promise<GrantOutcome> => {
    try {
      const outcome = await window.unikeys.requestGrant(app, at)
      if (outcome.ok) {
        // Storing the bookmark changes `state.store.apps`, which the refresh
        // effect watches — so the card re-reads itself and the "needs access"
        // state clears without anything asking it to.
        dispatch({ type: 'grantApp', app, directory: outcome.directory, grant: outcome.grant })
        // The same panel answered both halves, so both are recorded: under
        // sandbox this is the only way a config location gets set, and main
        // decided whether the folder they picked counts as an override at all.
        dispatch({ type: 'setAppConfigPath', app, path: outcome.configPath })
        setGrantErrors((previous) => ({ ...previous, [app]: undefined }))
      } else {
        // A cancelled picker is the user deciding not to, so it clears the
        // previous complaint rather than adding one.
        setGrantErrors((previous) => ({
          ...previous,
          [app]: outcome.cancelled ? undefined : outcome.error
        }))
      }
      return outcome
    } catch (cause) {
      const message = (cause as Error).message
      setGrantErrors((previous) => ({ ...previous, [app]: message }))
      return { ok: false, cancelled: false, error: message }
    }
  }

  const handleChoosePath = async (app: AppId): Promise<string | null> => {
    const path = await window.unikeys.chooseConfigPath(app)
    if (path) dispatch({ type: 'setAppConfigPath', app, path })
    return path
  }

  // The wizard's payoff: read again now that grants are in place, so the
  // results step shows the keys actually arriving. Judged against the *current*
  // store, so a cell the user has set or cleared — or that the startup import
  // already filled — is untouched; and no `markFirstRunCompleted`, because the
  // startup import owns that flag.
  const handleOnboardingReimport = async (): Promise<void> => {
    const imported = await window.unikeys.importBindings(state.store)
    setStatuses(imported.statuses)
    dispatch({
      type: 'importBindings',
      payload: { bindings: mapImported(imported, state.store) }
    })
    setImportResult(imported)
  }

  // Shared by the Apps page and the onboarding wizard, so both places an app
  // can be switched off agree about what that does to the filter.
  const handleToggleApp = (app: AppId, enabled: boolean): void => {
    // Disabling the filtered app drops its column, so the filter goes with it.
    // Clearing the state — rather than falling back at render — keeps the app
    // from silently springing back to a filter the user never reselected.
    if (!enabled && appFilter === app) setAppFilter(null)
    dispatch({ type: 'setAppEnabled', app, enabled })
  }

  const handleMatchRow = (actionId: string): void => {
    const action = actionById(actionId)
    if (!action) return

    if (canMatchWithoutWinner(state, action)) {
      dispatch({ type: 'matchRow', actionId })
      return
    }
    // The apps disagree, so the user picks the winner rather than unikeys
    // silently discarding one of their bindings.
    setMatching({ actionId, candidates: matchCandidates(state, action) })
  }

  // Recording must never be able to cost the user a save: it runs after
  // `markSaved`, and a log that could not be written is a banner, not a failure.
  const record = (entry: NewHistoryEntry): void => {
    void window.unikeys
      .appendHistory(entry)
      .then(setHistory)
      .catch((cause: Error) =>
        setNotice(`Saved, but could not record it in history: ${cause.message}`)
      )
  }

  const handleSave = async (): Promise<void> => {
    if (changes.length === 0) return

    setSaving(true)
    setError(null)
    // Captured now: an edit the user makes while the write is in flight is not
    // part of this request and must not be marked saved by it. These also hold
    // the previous values a revert needs, which `markSaved` is about to
    // overwrite.
    const recorded = changes
    const sent = recorded.map((change) => ({
      actionId: change.actionId,
      app: change.app,
      chord: change.next.chord
    }))

    try {
      const result = await window.unikeys.write({ bindings: sent }, state.store)
      const entry = buildSaveEntry(recorded, { ok: true, result })
      setWriteResult(result)
      // Read off the entry itself, so the cells the table folds away are by
      // construction the ones the log says were settled.
      dispatch({ type: 'markSaved', cells: savedCells(entry.changes) })
      setOverlay('write-report')
      record(entry)
    } catch (cause) {
      const message = (cause as Error).message
      setError(`Save failed: ${message}`)
      setOverlay('none')
      // A save that threw is exactly what someone opens History to understand,
      // so it is recorded rather than left as a banner that disappears. Nothing
      // was marked saved, so every cell is reported as not written.
      record(buildSaveEntry(recorded, { ok: false, error: message }))
    } finally {
      setSaving(false)
    }
  }

  const handleRevert = (entry: HistoryEntry): void => {
    const plan = planRevert(entry)
    for (const action of plan.actions) dispatch(action)
    const notes = describeRevert(plan)

    if (plan.actions.length === 0) {
      setNotice(
        notes.length > 0
          ? `Nothing to revert: ${notes.join('; ')}.`
          : 'That save is already undone.'
      )
      return
    }

    setNotice(notes.length > 0 ? `Reverted, except: ${notes.join('; ')}.` : null)
    // Straight to the review step: a revert is a set of pending changes like any
    // other, and it reaches disk only when the user saves it.
    setOverlay('pending')
  }

  return (
    <AppShell
      page={page}
      onNavigate={setPage}
      pendingCount={pendingCount}
      dirty={dirty}
      saving={saving}
      onSave={() => void handleSave()}
      onShowPending={() => setOverlay('pending')}
      // ⌘B must not fire while a chord is being recorded or a modal is up.
      shortcutBlocked={
        editing !== null || overlay !== 'none' || matching !== null || copying !== null
      }
      controls={
        page === 'keys' ? (
          <KeysControls
            view={view}
            search={search}
            onSearchChange={setSearch}
            appFilter={appFilter}
          />
        ) : undefined
      }
      banners={
        <div className="empty:hidden shrink-0 space-y-2 px-6 pb-2">
          {error && (
            <Banner variant="destructive" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          )}

          {notice && <Banner onDismiss={() => setNotice(null)}>{notice}</Banner>}

          {unreadable.length > 0 && dismissedUnreadable !== unreadableApps && (
            <Banner
              onDismiss={() => setDismissedUnreadable(unreadableApps)}
              action={
                <Button size="xs" variant="outline" onClick={() => setPage('apps')}>
                  Open Apps to see why
                </Button>
              }
            >
              Some apps could not be read — {unreadable.map((s) => s.name).join(', ')}.
            </Banner>
          )}
        </div>
      }
    >
      {page === 'keys' && (
        <KeysPage
          view={view}
          appFilter={appFilter}
          onAppFilterChange={setAppFilter}
          onStartCopy={setCopying}
          editing={editing}
          onStartEdit={setEditing}
          onCommit={handleCommit}
          onCancelEdit={() => setEditing(null)}
          onMatchRow={handleMatchRow}
        />
      )}

      {page === 'history' && (
        <HistoryPage entries={history} chords={state.store.chords} onRevert={handleRevert} />
      )}

      {page === 'apps' && (
        <AppsPage
          statuses={statuses}
          store={state.store}
          onToggle={handleToggleApp}
          onChoosePath={(app) => void handleChoosePath(app)}
          onClearPath={(app) => {
            // Only the path. The grants are kept, because resetting the location
            // sends unikeys back to the standard one — which for the setup that
            // made a hand-picked path necessary is often a link into the very
            // folder that was granted. Dropping them here would prompt again for
            // access unikeys already has, and an unredeemed bookmark opens
            // nothing in the meantime.
            dispatch({ type: 'setAppConfigPath', app, path: null })
          }}
          sandboxed={sandboxed}
          grantErrors={grantErrors}
          onGrant={(app, at) => void handleGrant(app, at)}
        />
      )}

      {page === 'settings' && (
        <SettingsPage
          backupDirectory={backupDirectory}
          onRevealBackups={() => void window.unikeys.revealBackups()}
          onReplayOnboarding={() => {
            // Un-completing first means a quit mid-replay brings the wizard
            // back, same as a genuine first run.
            dispatch({ type: 'setOnboardingCompleted', completed: false })
            setOverlay('onboarding')
          }}
        />
      )}

      {overlay === 'pending' && (
        <PendingChangesPrompt
          changes={changes}
          saving={saving}
          // Closed first, deliberately: `handleSave` only reaches for the write
          // report after its `await`, so the two dialogs never swap places in a
          // single commit — which leaves Radix's body lock behind.
          onSave={() => {
            setOverlay('none')
            void handleSave()
          }}
          onDiscard={() => {
            dispatch({ type: 'discardPending' })
            setOverlay('none')
          }}
          onClose={() => setOverlay('none')}
        />
      )}

      {overlay === 'onboarding' && (
        <OnboardingWizard
          statuses={statuses}
          store={state.store}
          sandboxed={sandboxed}
          summary={summarizeImport(state, CATALOGUE)}
          result={importResult}
          onSetAppEnabled={handleToggleApp}
          onGrant={handleGrant}
          onChoosePath={handleChoosePath}
          onReimport={handleOnboardingReimport}
          onComplete={() => {
            dispatch({ type: 'setOnboardingCompleted', completed: true })
            setOverlay('none')
          }}
          // Dismissing leaves the store untouched, so the wizard comes back on
          // the next launch — quitting mid-setup is not finishing it.
          onDismiss={() => setOverlay('none')}
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

      {matching && (
        <MatchRowPrompt
          actionName={actionById(matching.actionId)?.name ?? matching.actionId}
          candidates={matching.candidates}
          onChoose={(chord) => {
            dispatch({ type: 'matchRow', actionId: matching.actionId, winningChord: chord })
            setMatching(null)
          }}
          onClose={() => setMatching(null)}
        />
      )}

      {copying && (
        <CopyBindingsPrompt
          from={copying}
          // The columns on screen, minus the source. A disabled app has no
          // column, so offering it would copy into something the user cannot
          // see the result in.
          candidates={view.apps.filter((app) => app !== copying)}
          changeCount={(to) => plannedCopy(state, CATALOGUE, copying, to).length}
          onCopy={(to) => {
            dispatch({ type: 'copyBindings', from: copying, to })
            setCopying(null)
            // Straight to the review step, like a revert: a copy this wide is
            // worth reading before it reaches anyone's config.
            setOverlay('pending')
          }}
          onClose={() => setCopying(null)}
        />
      )}
    </AppShell>
  )
}

/**
 * A banner above the page, and the ✕ that puts it away.
 *
 * Every one of these is something unikeys wants to say once — a failure, a
 * limit it hit, a config it could not read — rather than a state of the app,
 * so every one of them can be dismissed. What dismissing *means* is the
 * caller's business: an error is gone for good, while the unreadable-apps
 * banner comes back the moment a different app breaks.
 */
function Banner({
  variant,
  onDismiss,
  action,
  children
}: {
  variant?: 'destructive'
  onDismiss: () => void
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Alert variant={variant}>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        <span className="flex-1">{children}</span>
        {action}
        <Button size="xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
          <X />
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export default App
