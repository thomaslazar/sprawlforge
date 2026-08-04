import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, normalizeTags, resolveTags } from './tags'

describe('resolveTags', () => {
  it('empty tags = defaults', () => {
    expect(resolveTags([])).toEqual(DEFAULT_PARAMS)
  })

  it('resolves one tag per group to exact numerics', () => {
    expect(resolveTags(['coastal', 'large', 'packed', 'corp-run', 'lively', 'piers'])).toEqual({
      terrain: 'coastal',
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
})

describe('normalizeTags', () => {
  it('keeps at most one tag per group (last wins), keeps piers, drops unknowns', () => {
    expect(normalizeTags(['small', 'large', 'piers', 'nonsense'])).toEqual(['large', 'piers'])
  })

  it('empty input yields empty output', () => {
    expect(normalizeTags([])).toEqual([])
  })
})
