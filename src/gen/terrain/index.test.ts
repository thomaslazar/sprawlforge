import { describe, expect, it } from 'vitest'
import type { SectorParams } from '../types'
import { sampleTerrain } from './index'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  landform: 'coastal', river: false, lakes: false, piers: false, pack: 'generic', theme: 'neon',
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
    it('island + river: both flags resolved on the sampled Terrain', () => {
      const t = sampleTerrain({ ...base, landform: 'island', river: true, lakes: false }, 4000)
      expect(t.landform).toBe('island')
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
})
