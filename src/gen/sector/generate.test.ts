import { describe, expect, it } from 'vitest'
import { GENERATOR_VERSION, type Block, type District, type SectorParams } from '../types'
import { deriveDistricts, generateSector } from './generate'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  landform: 'inland', river: false, lakes: false, piers: false, pack: 'generic', theme: 'neon',
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
    expect(typeof m.meta.metroSeed).toBe('number')
  })
  it('samples terrain and exposes its landform', () => {
    const m = generateSector(base)
    expect(m.terrain.landform).toBe('inland')
    expect(m.meta.metroSeed).toBe(m.terrain.metroSeed)
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

const block = (id: string, districtId: string, rect: { x: number; y: number; w: number; h: number }): Block => ({
  id, districtId, rect, footprint: [
    { x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h }, { x: rect.x, y: rect.y + rect.h },
  ],
})
const district = (id: string, bounds: { x: number; y: number; w: number; h: number }): District => ({
  id, zone: 'corp', name: 'X', bounds, shore: false,
  labelAt: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
})

describe('deriveDistricts', () => {
  it('drops a district whose blocks all drowned', () => {
    const drowned = district('D01', { x: 0, y: 0, w: 600, h: 600 })
    const survivor = district('D02', { x: 700, y: 0, w: 600, h: 600 })
    const blocks = [block('B0201', 'D02', { x: 710, y: 10, w: 280, h: 280 })]
    const out = deriveDistricts([drowned, survivor], blocks)
    expect(out.map((d) => d.id)).toEqual(['D02'])
  })
  it('anchors a partially-wet district over its surviving (dry-side) blocks, not the bounds center', () => {
    const partial = district('D03', { x: 0, y: 0, w: 1000, h: 600 })
    // only the dry left edge survived waterline clipping
    const blocks = [
      block('B0301', 'D03', { x: 0, y: 0, w: 200, h: 200 }),
      block('B0302', 'D03', { x: 0, y: 200, w: 200, h: 200 }),
    ]
    const [d] = deriveDistricts([partial], blocks)
    // union bbox of surviving blocks is x:[0,200], y:[0,400]
    expect(d.labelAt.x).toBeGreaterThanOrEqual(0)
    expect(d.labelAt.x).toBeLessThanOrEqual(200)
    expect(d.labelAt.y).toBeGreaterThanOrEqual(0)
    expect(d.labelAt.y).toBeLessThanOrEqual(400)
    // bounds center (500, 300) sits in the drowned water side — must not land there
    expect(d.labelAt.x).not.toBeCloseTo(500)
  })
  it('anchors a fully-dry district at ~ its bounds center', () => {
    const dry = district('D04', { x: 0, y: 0, w: 600, h: 600 })
    const blocks = [
      block('B0401', 'D04', { x: 0, y: 0, w: 300, h: 300 }),
      block('B0402', 'D04', { x: 300, y: 0, w: 300, h: 300 }),
      block('B0403', 'D04', { x: 0, y: 300, w: 300, h: 300 }),
      block('B0404', 'D04', { x: 300, y: 300, w: 300, h: 300 }),
    ]
    const [d] = deriveDistricts([dry], blocks)
    expect(d.labelAt.x).toBeCloseTo(300)
    expect(d.labelAt.y).toBeCloseTo(300)
  })
})
