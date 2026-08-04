import { describe, expect, it } from 'vitest'
import { DEFAULTS, paramsFromSearch, paramsToSearch } from './params'

describe('params codec', () => {
  it('round-trips', () => {
    const p = { ...DEFAULTS, seed: 4711, size: 6, terrain: 'coastal' as const, pack: 'shadowrunish' }
    expect(paramsFromSearch(paramsToSearch(p), 0)).toEqual(p)
  })
  it('empty search uses defaults and fallback seed', () => {
    expect(paramsFromSearch('', 123)).toEqual({ ...DEFAULTS, seed: 123 })
  })
  it('clamps and sanitizes garbage', () => {
    const p = paramsFromSearch('?size=999&density=7&seed=abc&corp=-3', 55)
    expect(p.seed).toBe(55)
    expect(p.size).toBeLessThanOrEqual(8)
    expect(p.density).toBeLessThanOrEqual(1)
    expect(p.corpDominance).toBeGreaterThanOrEqual(0)
  })
})
