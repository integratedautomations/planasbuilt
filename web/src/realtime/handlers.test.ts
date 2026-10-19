import { describe, expect, it, vi } from 'vitest'
import { applyServerMessage, deletedToast } from './handlers'

const deps = () => ({ applyMarkup: vi.fn(async () => true), applyDelete: vi.fn(async () => true) })

describe('applyServerMessage', () => {
  it('routes upsert and delete to the local store', async () => {
    const d = deps()
    const row = { id: 'm1', document_id: 'd1' }
    expect(await applyServerMessage({ type: 'markup', op: 'upsert', markup: row, by: 'Dana' }, 'd1', d as any)).toBe(true)
    expect(d.applyMarkup).toHaveBeenCalledWith(row)
    expect(await applyServerMessage({ type: 'markup', op: 'delete', id: 'm1', by: 'Dana' }, 'd1', d as any)).toBe(true)
    expect(d.applyDelete).toHaveBeenCalledWith('d1', 'm1')
  })
  it('ignores other documents, other types and junk', async () => {
    const d = deps()
    expect(await applyServerMessage({ type: 'markup', op: 'upsert', markup: { id: 'm', document_id: 'other' } }, 'd1', d as any)).toBe(false)
    expect(await applyServerMessage({ type: 'scales' }, 'd1', d as any)).toBe(false)
    expect(await applyServerMessage({ type: 'markup', op: 'delete', id: 'x' }, null, d as any)).toBe(false)
    expect(await applyServerMessage({ type: 'markup', op: 'upsert', markup: {} }, 'd1', d as any)).toBe(false)
    expect(d.applyMarkup).not.toHaveBeenCalled()
    expect(d.applyDelete).not.toHaveBeenCalled()
  })
  it('reports a skipped apply (unsent local edits) as false', async () => {
    const d = { applyMarkup: vi.fn(async () => false), applyDelete: vi.fn(async () => false) }
    expect(await applyServerMessage({ type: 'markup', op: 'delete', id: 'm1' }, 'd1', d as any)).toBe(false)
  })
})

describe('deletedToast', () => {
  it('names who and what', () => {
    expect(deletedToast('Dana', 'CAM-04', 'device')).toBe('Dana deleted CAM-04')
    expect(deletedToast(undefined, '', 'rect')).toBe('Someone deleted rect')
  })
})
