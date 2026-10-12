import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import { joinCurve } from './join'

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
    const c = joinCurve({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 200, y: 100 }, () => false)!
    expect(c.at(-1)).toEqual({ x: 200, y: 100 })
    expect(Math.abs(c[0].y / c[0].x)).toBeLessThan(0.2)
    expect(maxBendDeg([{ x: 0, y: 0 }, ...c])).toBeLessThan(15)
  })
  it('is null when a sample is rejected', () => {
    expect(joinCurve({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 200, y: 100 }, (q) => q.x > 100)).toBeNull()
  })
})
