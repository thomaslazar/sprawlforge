import { describe, expect, it } from 'vitest'
import { generateSector } from '../gen/sector/generate'
import { resolveTerrain } from '../gen/terrain'
import type { SectorParams } from '../gen/types'
import { DEFAULT_PARAMS, materializeTags, normalizeTags, resolveTags } from './tags'

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

describe('materializeTags', () => {
  it('landform present: unchanged', () => {
    expect(materializeTags(1, ['coastal', 'river'])).toEqual(['coastal', 'river'])
  })

  it('bare: gains the resolved landform, plus water per the seed roll', () => {
    const seed = 1
    const { landform, river, lakes } = resolveTerrain({
      ...DEFAULT_PARAMS, seed, pack: '', theme: '',
    } as SectorParams)
    const expected = [landform, ...(river ? ['river'] : []), ...(lakes ? ['lakes'] : [])]
    expect(materializeTags(seed, [])).toEqual(expect.arrayContaining(expected))
    expect(materializeTags(seed, []).length).toBe(expected.length)
  })

  it('partial: river staged with no landform gains a landform and keeps river true', () => {
    const seed = 2
    const { landform, lakes } = resolveTerrain({
      ...DEFAULT_PARAMS, seed, pack: '', theme: '', river: true,
    } as SectorParams)
    const result = materializeTags(seed, ['river'])
    expect(result).toEqual(
      expect.arrayContaining([landform, 'river', ...(lakes ? ['lakes'] : [])]),
    )
    expect(result.length).toBe(2 + (lakes ? 1 : 0))
  })
})

describe('materialization keeps generation byte-identical', () => {
  const asParams = (seed: number, tags: Parameters<typeof resolveTags>[0]): SectorParams => ({
    seed, pack: 'generic', theme: 'neon', ...resolveTags(tags),
  })
  // meta.params is a verbatim echo of the input SectorParams, so it trivially
  // differs (landform: 'auto' vs the materialized explicit value) — strip it
  // and compare everything the generator actually produced from it.
  const stripParamsEcho = (m: ReturnType<typeof generateSector>) => ({
    ...m, meta: { ...m.meta, params: undefined },
  })

  it('generateSector(bare/auto) deep-equals generateSector(materialized explicit tags)', () => {
    for (const seed of [1, 2, 42]) {
      const auto = asParams(seed, [])
      const materialized = asParams(seed, materializeTags(seed, []))
      expect(stripParamsEcho(generateSector(materialized))).toEqual(stripParamsEcho(generateSector(auto)))
    }
  }, 30000)

  it('holds for a partial (river-only) staged set too', () => {
    for (const seed of [7, 99]) {
      const auto = asParams(seed, ['river'])
      const materialized = asParams(seed, materializeTags(seed, ['river']))
      expect(stripParamsEcho(generateSector(materialized))).toEqual(stripParamsEcho(generateSector(auto)))
    }
  }, 30000)
})
