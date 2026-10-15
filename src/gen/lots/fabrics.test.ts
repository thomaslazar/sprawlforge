import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../rng'
import { FABRIC_WEIGHTS, chooseFabric, densityClass, fabricRow, sheetZone } from './fabrics'

describe('fabrics', () => {
  it('fabric weights sum to 100', () => { for (const [k, row] of Object.entries(FABRIC_WEIGHTS)) expect(row.reduce((a, [, w]) => a + w, 0), k).toBe(100) })
  it('fabric shares follow the weights', () => {
    const n = 20000, got = new Map<string, number>()
    for (let i = 0; i < n; i++) { const f = chooseFabric('commerce', 'dense', (i * 0.6180339887) % 1, mulberry32(i), () => true); got.set(f, (got.get(f) ?? 0) + 1) }
    for (const [f, w] of FABRIC_WEIGHTS['commerce']) expect(Math.abs((got.get(f) ?? 0) / n - w / 100), f).toBeLessThan(0.015)
  })
  it('blocks in one cell take the cell fabric at least 74 % of the time', () => {
    // cell 0.7 -> shophouse (corp row: shophouse 45 from 55). Share = 0.6 (cell draw) + 0.4 * 0.45 (fresh draw lands on it) = 0.78
    let hit = 0; for (let i = 0; i < 2000; i++) hit += +(chooseFabric('corp', 'dense', 0.7, mulberry32(i), () => true) === 'shophouse')
    expect(hit / 2000).toBeGreaterThanOrEqual(0.74)
  })
  it('fallback walks down the row, finally rows', () => {
    expect(chooseFabric('corp', 'dense', 0.01, mulberry32(1), (f) => f !== 'podium')).toBe('plaza') // by weight: shophouse 45, tower-park 20, podium 15, plaza 10, blockfill 10
    expect(chooseFabric('corp', 'dense', 0.01, mulberry32(1), (f) => f === 'rows')).toBe('rows')
  })
  it('sheet zones', () => {
    expect(sheetZone('slum', 'sparse')).toBe('fringe'); expect(sheetZone('slum', 'packed')).toBe('mixed')
    expect(sheetZone('entertainment', 'sparse')).toBe('mixed'); expect(sheetZone('entertainment', 'dense')).toBe('commerce')
    expect(sheetZone('docks', 'dense')).toBe('industrial'); expect(densityClass(0.35)).toBe('dense'); expect(densityClass(0.65)).toBe('packed')
  })
  it('blockfill weighs 25 in packed and 10 in dense mixed, commerce and corp, never sparse (user review)', () => {
    expect(fabricRow('commerce', 'packed')).toBe('commerce packed'); expect(fabricRow('corp', 'dense')).toBe('corp'); expect(fabricRow('mixed', 'packed')).toBe('mixed packed')
    for (const [z, dc, w] of [['mixed', 'packed', 25], ['commerce', 'packed', 25], ['corp', 'packed', 25], ['mixed', 'dense', 10], ['commerce', 'dense', 10], ['corp', 'dense', 10], ['mixed', 'sparse', 0]] as const) {
      const row = FABRIC_WEIGHTS[fabricRow(z, dc)]
      expect(row.find(([f]) => f === 'blockfill')?.[1] ?? 0, `${z} ${dc}`).toBe(w)
    }
  })
})
