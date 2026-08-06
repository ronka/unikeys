import { APP_IDS, type AppId } from '@shared/apps'
import type { AppHealth, AppStatus } from '@shared/ipc'
import type { Store } from '@shared/store/types'

interface Props {
  statuses: AppStatus[]
  store: Store
  backupDirectory: string
  onToggle: (app: AppId, enabled: boolean) => void
  onChoosePath: (app: AppId) => void
  onClearPath: (app: AppId) => void
  onRevealBackups: () => void
  onClose: () => void
}

/**
 * Health is deliberately spelled out rather than collapsed to "no bindings":
 * a config unikeys could not find and one it could not parse are different
 * problems with different fixes, and confusing either with an app that simply
 * has nothing bound would send the user looking in the wrong place.
 */
const HEALTH_LABELS: Record<AppHealth, string> = {
  ok: 'Ready',
  disabled: 'Turned off',
  'not-installed': 'Not installed',
  'config-not-found': 'Config not found',
  'config-unreadable': 'Config unreadable',
  'config-unparseable': 'Config could not be parsed'
}

export function AppSettings({
  statuses,
  store,
  backupDirectory,
  onToggle,
  onChoosePath,
  onClearPath,
  onRevealBackups,
  onClose
}: Props): React.JSX.Element {
  const byId = new Map(statuses.map((s) => [s.app, s]))

  return (
    <section className="settings">
      <header className="settings-header">
        <h2>Apps</h2>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </header>

      <ul className="settings-list">
        {APP_IDS.map((app) => {
          const status = byId.get(app)
          if (!status) return null
          const config = store.apps[app]

          return (
            <li key={app} className={`settings-app health-${status.health}`}>
              <div className="settings-app-main">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={config.enabled}
                    onChange={(e) => onToggle(app, e.target.checked)}
                  />
                  <span className="settings-app-name">{status.name}</span>
                </label>
                <span className={`badge badge-${status.health}`}>
                  {HEALTH_LABELS[status.health]}
                </span>
              </div>

              <p className="settings-path">
                {status.resolvedPath ?? (
                  <span className="muted">
                    Looked in: {status.searchedPaths.join(', ') || 'nowhere'}
                  </span>
                )}
              </p>

              {status.message && <p className="settings-message">{status.message}</p>}

              {status.problems.length > 0 && (
                <details className="settings-problems">
                  <summary>
                    {status.problems.length} line
                    {status.problems.length === 1 ? '' : 's'} unikeys could not read
                  </summary>
                  <ul>
                    {status.problems.map((problem, i) => (
                      <li key={i}>{problem}</li>
                    ))}
                  </ul>
                </details>
              )}

              {status.defaultsAvailability !== 'complete' && status.defaultsNote && (
                <p className="settings-note">
                  <strong>Defaults:</strong> {status.defaultsNote}
                </p>
              )}

              <div className="settings-actions">
                <button type="button" onClick={() => onChoosePath(app)}>
                  Choose config manually…
                </button>
                {config.configPath && (
                  <button type="button" onClick={() => onClearPath(app)}>
                    Use standard location
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      <footer className="settings-footer">
        <p>
          Backups are written to <code>{backupDirectory}</code>
        </p>
        <button type="button" onClick={onRevealBackups}>
          Open backups folder
        </button>
      </footer>
    </section>
  )
}
