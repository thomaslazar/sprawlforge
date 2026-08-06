import { describe, expect, it } from 'vitest'
import type { Road, Terrain } from '../types'
import { clipRoadsToLand, inWater, planBridges, truncateOverSpanRoads, truncateUnlandableRoads } from './bridges'

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

describe('clipRoadsToLand', () => {
  it('splits streets at water and keeps land parts', () => {
    const out = clipRoadsToLand([road('S001', 'street', 300)], banded)
    expect(out.length).toBe(2)
    for (const r of out) {
      for (const p of r.points) {
        expect(p.x < 460 || p.x > 540).toBe(true)
      }
    }
  })
  it('leaves arterials alone', () => {
    const out = clipRoadsToLand([road('A01', 'arterial', 300)], banded)
    expect(out).toEqual([road('A01', 'arterial', 300)])
  })
})

describe('planBridges', () => {
  it('bridges an arterial across the river, perpendicular to flow', () => {
    const bridges = planBridges([road('A01', 'arterial', 300)], banded)
    expect(bridges.length).toBe(1)
    const b = bridges[0]
    expect(b.bridge).toBe(true)
    expect(b.class).toBe('arterial')
    const [p, q] = b.points
    const angle = Math.atan2(q.y - p.y, q.x - p.x)
    // river flows along +y here, so a perpendicular bridge is horizontal
    expect(Math.abs(Math.sin(angle))).toBeLessThan(Math.sin((25 * Math.PI) / 180))
    // spans the water with a little landing on each side
    expect(Math.min(p.x, q.x)).toBeLessThan(450)
    expect(Math.max(p.x, q.x)).toBeGreaterThan(550)
  })
  it('is deterministic', () => {
    expect(planBridges([road('A01', 'arterial', 300)], banded))
      .toEqual(planBridges([road('A01', 'arterial', 300)], banded))
  })
  it('no bridges on dry terrain', () => {
    const dry: Terrain = {
      landform: 'inland', river: false, lakes: false, islands: false, metroSeed: 1,
      water: [], land: [[[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]]], riverSlice: null,
    }
    expect(planBridges([road('A01', 'arterial', 300)], dry)).toEqual([])
  })
})

// hand terrain: a 600 m water band — wider than arterial's MAX_SPAN (450) but
// narrower than highway's (900)
const wideBand: Terrain = {
  landform: 'inland', river: true, lakes: false, islands: false, metroSeed: 1,
  water: [[[[200, 0], [800, 0], [800, 1000], [200, 1000]]]],
  land: [
    [[[0, 0], [200, 0], [200, 1000], [0, 1000]]],
    [[[800, 0], [1000, 0], [1000, 1000], [800, 1000]]],
  ],
  riverSlice: null,
}

describe('truncateOverSpanRoads', () => {
  it('truncates an arterial whose crossing exceeds MAX_SPAN, and it gets no bridge', () => {
    const grounded = clipRoadsToLand([road('A01', 'arterial', 300)], wideBand)
    const truncated = truncateOverSpanRoads(grounded, wideBand)
    expect(truncated.length).toBe(2)
    for (const r of truncated) for (const p of r.points) expect(inWater(wideBand, p)).toBe(false)
    expect(planBridges(truncated, wideBand)).toEqual([])
  })
  it('leaves a highway whole over the same band (within MAX_SPAN) and still bridges it', () => {
    const grounded = clipRoadsToLand([road('H1', 'highway', 300)], wideBand)
    const truncated = truncateOverSpanRoads(grounded, wideBand)
    expect(truncated).toEqual(grounded)
    const bridges = planBridges(truncated, wideBand)
    expect(bridges.length).toBe(1)
    expect(bridges[0].class).toBe('highway')
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

describe('sea bridges roughly perpendicular to the shoreline', () => {
  it('rejects a crossing nearly parallel to the coast (15° off shoreline): no bridge, road truncated', () => {
    const road = diagRoad('A01', 45) // shoreline runs at 60° — 15° off it
    const grounded = clipRoadsToLand([road], diagonalFinger)
    const spanTruncated = truncateOverSpanRoads(grounded, diagonalFinger)
    expect(spanTruncated).toEqual(grounded) // crossing is well within MAX_SPAN
    expect(planBridges(spanTruncated, diagonalFinger)).toEqual([])
    const truncated = truncateUnlandableRoads(spanTruncated, diagonalFinger)
    expect(truncated.length).toBe(2)
    for (const r of truncated) for (const p of r.points) expect(inWater(diagonalFinger, p)).toBe(false)
  })
  it('keeps a bridge for a crossing perpendicular to the coast (90° off shoreline)', () => {
    const road = diagRoad('A02', -30) // perpendicular to the 60° shoreline tangent
    const grounded = clipRoadsToLand([road], diagonalFinger)
    const spanTruncated = truncateOverSpanRoads(grounded, diagonalFinger)
    const bridges = planBridges(spanTruncated, diagonalFinger)
    expect(bridges.length).toBe(1)
    expect(bridges[0].class).toBe('arterial')
  })
})

describe('unlandable crossings (bridge would end in open water)', () => {
  it('planBridges refuses to bridge a crossing whose landing is still in water', () => {
    const grounded = clipRoadsToLand([road('A01', 'arterial', 300)], edgeWater)
    const spanTruncated = truncateOverSpanRoads(grounded, edgeWater)
    // span (200m) is well within arterial's MAX_SPAN, so the old code would
    // have bridged this — but the far landing sits at the map edge, in water
    expect(planBridges(spanTruncated, edgeWater)).toEqual([])
  })
  it('truncateUnlandableRoads cuts the host road at the waterline instead', () => {
    const grounded = clipRoadsToLand([road('A01', 'arterial', 300)], edgeWater)
    const spanTruncated = truncateOverSpanRoads(grounded, edgeWater)
    const truncated = truncateUnlandableRoads(spanTruncated, edgeWater)
    expect(truncated.length).toBe(1)
    for (const r of truncated) for (const p of r.points) expect(inWater(edgeWater, p)).toBe(false)
    expect(planBridges(truncated, edgeWater)).toEqual([])
  })
  it('leaves a genuinely bridgeable crossing (both banks landable) untouched', () => {
    // sanity check: truncateUnlandableRoads must not disturb the existing
    // both-banks river crossing that planBridges already bridges correctly
    const grounded = clipRoadsToLand([road('A01', 'arterial', 300)], banded)
    const spanTruncated = truncateOverSpanRoads(grounded, banded)
    const truncated = truncateUnlandableRoads(spanTruncated, banded)
    expect(truncated).toEqual(spanTruncated)
    expect(planBridges(truncated, banded).length).toBe(1)
  })
})
