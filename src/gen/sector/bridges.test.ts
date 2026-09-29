import { describe, expect, it } from 'vitest'
import type { Road, Terrain } from '../types'
import { inWater, markWetSpans, truncateUnlandableRoads, waterIntervals } from './bridges'

// hand terrain: vertical river band x∈[450,550] in a 1000² window
const banded: Terrain = {
  landform: 'inland', river: true, lakes: false, islands: false, metroSeed: 1,
  water: [[[[450, 0], [550, 0], [550, 1000], [450, 1000]]]],
  land: [
    [[[0, 0], [450, 0], [450, 1000], [0, 1000]]],
    [[[550, 0], [1000, 0], [1000, 1000], [550, 1000]]],
  ],
  riverSlice: { course: [{ x: 500, y: -100 }, { x: 500, y: 1100 }], width: 100 },
}
const road = (id: string, cls: Road['class'], y: number): Road => ({
  id, class: cls, points: [{ x: 0, y }, { x: 1000, y }], width: cls === 'street' ? 9 : 18, name: null,
})

describe('inWater / waterIntervals', () => {
  it('inWater tests the water rings', () => {
    expect(inWater(banded, { x: 500, y: 10 })).toBe(true)
    expect(inWater(banded, { x: 100, y: 10 })).toBe(false)
  })
  it('waterIntervals brackets the river with dry-sample bounds', () => {
    const iv = waterIntervals(banded, road('A01', 'arterial', 300).points)
    expect(iv).toHaveLength(1)
    const [t0, t1] = iv[0]
    expect(t0 * 1000).toBeLessThanOrEqual(450)
    expect(t0 * 1000).toBeGreaterThan(430)
    expect(t1 * 1000).toBeGreaterThanOrEqual(550)
    expect(t1 * 1000).toBeLessThan(570)
  })
})

describe('markWetSpans', () => {
  it('splits a river-crossing road into dry-wet-dry with the wet piece bridged', () => {
    const out = markWetSpans([road('A01', 'arterial', 300)], banded)
    expect(out.map((r) => r.id)).toEqual(['A01-1', 'A01-b1', 'A01-2'])
    expect(out.map((r) => !!r.bridge)).toEqual([false, true, false])
    const wet = out[1]
    const xs = wet.points.map((p) => p.x)
    expect(Math.min(...xs)).toBeLessThan(450)
    expect(Math.max(...xs)).toBeGreaterThan(550)
    // landings stay on dry land
    expect(inWater(banded, wet.points[0])).toBe(false)
    expect(inWater(banded, wet.points[wet.points.length - 1])).toBe(false)
  })
  it('a fully dry road is returned unchanged (same object)', () => {
    const r = road('A02', 'arterial', 300)
    const dry: Terrain = { ...banded, water: [[[[700, 0], [750, 0], [750, 100], [700, 100]]]] }
    expect(markWetSpans([r], dry)[0]).toBe(r)
    expect(markWetSpans([r], { ...banded, water: [] })[0]).toBe(r)
  })
  it('a road ending in water gets a wet piece reaching its end', () => {
    const out = markWetSpans([road('H1', 'highway', 300)], edgeWater)
    expect(out.map((r) => !!r.bridge)).toEqual([false, true])
    const wet = out[1]
    expect(wet.points[wet.points.length - 1]).toEqual({ x: 1000, y: 300 })
  })
})

// hand terrain: water fills the map's right edge and keeps going past it —
// a road that enters here never re-emerges onto land before the map bound,
// so any "landing" beyond the water's start is still in open water (the
// coastal/diagonal-corner case from the bug report, simplified to a band).
const edgeWater: Terrain = {
  landform: 'coastal', river: false, lakes: false, islands: false,
  metroSeed: 1,
  water: [[[[805, 0], [1500, 0], [1500, 1000], [805, 1000]]]],
  land: [[[[0, 0], [805, 0], [805, 1000], [0, 1000]]]],
  riverSlice: null,
}

// hand terrain: a diagonal water "finger" whose shoreline (long edges) runs
// at 60° to the x-axis. A road crossing nearly parallel to that shoreline
// travels a long diagonal path through the water (not an honest crossing);
// one crossing it near-perpendicular makes a short, honest crossing.
const shoreAngle = (60 * Math.PI) / 180
const shoreDir = { x: Math.cos(shoreAngle), y: Math.sin(shoreAngle) }
const shoreNormal = { x: -shoreDir.y, y: shoreDir.x }
const fingerCenter = { x: 500, y: 500 }
const fingerHalfWidth = 20
const fingerHalfLen = 1000
const fingerCorner = (alongSign: number, acrossSign: number): [number, number] => [
  fingerCenter.x + shoreDir.x * fingerHalfLen * alongSign + shoreNormal.x * fingerHalfWidth * acrossSign,
  fingerCenter.y + shoreDir.y * fingerHalfLen * alongSign + shoreNormal.y * fingerHalfWidth * acrossSign,
]
const diagonalFinger: Terrain = {
  landform: 'coastal', river: false, lakes: false, islands: false, metroSeed: 1,
  water: [[[fingerCorner(1, 1), fingerCorner(1, -1), fingerCorner(-1, -1), fingerCorner(-1, 1)]]],
  land: [[[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]]], // placeholder — bridges.ts never reads terrain.land
  riverSlice: null,
}
const diagRoad = (id: string, angleDeg: number): Road => {
  const rad = (angleDeg * Math.PI) / 180
  const dir = { x: Math.cos(rad), y: Math.sin(rad) }
  return {
    id,
    class: 'arterial',
    points: [
      { x: fingerCenter.x - dir.x * 700, y: fingerCenter.y - dir.y * 700 },
      { x: fingerCenter.x + dir.x * 700, y: fingerCenter.y + dir.y * 700 },
    ],
    width: 18,
    name: null,
  }
}

describe('truncateUnlandableRoads', () => {
  it('rejects a crossing nearly parallel to the coast (15° off shoreline): road truncated', () => {
    const truncated = truncateUnlandableRoads([diagRoad('A01', 45)], diagonalFinger)
    expect(truncated.length).toBe(2)
    for (const r of truncated) for (const p of r.points) expect(inWater(diagonalFinger, p)).toBe(false)
  })
  it('keeps a crossing perpendicular to the coast (90° off shoreline) untouched', () => {
    const r = diagRoad('A02', -30)
    expect(truncateUnlandableRoads([r], diagonalFinger)).toEqual([r])
  })
  it('cuts a host whose landing is still in open water at the waterline', () => {
    const truncated = truncateUnlandableRoads([road('A01', 'arterial', 300)], edgeWater)
    expect(truncated.length).toBe(1)
    for (const r of truncated) for (const p of r.points) expect(inWater(edgeWater, p)).toBe(false)
  })
  it('leaves a bridgeable river crossing untouched', () => {
    const r = road('A01', 'arterial', 300)
    expect(truncateUnlandableRoads([r], banded)).toEqual([r])
  })
})
