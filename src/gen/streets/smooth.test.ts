import { describe, expect, it } from 'vitest'
import type { Pt } from '../geometry'
import { smoothBends } from './smooth'

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

describe('smoothBends', () => {
  it('a right angle becomes an arc of the requested radius with sharp endpoints', () => {
    const out = smoothBends([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }], 60)
    expect(out[0]).toEqual({ x: 0, y: 0 }); expect(out.at(-1)).toEqual({ x: 200, y: 200 })
    expect(maxBendDeg(out)).toBeLessThan(15 + 1e-6)
    // arc centre (140, 60): every point of the arc is 60 m from it
    const arc = out.filter((p) => p.x > 140 && p.y < 60)
    expect(arc.length).toBeGreaterThan(3)
    for (const p of arc) expect(Math.hypot(p.x - 140, p.y - 60)).toBeCloseTo(60, 6)
  })
  it('short legs shrink the radius to fit', () => {
    const out = smoothBends([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }], 60)
    expect(out[0]).toEqual({ x: 0, y: 0 }); expect(out.at(-1)).toEqual({ x: 40, y: 40 })
    expect(maxBendDeg(out)).toBeLessThan(45) // radius 20 → 90° over 3 samples of 10 m
  })
  it('a straight or gently bending line is unchanged', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 10 }]
    expect(smoothBends(pts, 60)).toEqual(pts)
  })
  it('a pinned vertex is kept', () => {
    const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }]
    expect(smoothBends(pts, 60, (v) => v.x === 200 && v.y === 0)).toEqual(pts)
  })
})
