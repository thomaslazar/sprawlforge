import { describe, expect, it } from 'vitest'
import { pointAtT, polylineLength, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { inWater } from '../sector/bridges'
import { sampleTerrain } from '../terrain'
import { distToPolyline } from '../terrain/rivers'
import type { District, HighwaySegment, Road, SectorParams, Terrain, ZoneType } from '../types'
import {
  HIGHWAY_WIDTH, assignHighwayLevels, buildInterchanges, cutStreetsAtGround, highwayCrossings, levelAt, traceHighway,
} from './highway'
import { MAJOR } from './trace'

const params = (over: Partial<SectorParams> = {}): SectorParams => ({
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon', ...over,
})

const MAX_TURN = MAJOR.step / 300
const BRIDGE_MAX_TURN_FROM_HEADING = Math.PI / 4

/** which of the 4 window edges pt sits on (within tol), or null */
function edgeOf(pt: Pt, sizeM: number, tol = 1): 'top' | 'left' | 'bottom' | 'right' | null {
  if (pt.y <= tol) return 'top'
  if (pt.y >= sizeM - tol) return 'bottom'
  if (pt.x <= tol) return 'left'
  if (pt.x >= sizeM - tol) return 'right'
  return null
}

/** index of the one anomalous (non-step-length) interior segment, i.e. the bridge chord — null if none */
function findBridgeSegment(pts: Pt[]): number | null {
  for (let i = 1; i < pts.length - 2; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
    if (d > 1.5 * MAJOR.step) return i
  }
  return null
}

describe('streets/highway', () => {
  it('is deterministic', () => {
    const p = params({ landform: 'coastal', river: true })
    const sizeM = p.size * 1000
    const terrain = sampleTerrain(p, sizeM)
    const r1 = traceHighway(p, terrain, sizeM)
    const r2 = traceHighway(p, terrain, sizeM)
    expect(r2.road.points).toEqual(r1.road.points)
  })

  it('spans the window', () => {
    const p = params()
    const sizeM = p.size * 1000
    const terrain = sampleTerrain(p, sizeM)
    const { road } = traceHighway(p, terrain, sizeM)
    expect(road.points.length).toBeGreaterThan(1)
    expect(road.points[0].y).toBeCloseTo(0, 0)
    expect(road.points[road.points.length - 1].y).toBeGreaterThanOrEqual(sizeM - 1)
  })

  it('bends gently', () => {
    const p = params()
    const sizeM = p.size * 1000
    const terrain = sampleTerrain(p, sizeM)
    const { road } = traceHighway(p, terrain, sizeM)
    const pts = road.points
    // only compare consecutive ~step-length segments (skips the final
    // window-clamped stub) and skip the two pairs touching either end of
    // the bridge chord (R12: the splice into a bridge is an engineered
    // transition, not subject to the tracer's own curvature limit)
    const isStepLen = (a: Pt, b: Pt) => Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - MAJOR.step) < 0.1
    const bridgeIdx = findBridgeSegment(pts)
    for (let i = 1; i < pts.length - 1; i++) {
      if (bridgeIdx !== null && (i === bridgeIdx || i === bridgeIdx + 1)) continue
      const a = pts[i - 1]
      const b = pts[i]
      const c = pts[i + 1]
      if (!isStepLen(a, b) || !isStepLen(b, c)) continue
      const angle1 = Math.atan2(b.y - a.y, b.x - a.x)
      const angle2 = Math.atan2(c.y - b.y, c.x - b.x)
      const diff = Math.abs(Math.atan2(Math.sin(angle2 - angle1), Math.cos(angle2 - angle1)))
      expect(diff).toBeLessThanOrEqual(MAX_TURN + 1e-6)
    }
  })

  it('bridge chord stays within 45 deg of the approach heading', () => {
    for (const seed of [42, 7, 1443928265]) {
      const p = params({ seed, landform: 'coastal', river: true })
      const sizeM = p.size * 1000
      const terrain = sampleTerrain(p, sizeM)
      const { road } = traceHighway(p, terrain, sizeM)
      const bridgeIdx = findBridgeSegment(road.points)
      if (bridgeIdx === null) continue // this fixture's trace never crossed the river
      const before = road.points[bridgeIdx]
      // the ~50 m of highway leading up to the bridge
      let backIdx = bridgeIdx
      let acc = 0
      while (backIdx > 0 && acc < 50) {
        acc += Math.hypot(
          road.points[backIdx].x - road.points[backIdx - 1].x, road.points[backIdx].y - road.points[backIdx - 1].y,
        )
        backIdx -= 1
      }
      const approach = road.points[backIdx]
      const heading = Math.atan2(before.y - approach.y, before.x - approach.x)
      const after = road.points[bridgeIdx + 1]
      const chord = Math.atan2(after.y - before.y, after.x - before.x)
      const diff = Math.abs(Math.atan2(Math.sin(chord - heading), Math.cos(chord - heading)))
      expect(diff).toBeLessThanOrEqual(BRIDGE_MAX_TURN_FROM_HEADING + 1e-6)
    }
  })

  it('highway crosses river at most once', () => {
    for (const seed of [42, 7, 1443928265]) {
      const p = params({ seed, landform: 'coastal', river: true })
      const sizeM = p.size * 1000
      const terrain = sampleTerrain(p, sizeM)
      expect(terrain.riverSlice).not.toBeNull()
      const { road } = traceHighway(p, terrain, sizeM)
      // R11 (search all 4 entry edges): none of these coastal+river seeds
      // is degenerate any more — every one must find a real, spanning entry
      expect(road.points.length).toBeGreaterThanOrEqual(2)
      const a = road.points[0]
      const b = road.points[road.points.length - 1]
      expect(edgeOf(a, sizeM)).not.toBeNull()
      expect(edgeOf(b, sizeM)).not.toBeNull()
      expect(edgeOf(a, sizeM)).not.toBe(edgeOf(b, sizeM))

      // resample every ~10 m along the raw polyline (a straight bridge
      // chord is otherwise invisible at the raw-point level) and count
      // contiguous wet runs
      const len = polylineLength(road.points)
      const steps = Math.max(1, Math.round(len / 10))
      const wet: boolean[] = []
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        let target = t * len
        let pt: Pt = road.points[0]
        for (let j = 1; j < road.points.length; j++) {
          const segLen = Math.hypot(road.points[j].x - road.points[j - 1].x, road.points[j].y - road.points[j - 1].y)
          if (target <= segLen || j === road.points.length - 1) {
            const f = segLen === 0 ? 0 : target / segLen
            pt = {
              x: road.points[j - 1].x + (road.points[j].x - road.points[j - 1].x) * f,
              y: road.points[j - 1].y + (road.points[j].y - road.points[j - 1].y) * f,
            }
            break
          }
          target -= segLen
        }
        wet.push(inWater(terrain, pt))
      }
      let runs = 0
      let inRun = false
      for (const w of wet) {
        if (w && !inRun) { runs += 1; inRun = true }
        else if (!w) inRun = false
      }
      expect(runs).toBeLessThanOrEqual(1)
    }
  })

  it('never enters sea or lake', () => {
    const p = params({ landform: 'coastal', river: true })
    const sizeM = p.size * 1000
    const terrain = sampleTerrain(p, sizeM)
    const { road } = traceHighway(p, terrain, sizeM)
    expect(terrain.riverSlice).not.toBeNull()
    const river = terrain.riverSlice!
    for (const pt of road.points) {
      // riverSlice.width is a metro-wide scalar average; the actual carved
      // channel can run much wider at any one point (sector/roads.test.ts
      // uses the same 6× precedent) — this only needs to rule out sea/lake
      if (inWater(terrain, pt)) expect(distToPolyline(pt, river.course)).toBeLessThanOrEqual(river.width * 6)
    }
  })

  it('exposes HIGHWAY_WIDTH, a well-formed Road, and stays inside the window (incl. the bridge splice)', () => {
    expect(HIGHWAY_WIDTH).toBe(32)
    for (const over of [{}, { seed: 327, landform: 'coastal' as const, river: true }]) {
      const p = params(over)
      const sizeM = p.size * 1000
      const terrain = sampleTerrain(p, sizeM)
      const { road } = traceHighway(p, terrain, sizeM)
      expect(road.id).toBe('H1')
      expect(road.class).toBe('highway')
      expect(road.width).toBe(HIGHWAY_WIDTH)
      expect(road.name).toBeNull()
      for (const pt of road.points) {
        expect(pt.x).toBeGreaterThanOrEqual(0)
        expect(pt.x).toBeLessThanOrEqual(sizeM)
        expect(pt.y).toBeGreaterThanOrEqual(0)
        expect(pt.y).toBeLessThanOrEqual(sizeM)
      }
    }
  })
})

const ring = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
]
const district = (id: string, zone: ZoneType, y0: number, y1: number): District => ({
  id, zone, name: id, bounds: { x: 0, y: y0, w: 4000, h: y1 - y0 }, poly: ring(0, y0, 4000, y1), shore: false, irregularity: 0.5,
} as District)
const hw: Road = { id: 'H1', class: 'highway', width: 32, name: null, points: [{ x: 2000, y: 0 }, { x: 2000, y: 4000 }] }
const line = (id: string, cls: 'arterial' | 'street', a: Pt, b: Pt): Road => ({ id, class: cls, width: 10, name: null, points: [a, b] })
const dry: Terrain = {
  landform: 'inland', river: false, lakes: false, islands: false, metroSeed: 0, water: [],
  land: [[[[0, 0], [4000, 0], [4000, 4000], [0, 4000]]]], riverSlice: null,
}
const wet = (y0: number, y1: number): Terrain => ({
  ...dry, water: [[[[0, y0], [4000, y0], [4000, y1], [0, y1]]]],
})
const seg = (from: number, to: number, level: HighwaySegment['level'], transition = false): HighwaySegment => ({
  from, to, level, districtId: 'd', transition,
})
const rng = () => mulberry32(hashSeed(42, 'highway-levels'))
const mixed = [
  district('a', 'corp', 0, 800), district('b', 'industrial', 800, 1600), district('c', 'residential', 1600, 2400),
  district('d', 'corp', 2400, 3200), district('e', 'industrial', 3200, 4000),
]
const rank = { sunken: 0, ground: 1, elevated: 2 }

describe('highway levels', () => {
  it('single district → one segment, no transition', () => {
    const s = assignHighwayLevels(hw, [district('a', 'industrial', 0, 4000)], dry, rng())
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ from: 0, to: 1, transition: false })
  })

  it('levels change one step at a time', () => {
    for (let i = 0; i < 20; i++) {
      const s = assignHighwayLevels(hw, mixed, dry, mulberry32(i))
      for (let k = 1; k < s.length; k++) {
        expect(Math.abs(rank[s[k].level] - rank[s[k - 1].level])).toBeLessThanOrEqual(1)
        expect(s[k].transition).toBe(s[k].level !== s[k - 1].level)
      }
    }
  })

  it('at most two level changes', () => {
    for (let i = 0; i < 20; i++) {
      const s = assignHighwayLevels(hw, mixed, dry, mulberry32(i))
      expect(s.filter((x) => x.transition).length).toBeLessThanOrEqual(2)
    }
  })

  it('short district inherits the previous level', () => {
    const ds = [district('a', 'corp', 0, 1800), district('b', 'industrial', 1800, 2200), district('c', 'corp', 2200, 4000)]
    const s = assignHighwayLevels(hw, ds, dry, rng())
    expect(s.every((x) => x.level === 'sunken')).toBe(true)
  })

  it('sunken never crosses the river', () => {
    const ds = [district('a', 'corp', 0, 1500), district('b', 'residential', 1500, 4000)]
    for (let i = 0; i < 10; i++) {
      const s = assignHighwayLevels(hw, ds, wet(1800, 2000), mulberry32(i))
      for (let y = 1800; y <= 2000; y += 10) expect(levelAt(s, y / 4000)).not.toBe('sunken')
    }
  })

  it('corp prefers sunken', () => {
    const s = assignHighwayLevels(hw, [district('a', 'corp', 0, 2000), district('b', 'corp', 2000, 4000)], dry, rng())
    expect(s.length).toBeGreaterThan(0)
    expect(s.every((x) => x.level === 'sunken')).toBe(true)
  })

  it('ground stretch cuts streets at the corridor edge', () => {
    const street = line('S1', 'street', { x: 1000, y: 2000 }, { x: 3000, y: 2000 })
    const out = cutStreetsAtGround([street], hw, [seg(0, 1, 'ground')])
    expect(out).toHaveLength(2)
    for (const r of out) for (const p of r.points) expect(Math.abs(p.x - 2000)).toBeGreaterThan(HIGHWAY_WIDTH / 2 + 1)
    const keep = cutStreetsAtGround([street], hw, [seg(0, 1, 'elevated')])
    expect(keep[0]).toBe(street)
  })

  it('interchanges every ~1 km with four ramps', () => {
    const arts = [400, 1050, 2100, 2950, 3500].map((y, i) => line('A' + i, 'arterial', { x: 0, y }, { x: 4000, y }))
    const segs = [seg(0, 1, 'elevated')]
    const cr = highwayCrossings(hw, arts, segs, rng())
    const { crossings, ramps } = buildInterchanges(hw, cr, arts, segs, dry, 4000)
    const n = crossings.filter((c) => c.interchange).length
    expect(n).toBeGreaterThanOrEqual(3)
    expect(n).toBeLessThanOrEqual(4)
    expect(ramps).toHaveLength(4 * n)
    for (const r of ramps) {
      expect(r).toMatchObject({ class: 'ramp', width: 8, name: null })
      expect(r.points).toHaveLength(10)
    }
  })

  it('no interchange on a bridge or transition', () => {
    const arts = [1300, 1050, 2050, 2500, 3000].map((y, i) => line('A' + i, 'arterial', { x: 0, y }, { x: 4000, y }))
    const segs = [seg(0, 0.5, 'elevated'), seg(0.5, 1, 'sunken', true)]
    const cr = highwayCrossings(hw, arts, segs, rng())
    const { crossings } = buildInterchanges(hw, cr, arts, segs, wet(1000, 1100), 4000)
    const chosen = crossings.filter((c) => c.interchange)
    expect(chosen.length).toBeGreaterThan(0)
    for (const c of chosen) {
      const y = c.at * 4000
      expect(y < 1000 || y > 1100).toBe(true)
      expect(Math.abs(y - 2000)).toBeGreaterThanOrEqual(200)
      expect(pointAtT(hw.points, c.at).x).toBeCloseTo(2000)
    }
  })
})
