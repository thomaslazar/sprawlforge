import { describe, expect, it } from 'vitest'
import { boxRing, fitBox, widthOk } from './fitbox'
import { arc, insideOrOn, rectPoly } from './fixtures'

describe('fitbox', () => {
  it('fit box', () => {                                           // T2: front arc of 10° bulging into the lot, sagitta 0.437 m
    const lot = [...arc({ x: 0, y: 0 }, { x: 20, y: 0 }, 10, 6, 'inward'), { x: 20, y: 30 }, { x: 0, y: 30 }]
    const b = fitBox(lot, [{ x: 0, y: 0 }, { x: 20, y: 0 }])
    expect(Math.abs(b.w - 20)).toBeLessThanOrEqual(1); expect(Math.abs(b.d - 29.563)).toBeLessThanOrEqual(1)
    for (const p of boxRing(b)) expect(insideOrOn(p, lot, 0.05)).toBe(true)
  })
  it('fit box of a trapezoid keeps the front on the innermost frontage point', () => {
    const b = fitBox([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 30 }], [{ x: 0, y: 0 }, { x: 30, y: 0 }])
    expect(b.w * b.d).toBeGreaterThanOrEqual(30 * 20 - 30)       // 1 m grid
  })
  it('fit box of a 600 × 400 m lot', () => {
    const t = performance.now(), b = fitBox(rectPoly(0, 0, 600, 400), [{ x: 0, y: 0 }, { x: 600, y: 0 }])
    expect(b.w).toBeGreaterThanOrEqual(599); expect(b.d).toBeGreaterThanOrEqual(399); expect(performance.now() - t).toBeLessThan(200)
  })
  it('fit box takes the inward side of either ring orientation', () => {
    const b = fitBox([...rectPoly(0, 0, 20, 30)].reverse(), [{ x: 0, y: 0 }, { x: 20, y: 0 }])
    expect(b.w * b.d).toBeGreaterThanOrEqual(19 * 30)
  })
  it('widthOk', () => { expect(widthOk(rectPoly(0, 0, 6, 20), 6)).toBe(true); expect(widthOk(rectPoly(0, 0, 5, 20), 6)).toBe(false) })
})
