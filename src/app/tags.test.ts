import { describe, expect, it } from 'vitest'
import { generateSector } from '../gen/sector/generate'
import { resolveTerrain } from '../gen/terrain'
import type { SectorParams } from '../gen/types'
import { DEFAULT_PARAMS, TAG_GROUPS, materializeTags, normalizeTags, resolveTags } from './tags'

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
  const groupOf = (tag: string) =>
    Object.entries(TAG_GROUPS).find(([, m]) => (m as readonly string[]).includes(tag))?.[0]

  it('always yields exactly one tag per exclusion group', () => {
    for (const seed of [1, 2, 42, 999]) {
      const result = materializeTags(seed, [])
      for (const group of Object.keys(TAG_GROUPS)) {
        expect(result.filter((t) => groupOf(t) === group).length, `${group}@${seed}`).toBe(1)
      }
    }
  })

  it('is deterministic and idempotent', () => {
    const once = materializeTags(7, [])
    expect(materializeTags(7, [])).toEqual(once)
    expect(materializeTags(7, once)).toEqual(once)
  })

  it('staged tags are never overridden', () => {
    const result = materializeTags(3, ['coastal', 'small', 'quiet'])
    expect(result).toContain('coastal')
    expect(result).toContain('small')
    expect(result).toContain('quiet')
  })

  it('group rolls are independent: staging one group never shifts another', () => {
    const bare = materializeTags(11, [])
    const withSize = materializeTags(11, ['large'])
    const density = (tags: string[]) => tags.find((t) => groupOf(t) === 'density')
    const power = (tags: string[]) => tags.find((t) => groupOf(t) === 'power')
    expect(density(withSize)).toBe(density(bare))
    expect(power(withSize)).toBe(power(bare))
  })

  it('terrain materialization matches the generator resolution', () => {
    const seed = 1
    const { landform, river, lakes } = resolveTerrain({
      ...DEFAULT_PARAMS, seed, pack: '', theme: '',
    } as SectorParams)
    const result = materializeTags(seed, [])
    expect(result).toContain(landform)
    expect(result.includes('river')).toBe(river)
    expect(result.includes('lakes')).toBe(lakes)
  })

  it('partial: river staged with no landform gains a landform and keeps river', () => {
    const seed = 2
    const { landform } = resolveTerrain({
      ...DEFAULT_PARAMS, seed, pack: '', theme: '', river: true,
    } as SectorParams)
    const result = materializeTags(seed, ['river'])
    expect(result).toContain(landform)
    expect(result).toContain('river')
  })
})

describe('materialized tags drive generation honestly', () => {
  it('the generated terrain matches the materialized terrain tags', () => {
    for (const seed of [1, 2, 42]) {
      const tags = materializeTags(seed, [])
      const params: SectorParams = { seed, pack: 'generic', theme: 'neon', ...resolveTags(tags) }
      const model = generateSector(params)
      expect(tags).toContain(model.terrain.landform)
      expect(tags.includes('river')).toBe(model.terrain.river)
      expect(tags.includes('lakes')).toBe(model.terrain.lakes)
    }
  }, 60000)
})
