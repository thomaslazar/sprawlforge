import { describe, expect, it } from 'vitest'
import { GENERATOR_VERSION, type SectorParams } from '../types'
import { generateSector } from './generate'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  coast: false, river: false, pack: 'generic', theme: 'neon',
}

describe('generateSector', () => {
  it('same params give deep-equal models', () => {
    expect(generateSector(base)).toEqual(generateSector(base))
  })
  it('different seeds give different models', () => {
    const a = generateSector(base)
    const b = generateSector({ ...base, seed: 43 })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })
  it('meta carries seed, version and size in meters', () => {
    const m = generateSector(base)
    expect(m.meta).toMatchObject({ seed: 42, generatorVersion: GENERATOR_VERSION, sizeM: 4000 })
    expect(m.meta.params).toEqual(base)
  })
  it('every district has a name; highways and arterials are named', () => {
    const m = generateSector(base)
    for (const d of m.districts) expect(d.name.length).toBeGreaterThan(0)
    for (const r of m.roads) {
      if (r.class === 'street') expect(r.name).toBeNull()
      else expect((r.name ?? '').length).toBeGreaterThan(0)
    }
  })
  it('cross-references resolve', () => {
    const m = generateSector(base)
    const districtIds = new Set(m.districts.map((d) => d.id))
    const blockIds = new Set(m.blocks.map((b) => b.id))
    const buildingIds = new Set(m.buildings.map((b) => b.id))
    for (const b of m.blocks) {
      expect(districtIds.has(b.districtId)).toBe(true)
      // block's embedded district ordinal must match its actual district
      expect(b.id.slice(1, 3)).toBe(b.districtId.slice(1))
    }
    for (const b of m.buildings) {
      expect(blockIds.has(b.blockId)).toBe(true)
      // building's blockId ordinal must match its own districtId
      expect(b.blockId.slice(1, 3)).toBe(b.districtId.slice(1))
    }
    for (const p of m.pois) expect(buildingIds.has(p.buildingId)).toBe(true)
  })
  it('shadowrunish pack changes names but not geometry', () => {
    const a = generateSector(base)
    const b = generateSector({ ...base, pack: 'shadowrunish' })
    expect(a.blocks).toEqual(b.blocks)
    expect(a.buildings).toEqual(b.buildings)
    expect(a.districts.map((d) => d.bounds)).toEqual(b.districts.map((d) => d.bounds))
  })
})
