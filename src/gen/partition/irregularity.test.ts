import { describe, expect, it } from 'vitest'
import { irregularityField } from './irregularity'

describe('irregularityField', () => {
  it('is deterministic for a given seed', () => {
    const a = irregularityField(42)
    const b = irregularityField(42)
    const p = { x: 1234, y: -567 }
    expect(a(p)).toBe(b(p))
  })

  it('stays in range [0, 1]', () => {
    const field = irregularityField(7)
    for (let x = -3000; x <= 3000; x += 137) {
      for (let y = -3000; y <= 3000; y += 191) {
        const v = field({ x, y })
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is smooth: nearby points differ less than far-apart points, on average', () => {
    const field = irregularityField(99)
    let nearSum = 0
    let farSum = 0
    const n = 40
    for (let i = 0; i < n; i++) {
      const x = i * 733 - 15000
      const y = -i * 511 + 8000
      const a = field({ x, y })
      const near = field({ x: x + 15, y: y + 15 })
      const far = field({ x: x + 4000, y: y - 3500 })
      nearSum += Math.abs(a - near)
      farSum += Math.abs(a - far)
    }
    expect(nearSum / n).toBeLessThan(farSum / n)
  })
})
