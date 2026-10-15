import { describe, expect, it } from 'vitest'
import { boxRing, fitBox, widthOk } from './fitbox'
import { arc, insideOrOn, rectPoly } from './fixtures'

describe('fitbox', () => {
  it('fit box', () => {                                           // T2: front arc of 10° bulging into the lot, sagitta 0.437 m
    const lot = [...arc({ x: 0, y: 0 }, { x: 20, y: 0 }, 10, 6, 'inward'), { x: 20, y: 30 }, { x: 0, y: 30 }]
    const b = fitBox(lot, [{ x: 0, y: 0 }, { x: 20, y: 0 }])
    expect(Math.abs(b.w - 20)).toBeLessThanOrEqual(1); expect(Math.abs(b.d - 29.563)).toBeLessThanOrEqual(1); expect(b.d).toBeLessThanOrEqual(29.6) // a box ignoring the arc would be 30 deep
    const [f0, f1] = boxRing(b); expect(insideOrOn({ x: (f0.x + f1.x) / 2, y: (f0.y + f1.y) / 2 }, lot, 0.05)).toBe(true) // front midpoint rides the arc, y ~ 0.42
    for (const p of boxRing(b)) expect(insideOrOn(p, lot, 0.05)).toBe(true)
  })
  it('fit box of a trapezoid keeps the front on the innermost frontage point', () => {
    const b = fitBox([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 30 }], [{ x: 0, y: 0 }, { x: 30, y: 0 }])
    expect(b.w * b.d).toBeGreaterThanOrEqual(30 * 20 - 30)       // 1 m grid
  })
  it('fit box front sits on the innermost frontage point of a rising front', () => {
    // front y = x/6 (0 -> 5 m over 30 m), back 30: area(x0 = 0, w) = w(30 - w/6), best at w = 30 (vertex 45 is out of range) -> 30 x 25 = 750
    const b = fitBox([{ x: 0, y: 0 }, { x: 30, y: 5 }, { x: 30, y: 30 }, { x: 0, y: 30 }], [{ x: 0, y: 0 }, { x: 30, y: 0 }])
    expect(Math.abs(b.origin.y - 5)).toBeLessThanOrEqual(0.05); expect(b.w * b.d).toBeGreaterThanOrEqual(750 - 1); expect(b.w * b.d).toBeLessThanOrEqual(750.01)
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
