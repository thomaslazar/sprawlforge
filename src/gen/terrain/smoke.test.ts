import { describe, expect, it } from 'vitest'
import type { SectorParams } from '../types'
import { TERRAIN_KINDS } from '../types'
import { sampleTerrain } from './index'

const base: SectorParams = {
  seed: 0, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  terrain: 'inland', piers: false, pack: 'generic', theme: 'neon',
}

// outer rings add area, holes subtract — same convention as contour.test.ts
function waterArea(water: Array<Array<Array<[number, number]>>>): number {
  let total = 0
  for (const poly of water) {
    for (let ri = 0; ri < poly.length; ri++) {
      const ring = poly[ri]
      let a = 0
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i]
        const [x2, y2] = ring[(i + 1) % ring.length]
        a += x1 * y2 - x2 * y1
      }
      total += ri === 0 ? Math.abs(a / 2) : -Math.abs(a / 2)
    }
  }
  return total
}

const WATER_FLOOR = 0.01 // 1% of window area

describe('sampleTerrain smoke', () => {
  it('every kind, seeds 0..99 at default size 4000: no throw; wet kinds clear the water floor', () => {
    const sizeM = 4000
    const failures: string[] = []
    for (const kind of TERRAIN_KINDS) {
      for (let seed = 0; seed < 100; seed++) {
        let t
        try {
          t = sampleTerrain({ ...base, terrain: kind, seed }, sizeM)
        } catch (err) {
          failures.push(`${kind}/${seed}: threw ${(err as Error).message}`)
          continue
        }
        if (kind !== 'inland') {
          const frac = waterArea(t.water) / (sizeM * sizeM)
          if (frac < WATER_FLOOR) failures.push(`${kind}/${seed}: water frac ${frac.toFixed(4)} < floor`)
        }
      }
    }
    expect(failures).toEqual([])
  }, 120_000) // 700 sampleTerrain calls (7 kinds × 100 seeds) — well past the 5s default

  it('coastal/island/river at sizes 2000 and 6000, seeds 0..24: no throw; wet kinds clear the water floor', () => {
    const failures: string[] = []
    for (const kind of ['coastal', 'island', 'river'] as const) {
      for (const sizeM of [2000, 6000]) {
        for (let seed = 0; seed < 25; seed++) {
          let t
          try {
            t = sampleTerrain({ ...base, terrain: kind, seed }, sizeM)
          } catch (err) {
            failures.push(`${kind}/${sizeM}/${seed}: threw ${(err as Error).message}`)
            continue
          }
          const frac = waterArea(t.water) / (sizeM * sizeM)
          if (frac < WATER_FLOOR)
            failures.push(`${kind}/${sizeM}/${seed}: water frac ${frac.toFixed(4)} < floor`)
        }
      }
    }
    expect(failures).toEqual([])
  }, 60_000) // 150 sampleTerrain calls (3 kinds × 2 sizes × 25 seeds)
})
