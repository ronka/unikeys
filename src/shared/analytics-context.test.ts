import { describe, expect, it } from 'vitest'

import { heartbeatDue, localDay, macosMajor, macosMajorFromDarwin } from './analytics-context'

describe('macosMajorFromDarwin', () => {
  it.each([
    ['23.6.0', '14'],
    ['24.3.0', '15'],
    ['25.0.0', '26'],
    ['26.1.0', '27'],
    ['20.6.0', '11'],
    ['19.6.0', '10']
  ])('maps Darwin %s to macOS %s', (darwin, expected) => {
    expect(macosMajorFromDarwin(darwin)).toBe(expected)
  })

  it('reports unknown for garbage', () => {
    expect(macosMajorFromDarwin('')).toBe('unknown')
  })
})

describe('macosMajor', () => {
  it('prefers the system version', () => {
    expect(macosMajor('15.3.1', '24.3.0')).toBe('15')
  })

  it('falls back to Darwin when the system version is missing or unusable', () => {
    expect(macosMajor(undefined, '24.3.0')).toBe('15')
    expect(macosMajor('', '25.0.0')).toBe('26')
  })
})

describe('heartbeat', () => {
  it('formats the local day', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  it('is due when never sent or last sent on another day', () => {
    const now = new Date(2026, 9, 22, 12)
    expect(heartbeatDue(null, now)).toBe(true)
    expect(heartbeatDue('2026-10-21', now)).toBe(true)
    expect(heartbeatDue('2026-10-22', now)).toBe(false)
  })
})
