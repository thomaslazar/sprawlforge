import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../rng'
import { generateName } from './names'
import { getPack, packs } from './packs'

describe('generateName', () => {
  const tables = { adj: ['Neon', 'Iron'], noun: ['Heights', 'Row'] }
  it('fills placeholders deterministically', () => {
    expect(generateName('{adj} {noun}', tables, mulberry32(1)))
      .toBe(generateName('{adj} {noun}', tables, mulberry32(1)))
  })
  it('output contains only table words', () => {
    const n = generateName('{adj} {noun}', tables, mulberry32(2))
    const [a, b] = n.split(' ')
    expect(tables.adj).toContain(a)
    expect(tables.noun).toContain(b)
  })
  it('throws on unknown key', () => {
    expect(() => generateName('{nope}', tables, mulberry32(1))).toThrow()
  })
})

describe('flavor packs', () => {
  it('ships generic and shadowrunish', () => {
    expect(Object.keys(packs).sort()).toEqual(['generic', 'shadowrunish'])
  })
  it('getPack falls back to generic', () => {
    expect(getPack('unknown').id).toBe('generic')
  })
  it('getPack falls back to generic for prototype-polluting ids', () => {
    expect(getPack('__proto__').id).toBe('generic')
  })
  for (const pack of Object.values(packs)) {
    it(`${pack.id}: every pattern placeholder resolves against its tables`, () => {
      const rng = mulberry32(3)
      const allPatterns = [
        ...pack.districtPatterns,
        ...pack.streetPatterns,
        ...pack.poiTypes.flatMap((p) => p.namePatterns),
      ]
      for (const pattern of allPatterns) {
        expect(() => generateName(pattern, pack.tables, rng)).not.toThrow()
      }
    })
    it(`${pack.id}: every zone type has at least one poi type`, () => {
      const zones = new Set(pack.poiTypes.flatMap((p) => p.zones))
      for (const z of ['corp', 'residential', 'slum', 'industrial', 'entertainment', 'docks'])
        expect(zones.has(z as never)).toBe(true)
    })
  }
})
