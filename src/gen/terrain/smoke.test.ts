import { describe, expect, it } from 'vitest'
import { LANDFORMS, type Landform, type SectorParams } from '../types'
import { sampleTerrain } from './index'

const base: SectorParams = {
  seed: 0, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
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

// One it() per landform/water-combo, and the seed loops yield the event loop
// every few iterations: hours of near-continuous synchronous CPU starve the
// vitest worker's RPC heartbeat ("Timeout calling onTaskUpdate" with all
// tests green) because pending RPC replies never get processed between
// blocks. Note: the domain-warped field costs ~14 valueNoise2D lookups per
// sample (was 4); if the widened timeouts below ever get tight, memoize the
// warp+noise pipeline per field instance instead of raising them again.
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// islands alone implies no water floor (an islet only ever ADDS a small land
// patch inside otherwise-existing water; it never creates water on its own)
const WATER_COMBOS = [
  ['none', false, false, false],
  ['river', true, false, false],
  ['lakes', false, true, false],
  ['islands', false, false, true],
  ['river+lakes', true, true, false],
] as const

describe('sampleTerrain smoke', () => {
  describe.each(LANDFORMS)('%s', (landform: Landform) => {
    describe.each(WATER_COMBOS)('+ %s, seeds 0..39 at default size 4000', (_label, river, lakes, islands) => {
      it('never throws; combos implying water clear the water floor', async () => {
        const sizeM = 4000
        const impliesWater = landform !== 'inland' || river || lakes
        const failures: string[] = []
        for (let seed = 0; seed < 40; seed++) {
          if (seed % 5 === 4) await breathe()
          let t
          try {
            t = sampleTerrain({ ...base, landform, river, lakes, islands, seed }, sizeM)
          } catch (err) {
            failures.push(`${landform}/${river}/${lakes}/${islands}/${seed}: threw ${(err as Error).message}`)
            continue
          }
          if (impliesWater) {
            const frac = waterArea(t.water) / (sizeM * sizeM)
            if (frac < WATER_FLOOR)
              failures.push(`${landform}/${river}/${lakes}/${islands}/${seed}: water frac ${frac.toFixed(4)} < floor`)
          }
        }
        expect(failures).toEqual([])
      }, 60_000) // 40 sampleTerrain calls
    })
  })

  describe.each([
    ['coastal', false], ['coastal', true], ['bay', false], ['bay', true],
  ] as const)('%s river=%s at sizes 2000/6000, seeds 0..14', (landform, river) => {
    it.each([2000, 6000] as const)('never throws and clears the water floor at size %d', async (sizeM) => {
      const failures: string[] = []
      for (let seed = 0; seed < 15; seed++) {
        if (seed % 5 === 4) await breathe()
        let t
        try {
          t = sampleTerrain({ ...base, landform, river, lakes: false, seed }, sizeM)
        } catch (err) {
          failures.push(`${landform}/${river}/${sizeM}/${seed}: threw ${(err as Error).message}`)
          continue
        }
        const frac = waterArea(t.water) / (sizeM * sizeM)
        if (frac < WATER_FLOOR)
          failures.push(`${landform}/${river}/${sizeM}/${seed}: water frac ${frac.toFixed(4)} < floor`)
      }
      expect(failures).toEqual([])
    }, 60_000) // 15 sampleTerrain calls
  })
})
