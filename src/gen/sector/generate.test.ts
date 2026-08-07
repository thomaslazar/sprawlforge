import { describe, expect, it } from 'vitest'
import { pointInRings, type Pt } from '../geometry'
import { ISLET_MOAT_OUTER_FACTOR, ISLET_RADIUS_MAX } from '../terrain/field'
import { GENERATOR_VERSION, type Block, type District, type SectorParams, type Terrain } from '../types'
import { deriveDistricts, generateSector } from './generate'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
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
  it('never anchors a poi in water (coastal, shore-clipped buildings)', () => {
    const inWater = (t: Terrain, p: { x: number; y: number }) =>
      t.water.some((poly) => pointInRings(p, poly.map((ring) => ring.map(([x, y]) => ({ x, y })))))
    for (const seed of [1, 42, 119560026]) {
      const m = generateSector({ ...base, seed, landform: 'coastal' })
      for (const p of m.pois) expect(inWater(m.terrain, p.at)).toBe(false)
    }
  })
  it('shadowrunish pack changes names but not geometry', () => {
    const a = generateSector(base)
    const b = generateSector({ ...base, pack: 'shadowrunish' })
    expect(a.blocks).toEqual(b.blocks)
    expect(a.buildings).toEqual(b.buildings)
    expect(a.districts.map((d) => d.bounds)).toEqual(b.districts.map((d) => d.bounds))
  })
  it('does not throw on seeds that used to break polygon-clipping on a river corridor', () => {
    // inland/river/islands sector at high irregularity — the crash-reported
    // tag combo (inland,small,dense,balanced,normal,sprawl,river,islands).
    // 2882370099 is the originally-reported seed (crashed before a reroll);
    // 4 and 40 also self-intersected in corridorPolygon's old averaged-normal
    // river-corridor join (src/gen/partition/twisted.ts). 95 and 96 crashed
    // via a second, independent bug: polygon-clipping choking on a
    // legitimate-but-numerically-hard block/building clip in
    // src/gen/sector/buildings.ts (fixed with the same epsilon-nudge-retry
    // pattern contour.ts already uses for this class of library failure).
    const params: SectorParams = {
      seed: 0, size: 2, density: 0.6, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.85,
      landform: 'inland', river: true, lakes: false, islands: true, piers: false,
      pack: 'generic', theme: 'print',
    }
    for (const seed of [2882370099, 4, 40, 95, 96]) {
      expect(() => generateSector({ ...params, seed })).not.toThrow()
    }
  }, 20000) // 5 sector generations at islands:true — the moat's extra per-sample
  // work (fix: islets carve a moat) pushed this right up against the 5s default
  it('islets never dam a river: every river-course point is either wet or ringed by a wet moat (seed 2882370099)', () => {
    // deterministic repro for the islands-dam-the-river bug: an islet's core
    // bump used to raise land clear across a river channel (islet radius
    // 150-300m vs a ~60-120m channel). generateSector must not throw, and
    // any river-course point that lands on land must be explainable as
    // sitting on an islet — i.e. some radius around it is a full wet ring
    // (the moat), not just an unrelated dry patch swallowing the channel.
    const params: SectorParams = {
      seed: 2882370099, size: 2, density: 0.6, corpDominance: 0.5, poiDensity: 0.5,
      irregularity: 0.85, landform: 'inland', river: true, lakes: false, islands: true,
      piers: false, pack: 'generic', theme: 'neon',
    }
    let m: ReturnType<typeof generateSector> | undefined
    expect(() => {
      m = generateSector(params)
    }).not.toThrow()
    const sizeM = params.size * 1000
    const inWater = (p: Pt) =>
      m!.terrain.water.some((poly) => pointInRings(p, poly.map((ring) => ring.map(([x, y]) => ({ x, y })))))
    // generous upper bound on how far an islet's moat ring could possibly
    // sit from its own center — any real moat ring must be found at or
    // under this radius
    const maxMoatR = ISLET_RADIUS_MAX * ISLET_MOAT_OUTER_FACTOR
    const ringedByMoat = (p: Pt) => {
      const angles = 24
      for (let r = 20; r <= maxMoatR + 60; r += 20) {
        let allWet = true
        for (let a = 0; a < angles; a++) {
          const theta = (a / angles) * Math.PI * 2
          if (!inWater({ x: p.x + Math.cos(theta) * r, y: p.y + Math.sin(theta) * r })) {
            allWet = false
            break
          }
        }
        if (allWet) return true
      }
      return false
    }
    const course = m!.terrain.riverSlice?.course ?? []
    const inWindow = course.filter((p) => p.x >= 0 && p.x <= sizeM && p.y >= 0 && p.y <= sizeM)
    expect(inWindow.length, 'river actually crosses this window').toBeGreaterThan(0)
    const dammed = inWindow.filter((p) => !inWater(p) && !ringedByMoat(p))
    expect(dammed).toEqual([])
  })
})

const block = (id: string, districtId: string, rect: { x: number; y: number; w: number; h: number }): Block => {
  const poly = [
    { x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h }, { x: rect.x, y: rect.y + rect.h },
  ]
  return { id, districtId, poly, footprint: poly }
}
const district = (id: string, bounds: { x: number; y: number; w: number; h: number }): District => ({
  id, zone: 'corp', name: 'X', bounds,
  poly: [
    { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y + bounds.h }, { x: bounds.x, y: bounds.y + bounds.h },
  ],
  irregularity: 0.5, shore: false,
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
