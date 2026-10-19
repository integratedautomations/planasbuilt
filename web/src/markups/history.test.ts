import { describe, expect, it } from 'vitest'
import { describeEvent, fieldLabel, formatWhen } from './history'
import type { HistoryEvent } from './history'

const user = { id: 'u', name: 'Sam', email: 's@x.com' }
const ev = (action: string, changes?: Record<string, unknown>): HistoryEvent => ({ id: 1, at: '2026-10-19T00:00:00Z', action, changes, user })
const fields = [{ key: 'ip', label: 'IP address', type: 'ip' as const }]

describe('history', () => {
  it('describes field and status changes', () => {
    expect(describeEvent(ev('updated', { 'fields.ip': { from: null, to: '10.0.0.5' } }), fields)).toEqual(['Sam set IP address: 10.0.0.5'])
    expect(describeEvent(ev('updated', { status: { from: 'planned', to: 'installed' } }))).toEqual(['Sam changed Status: Planned → Installed'])
    expect(describeEvent(ev('updated', { 'fields.ip': { from: '1', to: '' } }), fields)).toEqual(['Sam cleared IP address'])
    expect(describeEvent(ev('updated', { 'fields.model': { from: 'a', to: 'b' } }))).toEqual(['Sam changed Model #: a → b'])
  })
  it('describes geometry, style, photos and unknowns', () => {
    expect(describeEvent(ev('updated', { geometry: true, style: true }))).toEqual(['Sam moved/resized', 'Sam changed style'])
    expect(describeEvent(ev('photo_added'))).toEqual(['Sam added a photo'])
    expect(describeEvent({ ...ev('created'), user: null })).toEqual(['Someone placed this'])
    expect(describeEvent(ev('updated', {}))).toEqual(['Sam edited this'])
  })
  it('labels fields', () => {
    expect(fieldLabel('notes')).toBe('Notes')
    expect(fieldLabel('zzz')).toBe('zzz')
  })
  it('formats relative then absolute time', () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    expect(formatWhen('2026-10-19T09:59:00Z', now)).toBe('2h ago')
    expect(formatWhen('2026-10-19 11:55:00', now)).toBe('5m ago')
    expect(formatWhen('2026-10-16T12:00:00Z', now)).toBe('3d ago')
    expect(formatWhen('2026-10-01T12:00:00Z', now)).toMatch(/Oct/)
    expect(formatWhen(undefined, now)).toBe('')
  })
})
