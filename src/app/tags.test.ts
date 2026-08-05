import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, normalizeTags, resolveTags } from './tags'

describe('resolveTags', () => {
  it('empty tags = defaults', () => {
    expect(resolveTags([])).toEqual(DEFAULT_PARAMS)
  })

  it('resolves one tag per group to exact numerics', () => {
    expect(resolveTags(['coastal', 'large', 'packed', 'corp-run', 'lively', 'piers'])).toEqual({
      landform: 'coastal',
      river: false,
      lakes: false,
      size: 6,
      density: 0.9,
      corpDominance: 0.85,
      poiDensity: 0.7,
      piers: true,
    })
  })

  it('last tag of a group wins', () => {
    expect(resolveTags(['small', 'large']).size).toBe(6)
  })

  it('ignores unknown tags', () => {
    expect(resolveTags(['nonsense'])).toEqual(DEFAULT_PARAMS)
  })

  it('river, lakes and a landform all stage together (the estuary combo)', () => {
    expect(resolveTags(['coastal', 'river', 'lakes'])).toEqual({
      ...DEFAULT_PARAMS,
      landform: 'coastal',
      river: true,
      lakes: true,
    })
  })
})

describe('normalizeTags', () => {
  it('keeps at most one tag per group (last wins), keeps free toggles, drops unknowns', () => {
    expect(normalizeTags(['small', 'large', 'piers', 'nonsense'])).toEqual(['large', 'piers'])
  })

  it('empty input yields empty output', () => {
    expect(normalizeTags([])).toEqual([])
  })

  it('keeps river, lakes and coastal all staged together', () => {
    expect(normalizeTags(['coastal', 'river', 'lakes'])).toEqual(
      expect.arrayContaining(['coastal', 'river', 'lakes']),
    )
    expect(normalizeTags(['coastal', 'river', 'lakes']).length).toBe(3)
  })
})
