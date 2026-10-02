import { describe, expect, it } from 'vitest'
import type { Pt, Rect } from '../geometry'
import { getPack } from '../names/packs'
import type { Building, District, SectorParams } from '../types'
import { placePois } from './pois'

const rectPoly = (r: Rect): Pt[] => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
]

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
}
const districts: District[] = [
  { id: 'D01', zone: 'corp', name: 'Test Heights', bounds: { x: 0, y: 0, w: 600, h: 600 }, poly: rectPoly({ x: 0, y: 0, w: 600, h: 600 }), irregularity: 0.5, shore: false, labelAt: { x: 300, y: 300 }, flags: {} },
]
const buildings: Building[] = Array.from({ length: 30 }, (_, i) => ({
  id: `BLD0101${String(i + 1).padStart(2, '0')}`,
  blockId: 'B0101',
  districtId: 'D01',
  footprint: [{ x: i * 20, y: 0 }, { x: i * 20 + 15, y: 0 }, { x: i * 20 + 15, y: 15 }, { x: i * 20, y: 15 }],
}))

describe('placePois', () => {
  const pack = getPack('generic')
  it('is deterministic', () => {
    expect(placePois(districts, buildings, pack, base))
      .toEqual(placePois(districts, buildings, pack, base))
  })
  it('poi types match district zone and names are non-empty', () => {
    const pois = placePois(districts, buildings, pack, base)
    expect(pois.length).toBeGreaterThan(0)
    const validTypes = pack.poiTypes.filter((t) => t.zones.includes('corp')).map((t) => t.type)
    for (const p of pois) {
      expect(validTypes).toContain(p.type)
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.at).toEqual({
        x: expect.any(Number),
        y: expect.any(Number),
      })
    }
  })
  it('anchors at the footprint centroid, not the pre-clip bbox center (shore-clipped buildings)', () => {
    // a shore-clipped building's pre-clip bounding box center (10,10) can sit
    // in water even though the clipped footprint (centroid (4,4)) is
    // entirely on land
    const clipped: Building = {
      id: 'BLD010101', blockId: 'B0101', districtId: 'D01',
      footprint: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }],
    }
    const pois = placePois(districts, [clipped], pack, base)
    expect(pois.length).toBe(1)
    expect(pois[0].at).toEqual({ x: 4, y: 4 })
  })
  it('anchors inside a concave (L-shaped) footprint — vertex mean would land outside it', () => {
    // an L-shape: the plain vertex mean of these 6 corners is (10, 10),
    // which sits in the L's missing notch (outside the shape); the shoelace
    // centroid must land inside the polygon instead
    const lShaped: Building = {
      id: 'BLD010101', blockId: 'B0101', districtId: 'D01',
      footprint: [
        { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 },
        { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 },
      ],
    }
    const pois = placePois(districts, [lShaped], pack, base)
    expect(pois.length).toBe(1)
    const { x, y } = pois[0].at
    expect(x === 10 && y === 10).toBe(false) // not the vertex mean
    // inside the L: either the top bar (y<10) or the left bar (x<10)
    expect(y < 10 || x < 10).toBe(true)
  })
  it('poiDensity raises count; buildings never reused', () => {
    const lo = placePois(districts, buildings, pack, { ...base, poiDensity: 0.1 })
    const hi = placePois(districts, buildings, pack, { ...base, poiDensity: 1 })
    expect(hi.length).toBeGreaterThan(lo.length)
    expect(new Set(hi.map((p) => p.buildingId)).size).toBe(hi.length)
  })

  it('poiDensity 0 places no POIs at all', () => {
    expect(placePois(districts, buildings, pack, { ...base, poiDensity: 0 })).toEqual([])
  })

  describe('landmarks', () => {
    const sq = (x: number, y: number, r: number): Pt[] => rectPoly({ x: x - r, y: y - r, w: 2 * r, h: 2 * r })
    const landmarks = {
      arcologies: [{ id: 'A01', name: 'Aegis Spire', center: { x: 100, y: 300 }, radius: 80, footprint: sq(100, 300, 60), plaza: sq(100, 300, 80), ringRoadId: 'R1' }],
      megablocks: [{ id: 'M01', name: 'Hive Nine', center: { x: 400, y: 300 }, core: sq(400, 300, 40) }],
    }
    it('one POI per landmark with its name', () => {
      const pois = placePois(districts, buildings, pack, base, landmarks)
      expect(pois[0]).toEqual({ id: 'P01', type: 'arcology', name: 'Aegis Spire', buildingId: '', districtId: 'D01', at: { x: 100, y: 300 } })
      expect(pois[1]).toEqual({ id: 'P02', type: 'megablock', name: 'Hive Nine', buildingId: '', districtId: 'D01', at: { x: 400, y: 300 } })
      expect(pois.filter((p) => p.type === 'arcology' || p.type === 'megablock')).toHaveLength(2)
      expect(new Set(pois.map((p) => p.id)).size).toBe(pois.length)
    })
    it('landmark POIs survive poiDensity 0', () => {
      expect(placePois(districts, buildings, pack, { ...base, poiDensity: 0 }, landmarks)).toHaveLength(2)
    })
    it('lottery never places a POI inside a plaza', () => {
      // buildings 0..4 (x 0-95, y 0-15) sit inside a plaza covering that strip
      const plaza = rectPoly({ x: -10, y: -10, w: 110, h: 40 })
      const lm = { arcologies: [{ ...landmarks.arcologies[0], plaza }], megablocks: [] }
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const pois = placePois(districts, buildings, pack, { ...base, seed, poiDensity: 1 }, lm).filter((p) => p.buildingId)
        expect(pois.length).toBeGreaterThan(0)
        for (const p of pois) expect(p.at.x).toBeGreaterThan(100)
      }
    })
  })
})
