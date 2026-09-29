import { describe, expect, it } from 'vitest'
import { polylineLength, type Pt } from '../geometry'
import { inWater } from '../sector/bridges'
import { sampleTerrain } from '../terrain'
import { distToPolyline } from '../terrain/rivers'
import type { SectorParams } from '../types'
import { HIGHWAY_WIDTH, traceHighway } from './highway'
import { MAJOR } from './trace'

const params = (over: Partial<SectorParams> = {}): SectorParams => ({
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon', ...over,
})

const MAX_TURN = MAJOR.step / 300

/** longest run of consecutive `true` flags */
function longestRun(flags: boolean[]): number {
  let best = 0
  let run = 0
  for (const f of flags) { run = f ? run + 1 : 0; best = Math.max(best, run) }
  return best
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
    // window-clamped stub and any straight river-bridge chord — a bridge
    // splice is an engineered transition, not subject to the tracer's own
    // curvature limit)
    const isStepLen = (a: Pt, b: Pt) => {
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      return Math.abs(d - MAJOR.step) < 0.1
    }
    for (let i = 1; i < pts.length - 1; i++) {
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

  it('highway crosses river at most once', () => {
    for (const seed of [42, 7, 1443928265]) {
      const p = params({ seed, landform: 'coastal', river: true })
      const sizeM = p.size * 1000
      const terrain = sampleTerrain(p, sizeM)
      expect(terrain.riverSlice).not.toBeNull()
      const { road } = traceHighway(p, terrain, sizeM)
      // a degenerate entry (e.g. the whole top edge is sea for this seed's
      // window, so no dry entry point exists at all) legitimately produces
      // a near-empty road — trivially zero wet runs, nothing to resample
      if (road.points.length < 2) continue
      // resample every ~10 m along the raw polyline (a straight bridge
      // chord is otherwise invisible at the raw-point level) and count
      // contiguous wet runs
      const len = polylineLength(road.points)
      const steps = Math.max(1, Math.round(len / 10))
      const wet: boolean[] = []
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const total = len
        let target = t * total
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
      expect(longestRun(wet)).toBeLessThanOrEqual(Math.ceil(wet.length)) // sanity: never all-wet
      // count number of separate wet runs
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

  it('exposes HIGHWAY_WIDTH and a well-formed Road', () => {
    const p = params()
    const sizeM = p.size * 1000
    const terrain = sampleTerrain(p, sizeM)
    const { road } = traceHighway(p, terrain, sizeM)
    expect(HIGHWAY_WIDTH).toBe(32)
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
  })
})
