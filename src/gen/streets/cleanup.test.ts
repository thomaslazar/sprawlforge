import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import type { Road, RoadClass } from '../types'
import { weldConverging } from './cleanup'
import { RoadIndex } from './trace'

const line = (...p: [number, number][]): Pt[] => p.map(([x, y]) => ({ x, y }))
const road = (id: string, points: Pt[], cls: RoadClass = 'street'): Road => ({ id, class: cls, points, width: 9, name: null })
const setup = (other: Road, b: Road) => {
  const index = new RoadIndex(200)
  index.add(other.id, other.points, other.class)
  index.add(b.id, b.points, b.class)
  return index
}
const A = road('A', line([0, 0], [400, 0]), 'arterial')

describe('weldConverging', () => {
  it('welds at first contact: a street running 4 m beside a road is cut at its first near sample, onto the road', () => {
    const B = road('S001', line([0, 150], [100, 40], [120, 4], [180, 4], [250, 4], [330, 4], [330, 150], [330, 300]))
    const [out] = weldConverging([B], setup(A, B))
    const end = out.points.at(-1)!
    expect(distToPolyline(end, A.points)).toBeLessThanOrEqual(1)
    expect(end.x).toBeLessThan(160)
    expect(out.points.length).toBeGreaterThan(1)
    expect(out.id).toBe('S001')
  })
  it('a street starting on a road and running along it keeps the tail, welded on the road', () => {
    const B = road('S002', line([50, 0], [80, 3], [200, 3], [230, 120], [230, 300]))
    const [out] = weldConverging([B], setup(A, B))
    expect(distToPolyline(out.points[0], A.points)).toBeLessThanOrEqual(1)
    expect(out.points[0].x).toBeGreaterThan(150)
    expect(out.points.at(-1)).toEqual({ x: 230, y: 300 })
  })
  it('a street crossing at 60 degrees is unchanged', () => {
    const B = road('S003', line([0, -200], [231, 200]))
    const out = weldConverging([B], setup(A, B))
    expect(out).toEqual([B])
  })
  it('drops what remains under 60 m', () => {
    const B = road('S004', line([0, 40], [30, 4], [200, 4], [300, 4]))
    expect(weldConverging([B], setup(A, B))).toEqual([])
  })
  it('never cuts a frontage road', () => {
    const B = road('F1L', line([0, 150], [100, 40], [120, 4], [330, 4], [330, 300]))
    expect(weldConverging([B], setup(A, B))).toEqual([B])
  })
})
