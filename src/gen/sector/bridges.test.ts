import { describe, expect, it } from 'vitest'
import type { Road, Terrain } from '../types'
import {
  clipRoadsToLand,
  inWater,
  planBridges,
  splitHostAtBridges,
  truncateOverSpanRoads,
  truncateUnlandableRoads,
} from './bridges'

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

// hand terrain: a vertical water strip x0..x1 spanning the 1000 window,
// land = the two side slabs, no river — for polyline-road tests below
const stripTerrain = (x0: number, x1: number): Terrain => ({
  landform: 'inland', river: false, lakes: false, islands: false, metroSeed: 1,
  water: [[[[x0, 0], [x1, 0], [x1, 1000], [x0, 1000]]]],
  land: [
    [[[0, 0], [x0, 0], [x0, 1000], [0, 1000]]],
    [[[x1, 0], [1000, 0], [1000, 1000], [x1, 1000]]],
  ],
  riverSlice: null,
})

describe('polyline roads', () => {
  it('clips a polyline street to land keeping interior vertices', () => {
    const road: Road = {
      id: 'S001', class: 'street', width: 9, name: null,
      points: [{ x: 0, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 500 }, { x: 900, y: 500 }],
    }
    const out = clipRoadsToLand([road], stripTerrain(400, 600))
    // piece 1 must contain the corner (300,100)->(300,500) intact
    const first = out[0]
    expect(first.points.some((p) => p.x === 300 && p.y === 100)).toBe(true)
    expect(first.points.some((p) => p.x === 300 && p.y === 500)).toBe(true)
    // no kept point may be inside the strip
    for (const r of out) for (const p of r.points) {
      expect(p.x < 405 || p.x > 595).toBe(true)
    }
  })

  it('bridges a polyline arterial with a straight 2-point deck', () => {
    const road: Road = {
      id: 'A01', class: 'arterial', width: 18, name: null,
      points: [{ x: 0, y: 100 }, { x: 350, y: 120 }, { x: 900, y: 100 }],
    }
    const bridges = planBridges([road], stripTerrain(400, 600))
    expect(bridges).toHaveLength(1)
    expect(bridges[0].points).toHaveLength(2)
    expect(bridges[0].bridge).toBe(true)
    // both landings fall in [400,900] so they sit on the bent second segment
    // (350,120)->(900,100), not on the straight (0,100)->(900,100) chord —
    // check each landing's y against that segment's own line equation
    const [p, q] = bridges[0].points
    for (const pt of [p, q]) {
      const expectedY = 120 + ((pt.x - 350) / (900 - 350)) * (100 - 120)
      expect(pt.y).toBeCloseTo(expectedY, 6)
    }
  })

  it('splitHostAtBridges cuts a 3+ point host at the landing points, keeping the dry interior vertex', () => {
    const road: Road = {
      id: 'A01', class: 'arterial', width: 18, name: null,
      points: [{ x: 0, y: 300 }, { x: 200, y: 300 }, { x: 1000, y: 300 }],
    }
    const out = splitHostAtBridges([road], stripTerrain(400, 600))
    expect(out).toHaveLength(2)
    for (const r of out) for (const p of r.points) {
      expect(p.x < 400 || p.x > 600).toBe(true)
    }
    // landings sit LANDING=15m onto land from the strip edge, plus up to one
    // 10m sampling step of dry-rounding slop — road is straight and colinear
    // through the crossing, so x-distance is exact arc-length distance
    const firstEnd = out[0].points[out[0].points.length - 1]
    const secondStart = out[1].points[0]
    expect(400 - firstEnd.x).toBeGreaterThanOrEqual(14)
    expect(400 - firstEnd.x).toBeLessThanOrEqual(26)
    expect(secondStart.x - 600).toBeGreaterThanOrEqual(14)
    expect(secondStart.x - 600).toBeLessThanOrEqual(26)
    // interior dry-side vertex (200,300) survives intact in the first piece
    expect(out[0].points.some((p) => p.x === 200 && p.y === 300)).toBe(true)
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
