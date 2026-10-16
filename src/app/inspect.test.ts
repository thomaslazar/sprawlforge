import { beforeAll, describe, expect, it } from 'vitest'
import { generateSector } from '../gen/sector/generate'
import { ringCentroid } from '../gen/geometry'
import type { SectorModel } from '../gen/types'
import { describeAt } from './inspect'
import { stateFromSearch } from './params'
import { materializeTags, resolveTags } from './tags'

let model: SectorModel
beforeAll(() => {
  const s = stateFromSearch('?seed=42&tags=coastal,medium,dense,fringe,lively,mixed,river,arcology&pack=generic&theme=print', 42)
  model = generateSector({ seed: s.seed, pack: s.pack, theme: s.theme, ...resolveTags(materializeTags(s.seed, s.tags)) })
}, 120_000)

describe('inspect', () => {
  it('finds a building with its block and district', () => {
    // a building whose centroid lies inside its own footprint (concave shapes may not)
    let r: ReturnType<typeof describeAt> = null
    for (const x of model.buildings.slice(0, 50)) {
      const h = describeAt(model, ringCentroid(x.footprint))
      if (h?.building?.id === x.id) { r = h; break }
    }
    expect(r).not.toBeNull()
    const b = r!.building!
    expect(r!.block?.id).toBe(b.blockId)
    expect(r!.district?.id).toBe(b.districtId)
  })
  it('returns null far outside all blocks', () => {
    expect(describeAt(model, { x: -1000, y: -1000 })).toBeNull()
  })
  it('returns a building-less parking lot', () => {
    const lot = model.lots.find((l) => l.kind === 'parking' && l.buildingIds.length === 0)!
    const p = ringCentroid(lot.poly)
    const r = describeAt(model, p)!
    expect(r.building).toBeUndefined()
    expect(r.lot?.kind).toBe('parking')
  })
})
