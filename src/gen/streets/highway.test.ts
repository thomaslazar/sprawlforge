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
