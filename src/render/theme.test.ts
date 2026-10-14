import { describe, expect, it } from 'vitest'
import { themes } from './theme'

describe('themes', () => {
  it('every theme defines ramp and highway level colours', () => {
    for (const t of Object.values(themes)) {
      expect(t.road.ramp).toMatch(/^#[0-9a-f]{6}$/i)
      for (const k of ['trench', 'hatch'] as const) expect(t.highway[k]).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
  it('every theme defines compound colours', () => {
    for (const t of Object.values(themes)) for (const c of [t.compound.fence, t.compound.ground]) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
  })
  it('every theme defines frontage colours', () => {
    for (const t of Object.values(themes)) for (const c of [t.frontage.fill, t.frontage.stroke]) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
  })
  it('every theme defines arcology and megablock colours', () => {
    for (const t of Object.values(themes)) {
      for (const c of [t.arcology.fill, t.arcology.stroke, t.arcology.ring, t.megablock.fill, t.megablock.alley])
        expect(c).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})
