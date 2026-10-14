import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import { distToPolyline } from '../terrain/rivers'
import type { Road, RoadClass } from '../types'
import { dropStreetHairpins, weldConverging } from './cleanup'
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
    expect(out.id).toBe('S001-1') // the run is in the middle: the part before it is the first of two
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

describe('weldConverging: crossings and boundaries', () => {
  const cross = (deg: number) => {
    const t = (deg * Math.PI) / 180
    return road('S010', line([200 - 200 * Math.cos(t), -200 * Math.sin(t)], [200 + 200 * Math.cos(t), 200 * Math.sin(t)]))
  }
  it('a street crossing a road at 20 degrees is unchanged', () => {
    const B = cross(20)
    expect(weldConverging([B], setup(A, B))).toEqual([B])
  })
  it('a street crossing a road at 45 degrees is unchanged', () => {
    const B = cross(45)
    expect(weldConverging([B], setup(A, B))).toEqual([B])
  })
  it('a run that ends in a crossing is still a crossing', () => {
    const B = road('S011', line([0, 4], [150, 4], [190, 4], [260, -150]))
    expect(weldConverging([B], setup(A, B))).toEqual([B])
  })
  it('a run of exactly 20 m is unchanged, 25 m is cut (arc, not sample count)', () => {
    const start = (len: number) => road('S012', line([100, 4], [100 + len, 4], [100 + len, 300]))
    const exact = start(20)
    expect(weldConverging([exact], setup(A, exact))).toEqual([exact])
    const longer = start(25)
    const [out] = weldConverging([longer], setup(A, longer))
    expect(distToPolyline(out.points[0], A.points)).toBeLessThanOrEqual(1)
    expect(out.points[0].x).toBeGreaterThan(110)
  })
  it('mutual doubles lose only one street', () => {
    const X = road('S020', line([0, 300], [400, 300]))
    const Y = road('S021', line([0, 304], [400, 304]))
    const index = new RoadIndex(200)
    for (const r of [X, Y]) index.add(r.id, r.points, r.class)
    expect(weldConverging([X, Y], index).map((r) => r.id)).toEqual(['S021'])
  })
  it('a later street is judged against the earlier street cut polyline', () => {
    // B is cut at x < 160; C runs 6 m beside the removed part of B (10 m from A), so it is no longer a double
    const B = road('S030', line([0, 150], [100, 40], [120, 4], [180, 4], [250, 4], [330, 4], [330, 150], [330, 300]))
    const C = road('S031', line([200, 10], [320, 10], [320, 300]))
    const index = new RoadIndex(200)
    for (const r of [A, B, C]) index.add(r.id, r.points, r.class)
    const out = weldConverging([B, C], index)
    expect(out.map((r) => r.id)).toEqual(['S030-1', 'S030-2', 'S031'])
    expect(out[0].points.length).toBeLessThan(B.points.length)
    expect(out[2]).toEqual(C)
  })
  it('a K road is never cut', () => {
    const K = road('K1L', line([0, 150], [100, 40], [120, 4], [330, 4], [330, 300]))
    expect(weldConverging([K], setup(A, K))).toEqual([K])
  })
  it('a ramp and the highway are not targets', () => {
    const run = (cls: RoadClass) => {
      const T = road('T', line([0, 0], [400, 0]), cls)
      const B = road('S040', line([0, 150], [100, 40], [120, 4], [330, 4], [330, 300]))
      return weldConverging([B], setup(T, B))
    }
    for (const cls of ['ramp', 'highway'] as RoadClass[]) expect(run(cls)).toHaveLength(1)
    expect(run('ramp')[0].points).toHaveLength(5)
    expect(run('highway')[0].points).toHaveLength(5)
  })
})

describe('dropStreetHairpins', () => {
  const run = (...rs: Road[]) => {
    const index = new RoadIndex(200)
    rs.forEach((r) => index.add(r.id, r.points, r.class))
    return dropStreetHairpins(rs.filter((r) => r.class === 'street'), index).map((r) => r.id)
  }
  it('drops a 70 m U with both ends on one road 25 m apart', () => {
    expect(run(A, road('S1', line([100, 0], [100, 22], [125, 22], [125, 0])))).toEqual([])
  })
  it('keeps a 70 m street between two different roads', () => {
    const A2 = road('A2', line([0, 70], [400, 70]), 'arterial')
    expect(run(A, A2, road('S1', line([100, 0], [100, 70])))).toEqual(['S1'])
  })
  it('keeps a 300 m crescent on one road', () => {
    expect(run(A, road('S1', line([100, 0], [100, 100], [300, 100], [300, 0])))).toEqual(['S1'])
  })
})

describe('weldConverging: a run in the middle', () => {
  it('keeps both parts, each welded on the road, nothing dropped (S152 shape)', () => {
    // runs beside A from x=150 to 200 (50 m), the tail carries on and is short (45 m)
    const B = road('S152', line([150, 300], [150, 4], [200, 4], [200, 49]))
    const out = weldConverging([B], setup(A, B))
    expect(out.map((r) => r.id)).toEqual(['S152-1', 'S152-2'])
    expect(distToPolyline(out[0].points.at(-1)!, A.points)).toBeLessThanOrEqual(1)
    expect(distToPolyline(out[1].points[0], A.points)).toBeLessThanOrEqual(1)
    expect(out[1].points.at(-1)).toEqual({ x: 200, y: 49 })
    expect(out[1].points[0].x).toBeGreaterThan(out[0].points.at(-1)!.x)
  })
})
