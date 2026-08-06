import { describe, expect, it } from 'vitest'
import type { SectorParams } from '../types'
import { sampleTerrain } from './index'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  landform: 'coastal', river: false, lakes: false, islands: false, piers: false, pack: 'generic', theme: 'neon',
}

describe('sampleTerrain', () => {
  it('is deterministic', () => {
    expect(sampleTerrain(base, 4000)).toEqual(sampleTerrain(base, 4000))
  })
  it('coastal: has water and land, no river', () => {
    const t = sampleTerrain(base, 4000)
    expect(t.water.length).toBeGreaterThan(0)
    expect(t.land.length).toBeGreaterThan(0)
    expect(t.riverSlice).toBeNull()
    expect(t.landform).toBe('coastal')
    expect(t.river).toBe(false)
    expect(t.lakes).toBe(false)
  })
  it('inland: no water at all', () => {
    const t = sampleTerrain({ ...base, landform: 'inland' }, 4000)
    expect(t.water).toEqual([])
  })
  it('inland + river: water present and river slice crosses the window', () => {
    const t = sampleTerrain({ ...base, landform: 'inland', river: true }, 4000)
    expect(t.water.length).toBeGreaterThan(0)
    expect(t.riverSlice!.course.length).toBeGreaterThan(2)
    const inWin = t.riverSlice!.course.some(
      (p) => p.x >= 0 && p.x <= 4000 && p.y >= 0 && p.y <= 4000,
    )
    expect(inWin).toBe(true)
  })
  it('auto resolves deterministically from the seed', () => {
    const a = sampleTerrain({ ...base, landform: 'auto' }, 4000)
    const b = sampleTerrain({ ...base, landform: 'auto' }, 4000)
    expect(a).toEqual(b)
  })

  describe('composable terrain', () => {
    it('inland + lakes: water exists but there is no sea contact (landform stays inland)', () => {
      const t = sampleTerrain({ ...base, landform: 'inland', river: false, lakes: true }, 4000)
      expect(t.landform).toBe('inland')
      expect(t.lakes).toBe(true)
      expect(t.water.length).toBeGreaterThan(0)
    })
    it('bay + river: both flags resolved on the sampled Terrain', () => {
      const t = sampleTerrain({ ...base, landform: 'bay', river: true, lakes: false }, 4000)
      expect(t.landform).toBe('bay')
      expect(t.river).toBe(true)
      expect(t.water.length).toBeGreaterThan(0)
    })
    it('coastal + river: the estuary case — sea and river both present', () => {
      const t = sampleTerrain({ ...base, landform: 'coastal', river: true, lakes: false }, 4000)
      expect(t.landform).toBe('coastal')
      expect(t.river).toBe(true)
      expect(t.water.length).toBeGreaterThan(0)
    })
    it('coastal + river + lakes: all three compose without throwing', () => {
      const t = sampleTerrain({ ...base, landform: 'coastal', river: true, lakes: true }, 4000)
      expect(t.landform).toBe('coastal')
      expect(t.river).toBe(true)
      expect(t.lakes).toBe(true)
      expect(t.water.length).toBeGreaterThan(0)
    })
  })

  it('bay+river: the river actually crosses the window (regression: metro-wide start sampling drowned small-landmass rivers)', () => {
    for (const seed of [1, 42, 765298847]) {
      const t = sampleTerrain({ ...base, landform: 'bay', river: true, seed, size: 2 }, 2000)
      expect(t.riverSlice, `seed ${seed}`).not.toBeNull()
      const inWin = t.riverSlice!.course.some(
        (pt) => pt.x >= 0 && pt.x <= 2000 && pt.y >= 0 && pt.y <= 2000,
      )
      expect(inWin, `seed ${seed}`).toBe(true)
    }
  }, 60000)

  describe('islands water modifier', () => {
    it('coastal+islands: land polygon count exceeds coastal-without-islands for at least 2 of 3 seeds', () => {
      let wins = 0
      for (const seed of [1, 42, 999]) {
        const dry = sampleTerrain({ ...base, landform: 'coastal', seed }, 4000)
        const wet = sampleTerrain({ ...base, landform: 'coastal', islands: true, seed }, 4000)
        if (wet.land.length > dry.land.length) wins += 1
      }
      expect(wins).toBeGreaterThanOrEqual(2)
    })
    it('inland+islands with no lakes: identical to inland alone (no wet candidates, no-op)', () => {
      // `islands` itself is the resolved request flag, so it legitimately
      // differs — everything the modifier could actually change (water/land
      // geometry, river) must not
      const { islands: _t, ...t } = sampleTerrain({ ...base, landform: 'inland', islands: true }, 4000)
      const { islands: _c, ...control } = sampleTerrain({ ...base, landform: 'inland', islands: false }, 4000)
      expect(t).toEqual(control)
    })
  })
})
