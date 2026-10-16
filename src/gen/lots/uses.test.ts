import { describe, expect, it } from 'vitest'
import { ZONE_TYPES, type Block, type BlockStyle, type Building, type District } from '../types'
import { useName } from './uses'

const STYLES: BlockStyle[] = ['perimeter', 'terrace', 'shophouse', 'rows', 'zeilen', 'detached', 'villas', 'tower-park', 'podium', 'bigbox', 'sheds', 'plaza', 'garage', 'strip', 'megablock', 'compound', 'blockfill']
const bld = (id: string, shape = 'A2') => ({ id, shape }) as Building
const blk = (style: BlockStyle) => ({ style }) as Block
const dis = (zone: District['zone']) => ({ zone }) as District

describe('use', () => {
  it('every fabric x zone names a use', () => {
    for (const s of STYLES) for (const z of ZONE_TYPES) expect(useName(bld('B1'), blk(s), dis(z)).length).toBeGreaterThan(0)
  })
  it('is deterministic per building id', () => {
    expect(useName(bld('BLD7'), blk('bigbox'), dis('industrial'))).toBe(useName(bld('BLD7'), blk('bigbox'), dis('industrial')))
  })
  it('varies across ids', () => {
    const names = new Set(Array.from({ length: 200 }, (_, i) => useName(bld(`BLD${i}`), blk('bigbox'), dis('industrial'))))
    expect(names.size).toBeGreaterThanOrEqual(2)
  })
  it('shape overrides win', () => {
    expect(useName(bld('x', 'F14'), blk('bigbox'), dis('corp'))).toBe('parking garage')
    expect(useName(bld('x', 'hive'), blk('megablock'), dis('slum'))).toBe('hive cell')
  })
})
