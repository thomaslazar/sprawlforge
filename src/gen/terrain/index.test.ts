import { describe, expect, it } from 'vitest'
import type { SectorParams } from '../types'
import { sampleTerrain } from './index'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  terrain: 'coastal', piers: false, pack: 'generic', theme: 'neon',
}

describe('sampleTerrain', () => {
  it('is deterministic', () => {
    expect(sampleTerrain(base, 4000)).toEqual(sampleTerrain(base, 4000))
  })
  it('coastal: has water and land, no river', () => {
    const t = sampleTerrain(base, 4000)
    expect(t.water.length).toBeGreaterThan(0)
    expect(t.land.length).toBeGreaterThan(0)
    expect(t.river).toBeNull()
    expect(t.kind).toBe('coastal')
  })
  it('inland: no water at all', () => {
    const t = sampleTerrain({ ...base, terrain: 'inland' }, 4000)
    expect(t.water).toEqual([])
  })
  it('river: water present and river slice crosses the window', () => {
    const t = sampleTerrain({ ...base, terrain: 'river' }, 4000)
    expect(t.water.length).toBeGreaterThan(0)
    expect(t.river!.course.length).toBeGreaterThan(2)
    const inWin = t.river!.course.some(
      (p) => p.x >= 0 && p.x <= 4000 && p.y >= 0 && p.y <= 4000,
    )
    expect(inWin).toBe(true)
  })
  it('auto resolves deterministically from the seed', () => {
    const a = sampleTerrain({ ...base, terrain: 'auto' }, 4000)
    const b = sampleTerrain({ ...base, terrain: 'auto' }, 4000)
    expect(a.kind).toBe(b.kind)
  })
})
