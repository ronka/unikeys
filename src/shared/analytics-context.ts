/**
 * Pure helpers behind the ambient analytics context and the daily heartbeat.
 * Kept out of `src/main/analytics.ts` so they run under plain Node in tests.
 */

/**
 * macOS major version from a Darwin kernel release (`os.release()`).
 *
 * The offset is not constant. Darwin 20–24 are macOS 11–15 (minus nine), but
 * macOS 26 jumped to match the year and Darwin 25 is macOS 26 (plus one).
 */
export function macosMajorFromDarwin(darwinRelease: string): string {
  const darwin = Number.parseInt(darwinRelease.split('.')[0] ?? '', 10)
  if (!Number.isFinite(darwin)) return 'unknown'
  if (darwin >= 25) return String(darwin + 1)
  if (darwin >= 20) return String(darwin - 9)
  return '10'
}

/**
 * macOS major version only — `26`, not `26.1.2`. Prefers the version Electron
 * reports (`process.getSystemVersion()`, e.g. `15.3.1`), which is the real one,
 * and falls back to mapping the Darwin release when that is unavailable.
 */
export function macosMajor(systemVersion: string | undefined, darwinRelease: string): string {
  const major = Number.parseInt(systemVersion?.split('.')[0] ?? '', 10)
  if (Number.isFinite(major) && major > 0) return String(major)
  return macosMajorFromDarwin(darwinRelease)
}

/** The local calendar day as `YYYY-MM-DD`. */
export function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Whether a heartbeat is due: nothing sent yet, or last sent on another day. */
export function heartbeatDue(lastSent: string | null, now: Date): boolean {
  return lastSent !== localDay(now)
}
