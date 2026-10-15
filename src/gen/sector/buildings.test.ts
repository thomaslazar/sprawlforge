import { beforeAll, describe, expect, it } from 'vitest'
import { pointInRings, ringArea, ringCentroid, simplifyPolyline, type Pt } from '../geometry'
import { hashSeed } from '../rng'
import { resolveTags } from '../../app/tags'
import { FABRIC_WEIGHTS, densityClass, sheetZone } from '../lots/fabrics'
import { widthOk } from '../lots/fitbox'
import { insideRing, interiorAngles, minNonArcEdge, pairOverlapMax } from '../lots/fixtures'
import { SETBACK, buildable, edgeSetbacks, type SetbackCtx } from '../lots/setback'
import { CURVED_OR_SLANTED } from '../lots/shapes'
import { simplifyFace } from '../streets/graph'
import { levelAt, nearestT } from '../streets/highway'
import { RoadIndex } from '../streets/trace'
import { fractalNoise2D } from '../terrain/noise'
import type { Building, Lot, SectorModel, SectorParams } from '../types'
import { distToPolyline } from '../terrain/rivers'
import { generateSector } from './generate'

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'inland', river: false, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon',
}
const tagged = (tags: string[], seed: number, size: number) => ({ ...resolveTags(tags), seed, size, pack: 'generic', theme: 'print' }) as SectorParams

const S42 = tagged(['coastal', 'river', 'arcology'], 42, 4)
const S782: SectorParams = { ...base, seed: 782008753, size: 6, landform: 'inland', density: 0.6, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5, river: true, lakes: true, islands: true, piers: true, pack: 'generic', theme: 'print' }
const S426 = tagged(['inland', 'small', 'dense', 'balanced', 'quiet', 'sprawl', 'river'], 426750495, 2)
const S2268 = tagged(['coastal', 'medium', 'packed', 'balanced', 'quiet', 'planned'], 2268324149, 4)
const SEEDS: Array<[string, SectorParams]> = [['S42', S42], ['S782', S782], ['S426', S426], ['S2268', S2268]]

// bound on the share of plain buildings with an angle > 1 degree off 90/180/270, start 0.02, lowered to the measured value
const NONRECT: Record<number, number> = { 42: 0, 782008753: 0, 426750495: 0, 2268324149: 0 } // measured 0 on all four seeds

const cache = new Map<number, SectorModel>()
const gen = (p: SectorParams): SectorModel => {
  let m = cache.get(p.seed)
  if (!m) { m = generateSector(p); cache.set(p.seed, m) }
  return m
}

const off90 = (a: number) => Math.min(Math.abs(a - 90), Math.abs(a - 180), Math.abs(a - 270))
const orient = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
/** no two non-adjacent edges cross properly (touching does not count) */
const simple = (r: Pt[]): boolean => {
  const n = r.length
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue
    const [a, b, c, d] = [r[i], r[(i + 1) % n], r[j], r[(j + 1) % n]]
    if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) return false
  }
  return true
}
/** soft expectation that a list of offenders is empty, naming the first few */
const none = (what: string, bad: string[]) => expect.soft(bad.length, `${what}: ${bad.length} e.g. ${bad.slice(0, 6).join(', ')}`).toBe(0)

const lotsOf = (m: SectorModel) => new Map(m.lots.map((l) => [l.id, l]))
const hiveCutByCore = (b: Building, m: SectorModel): boolean => {
  if (b.shape !== 'hive') return false
  const blk = m.blocks.find((x) => x.id === b.blockId)
  const k = m.megablocks.find((x) => x.id === blk?.flags.megablock)
  return !!k && b.footprint.some((p) => distToPolyline(p, [...k.core, k.core[0]]) <= 0.05)
}

/** R1 as lots/index.ts does it */
const simplified = (fp: Pt[]): Pt[] => {
  const f = simplifyFace(fp)
  const s = simplifyPolyline([...f, f[0]], 2).slice(0, -1)
  return s.length >= 3 ? s : f
}
const ccw = (r: Pt[]) => (ringArea(r) < 0 ? [...r].reverse() : r)

const roadIndex = (m: SectorModel) => {
  const index = new RoadIndex(100)
  for (const r of m.roads) if (r.class !== 'highway') index.add(r.id, r.points, r.class)
  return index
}

describe('buildings phase A', () => {
  describe.each(SEEDS)('%s', (_, params) => {
    let m: SectorModel
    beforeAll(() => { m = gen(params) }, 300000)

    it('min edge', () => { for (const b of m.buildings) expect(minNonArcEdge(b.footprint), b.id).toBeGreaterThanOrEqual(3) })
    it('min width', () => { for (const b of m.buildings) expect(widthOk(b.footprint, 6), b.id).toBe(true) })
    it('no small buildings', () => { expect(m.buildings.filter((b) => Math.abs(ringArea(b.footprint)) < 60).map((b) => b.id)).toEqual([]) })
    it('no overlap', () => { expect(pairOverlapMax(m.buildings.map((b) => b.footprint))).toBeLessThanOrEqual(0.5) })
    it('non-rectilinear share', () => {
      const plain = m.buildings.filter((b) => !CURVED_OR_SLANTED.has(b.shape) && !hiveCutByCore(b, m))
      const share = plain.filter((b) => interiorAngles(b.footprint).some((a) => off90(a) > 1)).length / plain.length
      expect(share).toBeLessThanOrEqual(NONRECT[params.seed])
    })
    it('triangles', () => {
      const lots = lotsOf(m)
      for (const b of m.buildings.filter((x) => x.footprint.length === 3)) {
        expect(b.shape, b.id).toBe('A16')
        expect(Math.abs(ringArea(lots.get(b.lotId)!.poly)), b.id).toBeGreaterThanOrEqual(1500)
      }
    })
    it('lots', () => {
      const lots = lotsOf(m)
      const idx = roadIndex(m)
      const plazas = m.arcologies.filter((a) => a.access !== 'ring').map((a) => a.plaza)
      const ctx: SetbackCtx = { index: idx, highway: m.roads.find((r) => r.class === 'highway'), terrain: m.terrain, sizeM: params.size * 1000, grounds: plazas }
      const pieces = new Map<string, Pt[][]>()
      for (const bl of m.blocks) {
        if (bl.style === 'plaza') continue
        const fp = ccw(simplified(bl.footprint))
        pieces.set(bl.id, buildable(fp, edgeSetbacks(fp, ctx)))
      }
      const byBlock = new Map<string, Lot[]>()
      const notSimple: string[] = [], outside: string[] = [], bOut: string[] = [], overlap: string[] = []
      for (const l of m.lots) {
        if (!simple(l.poly)) notSimple.push(`${l.id}/${l.kind}/${l.blockId}`)
        const ps = pieces.get(l.blockId)
        if (ps && !ps.some((p) => insideRing(l.poly, p, 0.05))) outside.push(`${l.id}/${l.kind}/${l.blockId}`)
        byBlock.set(l.blockId, [...(byBlock.get(l.blockId) ?? []), l])
      }
      for (const b of m.buildings) if (!insideRing(b.footprint, lots.get(b.lotId)!.poly, 0.05)) bOut.push(`${b.id}/${b.shape}/${b.lotId}`)
      for (const [id, ls] of byBlock) {
        const pools = ls.filter((l) => l.kind === 'pool')
        const rest = ls.filter((l) => l.kind !== 'pool')
        if (pairOverlapMax(rest.map((l) => l.poly)) > 0.5) overlap.push(id)
        for (const p of pools) for (const o of rest.filter((l) => l.kind !== 'green')) if (pairOverlapMax([p.poly, o.poly]) > 0.5) overlap.push(`${p.id}/${o.id}`)
      }
      none('lots not simple', notSimple)
      none('lots outside the buildable', outside)
      none('buildings outside their lot', bOut)
      none('lots overlapping in a block', overlap)
    })
    it('megablock', () => {
      for (const k of m.megablocks) {
        const blk = m.blocks.find((x) => x.flags.megablock === k.id)
        for (const b of m.buildings.filter((x) => x.shape === 'hive' && x.blockId === blk?.id)) expect(insideRing(b.footprint, k.core, 0.05), `${k.id} ${b.id}`).toBe(true)
      }
    })
    it('compound', () => {
      const bad: string[] = []
      for (const c of m.compounds) {
        const bs = m.buildings.filter((b) => b.blockId === c.blockId)
        if (bs.length < 2 || bs.length > 4) bad.push(`${c.id} has ${bs.length} buildings`)
        for (const b of bs) {
          if (b.footprint.some((p) => !pointInRings(p, [c.fence]) || distToPolyline(p, [...c.fence, c.fence[0]]) < 8 - 0.05)) bad.push(`${c.id} ${b.id} closer than 8 m to the fence`)
          if (!b.shape.startsWith('E') && b.footprint.length > 12) bad.push(`${c.id} ${b.id} ${b.shape} has ${b.footprint.length} vertices`)
        }
      }
      none('compounds', bad)
    })
  })

  describe('road strips', () => {
    it.each(SEEDS)('lots never overlap a road strip (%s)', (_, params) => {
      const m = gen(params)
      const idx = roadIndex(m)
      const hw = m.roads.find((r) => r.class === 'highway')
      const by: Record<string, number> = { street: SETBACK.street, ramp: SETBACK.ramp, arterial: SETBACK.arterial }
      const bad = new Map<string, string>()
      for (const b of m.buildings) for (const p of b.footprint) {
        idx.forEachInRadius(p, 30, (seg, _pt, d) => { if (d < by[seg.cls] - 0.5) bad.set(b.id, `${b.id}/${b.shape}/${b.blockId} near ${seg.id} ${d.toFixed(1)} m`) })
        if (hw) {
          const { dist: d, t } = nearestT(p, hw.points)
          if (d < (hw.segments && levelAt(hw.segments, t) === 'sunken' ? SETBACK.sunken : SETBACK.highway) - 0.5) bad.set(b.id, `${b.id}/${b.shape}/${b.blockId} near highway ${d.toFixed(1)} m`)
        }
      }
      none(`buildings short of their setback (of ${m.buildings.length})`, [...bad.values()])
    }, 300000)
  })

  it('fabric mix', () => {
    // measured, pooled over the four seeds (share / weight; rows with < 20 blocks are not asserted):
    // residential sparse n=15 detached .40/.50 villas .20/.20 rows .40/.30
    // residential dense n=782 perimeter .26/.30 terrace .29/.25 rows .22/.25 zeilen .19/.15 tower-park .04/.05
    // residential packed n=307 perimeter .51/.50 terrace .13/.20 zeilen .18/.15 tower-park .11/.10 podium .05/.05
    // mixed sparse n=8; mixed dense n=682 perimeter .40/.40 shophouse .23/.25 rows .25/.20 podium .12/.15
    // commerce n=365 perimeter .36/.30 shophouse .24/.20 podium .21/.25 plaza .00/.10 garage .02/.05 bigbox .13/.10
    // corp n=1183 podium .42/.40 tower-park .26/.30 perimeter .32/.20 plaza .00/.10
    // industrial n=642 bigbox .37/.50 sheds .39/.35 rows .24/.15; fringe n=15
    // pooled rows (sheet zone x density) -> fabric counts
    const rows = new Map<string, { n: number; by: Map<string, number> }>()
    for (const [, params] of SEEDS) {
      const m = gen(params)
      const nb = fractalNoise2D(hashSeed(params.seed, 'neighbourhood'), 2)
      const dz = new Map(m.districts.map((d) => [d.id, d]))
      for (const bl of m.blocks) {
        const d = dz.get(bl.districtId)
        if (!d || bl.style === 'plaza' || bl.style === 'megablock' || bl.style === 'compound' || bl.style === 'strip') continue
        const cc = ringCentroid(bl.footprint)
        const dc = densityClass(Math.max(0, Math.min(1, 0.6 * params.density + 0.6 * nb(cc.x / 500, cc.y / 500) - 0.1)))
        const sz = sheetZone(d.zone, dc)
        const key = sz === 'residential' || sz === 'mixed' ? `${sz} ${dc === 'sparse' ? 'sparse' : sz === 'mixed' ? 'dense' : dc}` : sz
        const row = rows.get(key) ?? { n: 0, by: new Map() }
        row.n++
        row.by.set(bl.style, (row.by.get(bl.style) ?? 0) + 1)
        rows.set(key, row)
      }
    }
    for (const [key, row] of rows) {
      const w = FABRIC_WEIGHTS[key]
      if (!w) continue
      if (row.n < 20) continue
      for (const [f, wt] of w) if (wt >= 20) expect((row.by.get(f) ?? 0) / row.n, `${key} ${f}`).toBeGreaterThanOrEqual(0.5 * wt / 100)
    }
  }, 300000)

  it('deterministic', () => {
    const a = generateSector(S426)
    const b = generateSector(S426)
    expect(a.buildings).toEqual(b.buildings)
    expect(a.lots).toEqual(b.lots)
  }, 300000)
})
