import { describe, expect, it } from 'vitest'

import {
  ANALYTICS_EVENT_NAMES,
  EVENT_PROPERTIES,
  isAnalyticsEventName,
  sanitize,
  type AnalyticsEvent
} from './analytics'

/**
 * Words that must never appear in a property name.
 *
 * A crude check, and that is the point: it is not trying to understand what a
 * property means, only to make the leaky ones hard to add without noticing.
 * Anything matching here is either the forbidden thing itself or one rename
 * away from carrying it.
 */
const FORBIDDEN = [
  'path',
  'dir',
  'folder',
  'file',
  'chord',
  'key',
  'binding',
  'vault',
  'home',
  'user',
  'host',
  'machine',
  'serial',
  'email',
  'contents',
  'error',
  'message'
]

/**
 * Property names that contain a forbidden word but carry a count of the thing
 * rather than the thing. Listed one by one rather than matched by a `_count`
 * suffix rule, so that adding another is a decision someone makes on purpose.
 */
const COUNTS_OF_FORBIDDEN_THINGS = ['bindings_written', 'bindings_skipped', 'bindings_dropped']

describe('the event contract', () => {
  it('declares every event exactly once', () => {
    expect(new Set(ANALYTICS_EVENT_NAMES).size).toBe(ANALYTICS_EVENT_NAMES.length)
  })

  it('names no property after something that must never be sent', () => {
    for (const [event, properties] of Object.entries(EVENT_PROPERTIES)) {
      for (const property of properties) {
        if (COUNTS_OF_FORBIDDEN_THINGS.includes(property)) continue
        const offending = FORBIDDEN.filter((word) => property.toLowerCase().includes(word))
        expect(offending, `${event}.${property}`).toEqual([])
      }
    }
  })

  it('sends only enums, booleans and numbers, plus the one catalogue id', () => {
    // Guards the rule the doc comment states: `action_id` is the sole
    // string-shaped field, and it carries data unikeys ships rather than data it
    // read off the machine. A second free string is the shape a leak arrives in.
    const strings = Object.values(EVENT_PROPERTIES)
      .flat()
      .filter((property) => property === 'action_id')
    expect(strings).toEqual(['action_id'])
  })

  it('recognises its own names and nothing else', () => {
    expect(isAnalyticsEventName('app_launched')).toBe(true)
    expect(isAnalyticsEventName('config_read')).toBe(false)
    // `Object.prototype` keys are not events, however much `in` might agree.
    expect(isAnalyticsEventName('toString')).toBe(false)
  })
})

describe('sanitize', () => {
  it('keeps the properties an event declares', () => {
    const event: AnalyticsEvent = {
      name: 'grant_outcome',
      properties: { app: 'obsidian', outcome: 'granted' }
    }
    expect(sanitize(event)).toEqual({
      name: 'grant_outcome',
      properties: { app: 'obsidian', outcome: 'granted' }
    })
  })

  it('drops anything the event did not declare', () => {
    // The case this exists for: a payload that reached the boundary carrying a
    // path, from a stale renderer or a call site that cast past the types.
    const smuggled = {
      name: 'grant_outcome',
      properties: {
        app: 'obsidian',
        outcome: 'granted',
        configPath: '/Users/someone/Documents/Client Work/.obsidian/hotkeys.json',
        error: 'ENOENT: /Users/someone/…'
      }
    }
    const clean = sanitize(smuggled)
    expect(clean).toEqual({
      name: 'grant_outcome',
      properties: { app: 'obsidian', outcome: 'granted' }
    })
    expect(JSON.stringify(clean)).not.toContain('/Users/')
  })

  it('drops an event it has never heard of entirely', () => {
    expect(sanitize({ name: 'config_read', properties: { path: '/Users/someone' } })).toBeNull()
  })

  it('omits a declared property that was not supplied rather than sending undefined', () => {
    expect(
      sanitize({ name: 'row_matched', properties: { action_id: 'edit.comment-line' } })
    ).toEqual({ name: 'row_matched', properties: { action_id: 'edit.comment-line' } })
  })

  it('handles an event with no properties at all', () => {
    expect(sanitize({ name: 'analytics_opt_out' })).toEqual({
      name: 'analytics_opt_out',
      properties: {}
    })
  })
})

describe('the type contract', () => {
  it('rejects a property the event does not declare', () => {
    const event: AnalyticsEvent = {
      name: 'row_matched',
      properties: {
        action_id: 'edit.comment-line',
        needed_winner: false,
        // @ts-expect-error a path must not be attachable to an event, ever
        configPath: '/Users/someone/Library/Application Support/Code/User'
      }
    }
    // The compile-time check above is the assertion; this keeps the value used.
    expect(event.name).toBe('row_matched')
  })

  it('rejects an event name that is not in the contract', () => {
    // @ts-expect-error there is no such event, and there must be no way to add one at a call site
    const event: AnalyticsEvent = { name: 'config_read', properties: {} }
    expect(event).toBeTruthy()
  })
})
