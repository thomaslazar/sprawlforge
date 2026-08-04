import { describe, expect, it } from 'vitest'
import type { Road, Terrain } from '../types'
import { clipRoadsToLand, inWater, planBridges, truncateOverSpanRoads } from './bridges'

// hand terrain: vertical river band x∈[450,550] in a 1000² window
const banded: Terrain = {
  kind: 'river', metroSeed: 1,
  water: [[[[450, 0], [550, 0], [550, 1000], [450, 1000]]]],
  land: [
    [[[0, 0], [450, 0], [450, 1000], [0, 1000]]],
    [[[550, 0], [1000, 0], [1000, 1000], [550, 1000]]],
  ],
  river: { course: [{ x: 500, y: -100 }, { x: 500, y: 1100 }], width: 100 },
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
    const dry: Terrain = { kind: 'inland', metroSeed: 1, water: [], land: [[[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]]], river: null }
    expect(planBridges([road('A01', 'arterial', 300)], dry)).toEqual([])
  })
})

// hand terrain: a 600 m water band — wider than arterial's MAX_SPAN (450) but
// narrower than highway's (900)
const wideBand: Terrain = {
  kind: 'river', metroSeed: 1,
  water: [[[[200, 0], [800, 0], [800, 1000], [200, 1000]]]],
  land: [
    [[[0, 0], [200, 0], [200, 1000], [0, 1000]]],
    [[[800, 0], [1000, 0], [1000, 1000], [800, 1000]]],
  ],
  river: null,
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
