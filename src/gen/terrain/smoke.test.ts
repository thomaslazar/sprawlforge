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

// One it() per kind/size, and the seed loops yield the event loop every few
// iterations: hours of near-continuous synchronous CPU starve the vitest
// worker's RPC heartbeat ("Timeout calling onTaskUpdate" with all tests
// green) because pending RPC replies never get processed between blocks.
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('sampleTerrain smoke', () => {
  describe.each([...TERRAIN_KINDS])('%s, seeds 0..99 at default size 4000', (kind) => {
    it('never throws; wet kinds clear the water floor', async () => {
      const sizeM = 4000
      const failures: string[] = []
      for (let seed = 0; seed < 100; seed++) {
        if (seed % 5 === 4) await breathe()
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
      expect(failures).toEqual([])
    }, 60_000) // 100 sampleTerrain calls
  })

  describe.each([
    ['coastal', 2000], ['coastal', 6000],
    ['island', 2000], ['island', 6000],
    ['river', 2000], ['river', 6000],
  ] as const)('%s at size %d, seeds 0..24', (kind, sizeM) => {
    it('never throws and clears the water floor', async () => {
      const failures: string[] = []
      for (let seed = 0; seed < 25; seed++) {
        if (seed % 5 === 4) await breathe()
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
      expect(failures).toEqual([])
    }, 30_000) // 25 sampleTerrain calls
  })
})
