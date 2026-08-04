import { describe, expect, it } from 'vitest'
import { contourWater } from './contour'

const win = { x: 0, y: 0, w: 1000, h: 1000 }
const area = (mp: number[][][][]) =>
  mp.reduce(
    (s, poly) =>
      s +
      poly.reduce((ps, ring, ri) => {
        let a = 0
        for (let i = 0; i < ring.length; i++) {
          const [x1, y1] = ring[i]
          const [x2, y2] = ring[(i + 1) % ring.length]
          a += x1 * y2 - x2 * y1
        }
        return ps + (ri === 0 ? Math.abs(a / 2) : -Math.abs(a / 2))
      }, 0),
    0,
  )

describe('contourWater', () => {
  it('circular lake: water area ≈ circle area', () => {
    // height < 0 inside a radius-250 circle at (500,500)
    const sample = (x: number, y: number) => (Math.hypot(x - 500, y - 500) - 250) / 1000
    const { water, land } = contourWater(sample, win, 128)
    const circle = Math.PI * 250 * 250
    expect(area(water)).toBeGreaterThan(circle * 0.93)
    expect(area(water)).toBeLessThan(circle * 1.07)
    expect(area(land)).toBeGreaterThan(1000 * 1000 - circle * 1.07)
  })
  it('half-plane coast: water on one side, land+water tile the window', () => {
    const sample = (x: number) => (x - 600) / 1000 // water where x > 600? no: height<0 where x<600
    const { water, land } = contourWater(sample, win, 128)
    expect(area(water)).toBeGreaterThan(1000 * 600 * 0.97)
    expect(area(water)).toBeLessThan(1000 * 600 * 1.03)
    expect(area(water) + area(land)).toBeGreaterThan(1000 * 1000 * 0.99)
    expect(area(water) + area(land)).toBeLessThan(1000 * 1000 * 1.01)
  })
  it('island: land polygon appears inside water', () => {
    const sample = (x: number, y: number) => (200 - Math.hypot(x - 500, y - 500)) / 1000
    const { water, land } = contourWater(sample, win, 128)
    expect(area(land)).toBeGreaterThan(Math.PI * 200 * 200 * 0.9)
    expect(area(water)).toBeGreaterThan(1000 * 1000 - Math.PI * 200 * 200 * 1.1 - 1)
  })
  it('dry window: empty water, land = window', () => {
    const { water, land } = contourWater(() => 0.5, win, 32)
    expect(water).toEqual([])
    expect(area(land)).toBeCloseTo(1000 * 1000, -2)
  })
  it('is deterministic', () => {
    const sample = (x: number, y: number) => (Math.hypot(x - 500, y - 500) - 250) / 1000
    expect(contourWater(sample, win, 64)).toEqual(contourWater(sample, win, 64))
  })
  it('water area grows monotonically with the threshold (spec §7)', () => {
    const sample = (x: number, y: number) => (Math.hypot(x - 500, y - 500) - 250) / 1000
    const a0 = area(contourWater(sample, win, 64).water)
    const a1 = area(contourWater((x, y) => sample(x, y) - 0.05, win, 64).water)
    const a2 = area(contourWater((x, y) => sample(x, y) - 0.1, win, 64).water)
    expect(a1).toBeGreaterThan(a0)
    expect(a2).toBeGreaterThan(a1)
  })
})
