import { describe, expect, it } from 'vitest'
import type { SectorParams } from '../types'
import { genGeography } from './geography'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
  terrain: 'inland', piers: false, pack: 'generic', theme: 'neon',
}
const sizeM = 4000

describe('genGeography', () => {
  it('none when terrain is inland', () => {
    const w = genGeography(base, sizeM)
    expect(w.kind).toBe('none')
    expect(w.polygon).toEqual([])
    expect(w.bounds).toBeNull()
  })
  it('coast produces an east-side polygon within the sector', () => {
    const w = genGeography({ ...base, terrain: 'coastal' }, sizeM)
    expect(w.kind).toBe('coast')
    expect(w.polygon.length).toBeGreaterThan(4)
    for (const p of w.polygon) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(sizeM)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(sizeM)
    }
    expect(w.bounds!.x).toBeGreaterThan(sizeM * 0.6)
  })
  it('river produces a horizontal band', () => {
    const w = genGeography({ ...base, terrain: 'river' }, sizeM)
    expect(w.kind).toBe('river')
    expect(w.bounds!.w).toBe(sizeM)
    expect(w.bounds!.h).toBeLessThan(sizeM * 0.3)
  })
  it('coast wins over river (estuary)', () => {
    expect(genGeography({ ...base, terrain: 'estuary' }, sizeM).kind).toBe('coast')
  })
  it('is deterministic', () => {
    expect(genGeography({ ...base, terrain: 'coastal' }, sizeM))
      .toEqual(genGeography({ ...base, terrain: 'coastal' }, sizeM))
  })
})
