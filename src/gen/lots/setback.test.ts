import { describe, expect, it } from 'vitest'
import { ringArea } from '../geometry'
import type { Road, Terrain } from '../types'
import { RoadIndex } from '../streets/trace'
import { buildable, edgeSetbacks, sidesOf, type SetbackCtx } from './setback'
import { circleRing, distToRing, dryTerrain, expectBox, rectPoly } from './fixtures'

const road = (id: string, cls: Road['class'], points: Road['points']): Road => ({ id, class: cls, points, width: 9, name: null })
const roads = [
  road('S', 'street', [{ x: -50, y: 0 }, { x: 250, y: 0 }]),
  road('A', 'arterial', [{ x: 200, y: -50 }, { x: 200, y: 250 }]),
]
const index = new RoadIndex(50)
for (const r of roads) index.add(r.id, r.points, r.class)
const bay: Terrain = { ...dryTerrain, water: [[[[0, 120], [400, 120], [400, 400], [0, 400]]]] }
const ctx: SetbackCtx = { index, terrain: bay, sizeM: 200, grounds: [] }

describe('setback per side', () => {
  it('street, arterial, water and window edges', () => {
    const fp = rectPoly(0, 0, 200, 120)
    expect(edgeSetbacks(fp, ctx)).toEqual([7.5, 12, 5, 0])
    const [b] = buildable(fp, [7.5, 12, 5, 0])
    expectBox(b, { x0: 0, y0: 7.5, x1: 188, y1: 115 }, 0.01)
  })
  it('a reflex vertex joins on its bisector', () => {
    const L = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 }]
    const [b] = buildable(L, [7.5, 7.5, 12, 7.5, 7.5, 7.5])
    const onBis = b.filter((p) => Math.abs((p.x - 50) - (p.y - 50)) < 0.01 && p.x > 30 && p.x < 50) // reflex: inward of (50, 50), (38, 38) and (42.5, 42.5)
    expect(onBis).toHaveLength(2)
  })
  it('a 175° vertex makes no spike', () => {
    const fp = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 8.75 }, { x: 200, y: 120 }, { x: 0, y: 120 }]
    for (const p of buildable(fp, [7.5, 26, 7.5, 7.5, 7.5])[0]) expect(distToRing(p, fp)).toBeLessThanOrEqual(2 * 26 + 0.01)
  })
  it('clockwise dense shore ring', () => {
    const shore = circleRing({ x: 0, y: 0 }, 150, 200).reverse()
    const out = buildable(shore, shore.map(() => 5))
    expect(out).toHaveLength(1); expect(ringArea(out[0])).toBeGreaterThan(0)
    expect(Math.abs(ringArea(out[0]) - Math.PI * 145 ** 2)).toBeLessThan(0.01 * Math.PI * 145 ** 2)
  })
  it('sides break at 25° and at a class change', () => {
    const s = sidesOf(rectPoly(0, 0, 100, 60), [7.5, 7.5, 12, 7.5])
    expect(s.map((x) => x.setback)).toEqual([7.5, 7.5, 12, 7.5]); expect(sidesOf(circleRing({ x: 0, y: 0 }, 100, 72))).toHaveLength(1)
  })
})
