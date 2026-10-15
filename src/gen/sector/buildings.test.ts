import { beforeAll, describe, expect, it } from 'vitest'
import { pointInRings, ringArea, ringCentroid, simplifyPolyline, type Pt } from '../geometry'
import { hashSeed } from '../rng'
import { resolveTags } from '../../app/tags'
import { FABRIC_WEIGHTS, densityClass, fabricRow, sheetZone } from '../lots/fabrics'
import { widthOk } from '../lots/fitbox'
import { insideRing, interiorAngles, minNonArcEdge, overlapPairs, pairOverlapMax } from '../lots/fixtures'
import { SETBACK, buildable, edgeSetbacks, type SetbackCtx } from '../lots/setback'
import { CURVED_OR_SLANTED } from '../lots/shapes'
import { simplifyFace } from '../streets/graph'
import { levelAt, nearestT } from '../streets/highway'
import { RoadIndex } from '../streets/trace'
import { fractalNoise2D } from '../terrain/noise'
import type { Building, Lot, SectorModel, SectorParams } from '../types'
import { distToPolyline } from '../terrain/rivers'
import { generateSector } from './generate'
import { inWater } from './bridges'

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

// building pairs excused as their blocks overlap (ROADMAP "Overlapping block faces")
const FACE_LAP: Record<number, number> = { 42: 1, 782008753: 149, 426750495: 0, 2268324149: 184 } // measured after the user review (variation round; S782 140 to 149 after the plaza/strip fix round re-rolls)
// buildings with a vertex nearer a road centreline than setback - 0.5 m (within the 2 m R1 simplification budget)
const SIMPLIFIED_NEAR: Record<number, number> = { 42: 1321, 782008753: 4107, 426750495: 686, 2268324149: 1365 } // measured after the user review (variation round; plaza/strip fix round: S42 1228 to 1235, S782 3818 to 3814, S426 621 to 620; sparse-block guard round, more buildings: S42 1235 to 1321, S782 3814 to 4107, S426 620 to 686, S2268 1266 to 1365)

// blocks of 0.5 ha or more under 10 % built: the sparse-block guard re-lays them as sheds or rows (S42 59 and S782 206 before it); the rest sit behind highway setbacks or on water
const SPARSE: Record<number, number> = { 42: 13, 782008753: 29 }

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
    it('no overlap', () => {
      // buildings of two blocks whose footprints overlap (an upstream face defect, on main too; ROADMAP) are excused and counted
      const blocks = new Map(m.blocks.map((b) => [b.id, b.footprint]))
      const bad: string[] = []
      let excused = 0
      for (const [i, j, a] of overlapPairs(m.buildings.map((b) => b.footprint), 0.5)) {
        const x = m.buildings[i], y = m.buildings[j]
        if (x.blockId !== y.blockId && overlapPairs([blocks.get(x.blockId)!, blocks.get(y.blockId)!], 1).length) excused++
        else bad.push(`${x.id}/${y.id} ${x.blockId} ${a.toFixed(1)} m2`)
      }
      none('overlapping buildings', bad)
      expect(excused).toBeLessThanOrEqual(FACE_LAP[params.seed])
    })
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
        pieces.set(bl.id, buildable(fp, edgeSetbacks(fp, ctx, simplifyFace(bl.footprint)))) // classified on the unsimplified outline, as index.ts does
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
    }, 300000)
    it('megablock', () => { // the hive fills the whole buildable piece (user review): every cell inside it
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

  it('S42 strip-block buildings read as sheds: median long side >= 28 m', () => {
    const m = gen(S42), strips = new Set(m.blocks.filter((b) => b.style === 'strip').map((b) => b.id))
    const longSide = (fp: Pt[]) => Math.max(...Array.from({ length: fp.length }, (_, i) => {
      const a = fp[i], b = fp[(i + 1) % fp.length], c = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / c, uy = (b.y - a.y) / c
      const t = fp.map((p) => (p.x - a.x) * ux + (p.y - a.y) * uy)
      return Math.max(...t) - Math.min(...t)
    }))
    const ls = m.buildings.filter((b) => strips.has(b.blockId)).map((b) => longSide(b.footprint)).sort((p, q) => p - q)
    expect(ls.length).toBeGreaterThan(20)
    expect(ls[Math.floor(ls.length / 2)]).toBeGreaterThanOrEqual(28)
  }, 300000)

  it.each([['S42', S42], ['S782', S782]] as const)('%s strip, sheds and bigbox blocks of 3000 m2 or more are never empty', (_, p) => {
    const m = gen(p), built = new Set(m.buildings.map((b) => b.blockId))
    none('empty strip/sheds/bigbox blocks', m.blocks.filter((b) => ['strip', 'sheds', 'bigbox'].includes(b.style) && Math.abs(ringArea(b.footprint)) >= 3000 && !built.has(b.id)).map((b) => `${b.id} ${b.style}`))
  }, 300000)

  it.each([['S42', S42], ['S782', S782]] as const)('%s blocks of 0.5 ha or more are built (sparse-block guard)', (_, p) => {
    const m = gen(p), lotted = new Set(m.lots.map((l) => l.blockId))
    const area = new Map<string, number>()
    for (const b of m.buildings) area.set(b.blockId, (area.get(b.blockId) ?? 0) + Math.abs(ringArea(b.footprint)))
    const big = m.blocks.filter((b) => Math.abs(ringArea(b.footprint)) >= 5000)
    // empty only as open grounds or a plaza too small for a pavilion, with no buildable piece, or drawn over water (S782: B8227, B8232)
    none('empty blocks of 0.5 ha or more', big.filter((b) => !area.has(b.id) && b.style !== 'plaza' && lotted.has(b.id) && !inWater(m.terrain, ringCentroid(b.footprint))).map((b) => `${b.id} ${b.style}`))
    expect(big.filter((b) => (area.get(b.id) ?? 0) < 0.1 * Math.abs(ringArea(b.footprint))).length).toBeLessThanOrEqual(SPARSE[p.seed])
  }, 300000)

  describe('road strips', () => {
    it.each(SEEDS)('lots never overlap a road strip (%s)', (_, params) => {
      const m = gen(params)
      const idx = roadIndex(m)
      const hw = m.roads.find((r) => r.class === 'highway')
      const by: Record<string, number> = { street: SETBACK.street, ramp: SETBACK.ramp, arterial: SETBACK.arterial }
      // R1 simplifies the outline at 2 m, so a chord may sit up to 2 m inside its road side: the bound is setback - 2.5 m
      // (2 m simplification budget + the spec's 0.5 m); vertices nearer than setback - 0.5 m are counted as a ratchet
      const bad = new Map<string, string>(), near = new Set<string>()
      const check = (b: Building, sb: number, d: number, what: string) => {
        if (d < sb - 2.5) bad.set(b.id, `${b.id}/${b.shape}/${b.blockId} near ${what} ${d.toFixed(1)} m`)
        if (d < sb - 0.5) near.add(b.id)
      }
      for (const b of m.buildings) for (const p of b.footprint) {
        idx.forEachInRadius(p, 30, (seg, _pt, d) => check(b, by[seg.cls], d, seg.id))
        if (hw) {
          const { dist: d, t } = nearestT(p, hw.points)
          check(b, hw.segments && levelAt(hw.segments, t) === 'sunken' ? SETBACK.sunken : SETBACK.highway, d, 'highway')
        }
      }
      none(`buildings short of their setback (of ${m.buildings.length})`, [...bad.values()])
      expect(near.size).toBeLessThanOrEqual(SIMPLIFIED_NEAR[params.seed])
    }, 300000)
  })

  it('fabric mix', () => {
    // measured after the user review (weights, block fill, coherence 0.4), pooled over the four seeds (share / weight; rows with < 20 blocks are not asserted):
    // residential sparse n=15 detached .47/.50 villas .20/.20 rows .33/.30
    // residential dense n=782 perimeter .12/.15 terrace .32/.32 rows .34/.33 zeilen .18/.15 tower-park .04/.05
    // residential packed n=307 perimeter .30/.30 terrace .40/.45 zeilen .17/.15 tower-park .11/.10
    // mixed sparse n=8; mixed dense n=470 perimeter .15/.15 shophouse .40/.40 rows .30/.30 podium .06/.05 blockfill .09/.10
    // mixed packed n=212 perimeter .08/.10 shophouse .43/.40 rows .24/.20 podium .04/.05 blockfill .21/.25
    // commerce n=252 perimeter .07/.05 shophouse .55/.50 podium .09/.10 plaza .00/.10 garage .08/.05 bigbox .07/.10 blockfill .12/.10
    // commerce packed n=131 shophouse .41/.40 podium .09/.10 plaza .00/.10 garage .03/.05 bigbox .15/.10 blockfill .28/.25
    // corp n=738 podium .19/.15 tower-park .18/.20 plaza .00/.10 shophouse .52/.45 blockfill .09/.10
    // corp packed n=427 podium .15/.15 tower-park .21/.20 plaza .00/.10 shophouse .36/.30 blockfill .26/.25
    // industrial n=642 bigbox .40/.50 sheds .37/.35 rows .23/.15; fringe n=15
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
        const key = fabricRow(sz, dc)
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

  it('arcologies without a ring road mostly get open grounds', () => {
    const open: boolean[] = []
    let holeBuilt = 0
    for (let seed = 1; seed <= 30; seed++) {
      const p = tagged(['inland', 'small', 'arcology'], seed, 1)
      const m = generateSector(p)
      for (const a of m.arcologies.filter((x) => x.access !== 'ring')) {
        const bl = m.blocks.find((b) => b.flags?.arcology === a.id)
        if (!bl) continue
        const inside = m.buildings.filter((b) => b.blockId === bl.id && pointInRings(ringCentroid(b.footprint), [a.plaza])).length
        open.push(bl.style === 'plaza' && inside === 0)
        if (bl.style === 'perimeter') holeBuilt++
      }
      if (seed === 1) expect(generateSector(p).lots).toEqual(m.lots)
    }
    expect(open.length).toBeGreaterThan(0)
    expect(open.some(Boolean)).toBe(true)
    expect(holeBuilt / open.length).toBeLessThanOrEqual(0.25)
  }, 300000)
})
