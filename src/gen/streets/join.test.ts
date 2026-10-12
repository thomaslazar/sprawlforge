import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import { joinCurve, joinFreeEnds } from './join'
import { MAJOR, RoadIndex } from './trace'
import type { Road, Terrain } from '../types'

function maxBendDeg(pts: Pt[]): number {
  let m = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x)
    const b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x)
    let d = Math.abs(b - a)
    if (d > Math.PI) d = 2 * Math.PI - d
    m = Math.max(m, (d * 180) / Math.PI)
  }
  return m
}

describe('joinCurve', () => {
  it('leaves along dir and ends on target', () => {
    const c = joinCurve({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 200, y: 100 }, { x: 1, y: 0 }, () => false)!
    expect(c.at(-1)).toEqual({ x: 200, y: 100 })
    expect(Math.abs(c[0].y / c[0].x)).toBeLessThan(0.2)
    expect(maxBendDeg([{ x: 0, y: 0 }, ...c])).toBeLessThan(15)
  })
  it.each([150, -150])('arrives at 60° to the target road (target y %d)', (y) => {
    const c = joinCurve({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 300, y }, { x: 1, y: 0 }, () => false)!
    const a = c.at(-2)!, b = c.at(-1)!
    expect(Math.abs((Math.atan2(Math.abs(b.y - a.y), b.x - a.x) * 180) / Math.PI - 60)).toBeLessThan(2)
  })
  it('a walker heading into the road more steeply than 60° keeps its heading (a grid T is straight)', () => {
    const c = joinCurve({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 200 }, { x: 1, y: 0 }, () => false)!
    for (const q of c) expect(Math.abs(q.x)).toBeLessThan(1e-9)
  })
  it('a steep heading with the target offset along the road ends on target and bends gently', () => {
    const target = { x: 30, y: 200 }
    const c = joinCurve({ x: 0, y: 0 }, { x: 0, y: 1 }, target, { x: 1, y: 0 }, () => false)!
    expect(c.at(-1)!.x).toBeCloseTo(target.x, 6)
    expect(c.at(-1)!.y).toBeCloseTo(target.y, 6)
    const pts = [{ x: 0, y: 0 }, ...c].filter((q, i, all) => i === 0 || Math.hypot(q.x - all[i - 1].x, q.y - all[i - 1].y) >= 1)
    expect(maxBendDeg(pts)).toBeLessThanOrEqual(15)
  })
  it('a straight connector is sampled along the chord: a 5 m strip rejects a 40 m join', () => {
    const strip = (q: Pt) => q.x > 8 && q.x < 13
    expect(joinCurve({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 1 }, strip)).toBeNull()
    expect(joinCurve({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 1 }, () => false)).toEqual([{ x: 40, y: 0 }])
  })
  it('is null when a sample is rejected', () => {
    expect(joinCurve({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 200, y: 100 }, { x: 1, y: 0 }, (q) => q.x > 100)).toBeNull()
  })
})

const dry = { landform: 'inland', river: false, lakes: false, islands: false, metroSeed: 1, water: [], land: [], riverSlice: null } as Terrain
const lake = { ...dry, water: [[[[600, -100], [700, -100], [700, 600], [600, 600]]]] } as Terrain
const road = (id: string, pts: Pt[]): Road => ({ id, class: 'arterial', points: pts, width: 18, name: null })
const idx = (rs: Road[]) => { const i = new RoadIndex(200); rs.forEach((r) => i.add(r.id, r.points, 'arterial')); return i }
const run = (rs: Road[], t: Terrain = dry) => joinFreeEnds(rs, t, 2000, idx(rs), [], MAJOR.separation)
const line = (x0: number, y0: number, x1: number, y1: number): Pt[] => {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 10)
  return Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n }))
}
const near = (p: Pt, pts: Pt[]) => Math.min(...pts.map((q) => Math.hypot(p.x - q.x, p.y - q.y)))

describe('joinFreeEnds', () => {
  it('a free end curves into the nearest arterial ahead', () => {
    const A = road('A', line(100, 500, 500, 500)), B = road('B', line(800, 300, 800, 900))
    const r = run([A, B])
    expect(r.joined).toBeGreaterThanOrEqual(1)
    const a = r.roads[0].points
    expect(near(a.at(-1)!, B.points)).toBeLessThan(1)
    expect(maxBendDeg(a)).toBeLessThan(15 + 1e-6)
  })
  it('never joins its own road, and never across water', () => {
    // a spiral: the free end (450,450) heads west at its own first leg, 150 m ahead and >30 m from both road ends (the seg.id exclusion and the hairpin check each stop it; the test fails only without both)
    const own = road('A', [...line(300, 300, 300, 700), ...line(300, 700, 700, 700).slice(1), ...line(700, 700, 700, 450).slice(1), ...line(700, 450, 450, 450).slice(1)])
    expect(run([own]).joined).toBe(0)
    const r = run([road('A', line(100, 500, 500, 500)), road('B', line(800, 300, 800, 900))], lake)
    expect(r.joined).toBe(0)
  })
  it('ignores targets outside the heading cone', () => {
    const r = run([road('A', line(800, 500, 1200, 500)), road('B', line(800, 300, 800, 900))])
    expect(r.joined).toBe(0)
    expect(r.roads[0].points).toEqual(line(800, 500, 1200, 500))
  })
  it('a road ending on A stays anchored after A is re-smoothed', () => {
    const A = road('A', [...line(100, 800, 400, 800), ...line(400, 800, 500, 700), ...line(500, 700, 600, 700)])
    const C = road('C', line(400, 800, 400, 2000)) // ends on the window edge
    const B = road('B', line(900, 500, 900, 900))
    const r = run([A, C, B])
    expect(r.joined).toBeGreaterThanOrEqual(1) // B's own free ends may join too once passes repeat
    expect(near(r.roads[0].points.at(-1)!, B.points)).toBeLessThan(1)
    expect(near(C.points[0], r.roads[0].points)).toBeLessThan(6)
  })
  it('a road ending on the fillet leg of A stays anchored after A is re-smoothed', () => {
    const A = road('A', [{ x: 100, y: 800 }, { x: 500, y: 800 }, { x: 500, y: 600 }]) // 90° corner, fillet starts 60 m before it
    const C = road('C', line(480, 800, 480, 1900)) // ends on A's leg, 20 m from the corner
    const B = road('B', line(300, 300, 700, 300))
    const r = run([A, C, B])
    expect(r.joined).toBeGreaterThanOrEqual(1)
    expect(near(r.roads[0].points.at(-1)!, B.points)).toBeLessThan(1)
    expect(distToPolyline(C.points[0], r.roads[0].points)).toBeLessThan(1)
  })
})
