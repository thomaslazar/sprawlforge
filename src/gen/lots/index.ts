import { difference, type Geom } from '../clip'
import { pointInRings, ringArea, ringCentroid, simplifyPolyline, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { inWater } from '../sector/bridges'
import { simplifyFace } from '../streets/graph'
import { RoadIndex } from '../streets/trace'
import { isStripBlock, megablockOf, ringArcologyOf } from '../streets/lots'
import { fractalNoise2D } from '../terrain/noise'
import type { Arcology, Block, BlockStyle, Compound, District, Lot, Building, Megablock, Road, SectorParams, Terrain } from '../types'
import { MIN_FIT, chooseFabric, densityClass, fabricCell, sheetZone } from './fabrics'
import { fitBox, widthOk } from './fitbox'
import { compoundLots, megablockLots, outset } from './landmarks'
import { buildLot, fillerOf, layoutPiece, type BlockCtx, type LotOut } from './layout'
import { STRIP_PARAMS, stripLots } from './strips'
import { SETBACK, buildable, edgeSetbacks, pieceSetbacks, roadClearance, sidesOf, type SetbackCtx } from './setback'

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const toRing = (p: Pt[]) => p.map((q) => [q.x, q.y] as [number, number])
const fromRing = (r: [number, number][]): Pt[] => r.slice(0, -1).map(([x, y]) => ({ x, y }))
const ccw = (r: Pt[]) => (ringArea(r) < 0 ? [...r].reverse() : r)
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)
const WHOLE = new Set<BlockStyle>(Object.keys(MIN_FIT) as BlockStyle[])
const ARC_TURN = (15.5 * Math.PI) / 180
const MIN_LOT_AREA = 0.5

/** R1: simplifyFace, then Douglas-Peucker at 2 m on the closed ring */
function simplified(fp: Pt[]): Pt[] {
  const f = simplifyFace(fp)
  const s = simplifyPolyline([...f, f[0]], 2).slice(0, -1)
  return s.length >= 3 ? s : f
}

/** R22: the face minus the plazas that touch or cross its boundary (a plaza wholly inside stays a hole of the piece, see `holesIn`); outer rings only */
function cutPlazas(fp: Pt[], plazas: Pt[][]): Pt[][] {
  const hit = plazas.filter((pl) => !inside(pl, fp) && (pl.some((p) => pointInRings(p, [fp])) || fp.some((p) => pointInRings(p, [pl])) || pointInRings(ringCentroid(pl), [fp])))
  return hit.length ? difference([toRing(fp)], ...hit.map((pl) => [toRing(pl)] as Geom)).map((pg) => fromRing(pg[0])) : [fp]
}
const inside = (inner: Pt[], outer: Pt[]) => inner.every((p) => pointInRings(p, [outer]))

/** per-vertex turn of a ring is <= 15.5 degrees (an arc point) */
function smoothAt(ring: Pt[], i: number): boolean {
  const n = ring.length, a = ring[(i + n - 1) % n], b = ring[i], c = ring[(i + 1) % n]
  const t = Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y))
  return Math.abs(t) <= ARC_TURN
}
/** the acceptance gate: every non-arc edge >= 3 m, width >= 6 m, area >= 60 m2 */
function accepted(fp: Pt[]): boolean {
  if (Math.abs(ringArea(fp)) < 60 || !widthOk(fp, 6)) return false
  return fp.every((p, i) => dist(p, fp[(i + 1) % fp.length]) >= 3 || (smoothAt(fp, i) && smoothAt(fp, (i + 1) % fp.length)))
}

export function fillLots(
  districts: District[],
  blocks: Block[],
  params: SectorParams,
  terrain: Terrain,
  roads: Road[],
  landmarks?: { arcologies: Arcology[]; megablocks: Megablock[] },
  highway?: Road,
  frontage: Road[] = [],
  compoundsIn: Array<{ blockId: string; gateToward: Pt }> = [],
  forceStyle?: BlockStyle,
): { buildings: Building[]; lots: Lot[]; blocks: Block[]; megablockCores: Map<string, Pt[]>; compounds: Compound[]; rejected: number } {
  const sizeM = params.size * 1000
  const neighbourhood = fractalNoise2D(hashSeed(params.seed, 'neighbourhood'), 2)
  const districtById = new Map(districts.map((d) => [d.id, d]))
  const plazas = (landmarks?.arcologies ?? []).filter((a) => a.access !== 'ring').map((a) => a.plaza)
  const index = new RoadIndex(100)
  for (const r of roads) if (r.class !== 'highway') index.add(r.id, r.points, r.class)
  const sctx: SetbackCtx = { index, highway, terrain, sizeM, grounds: plazas }
  const stream = (name: string, block: Block) => mulberry32(hashSeed(params.seed, name, block.id))

  const buildings: Building[] = []
  const lots: Lot[] = []
  const outBlocks: Block[] = []
  const megablockCores = new Map<string, Pt[]>()
  const compounds: Compound[] = []
  let rejected = 0

  /** numbers the lots, gates their buildings and appends everything */
  const emit = (block: Block, district: District, fabric: BlockStyle, ctx: BlockCtx, out: LotOut[]): void => {
    for (const l of out) {
      const poly = ccw(l.poly)
      if (Math.abs(ringArea(poly)) < MIN_LOT_AREA) continue
      const lotId = `LOT${String(lots.length + 1).padStart(5, '0')}`
      const ids: string[] = []
      for (const b of l.buildings) {
        const fp = ccw(b.footprint)
        if (inWater(terrain, ringCentroid(fp))) continue
        if (!accepted(fp)) { rejected++; continue }
        const id = `BLD${String(buildings.length + 1).padStart(4, '0')}`
        ids.push(id)
        buildings.push({ id, blockId: block.id, districtId: district.id, footprint: fp, shape: b.shape, lotId, ...(b.details.length ? { details: b.details } : {}) })
      }
      const kind = l.buildings.length && !ids.length ? fillerOf(fabric, ctx.zone, 'interior') : l.kind
      lots.push({ id: lotId, blockId: block.id, poly, kind, buildingIds: ids })
    }
  }

  for (const block of blocks) {
    const district = districtById.get(block.districtId)
    if (!district) { outBlocks.push(block); continue }
    const cc = ringCentroid(block.footprint)
    const d = clamp01(0.6 * params.density + 0.6 * neighbourhood(cc.x / 500, cc.y / 500) - 0.1)
    const dc = densityClass(d)
    const ctx: BlockCtx = {
      zone: sheetZone(district.zone, dc), density: dc,
      rng: { lots: stream('lots', block), shapes: stream('shapes', block), composites: stream('composites', block) },
    }
    const arc = ringArcologyOf(block, landmarks)
    if (arc) {
      emit(block, district, 'plaza', ctx, [{ poly: block.footprint, kind: 'plaza', buildings: [] }])
      outBlocks.push({ ...block, style: 'plaza', alleys: [], flags: { ...block.flags, arcology: arc.id } })
      continue
    }
    const mega = megablockOf(block, landmarks)
    const comp = mega ? undefined : compoundsIn.find((k) => k.blockId === block.id)
    if (comp) {
      const res = compoundLots(block.footprint, comp.gateToward, ctx, stream('compound-lots', block), roadClearance(ccw(simplifyFace(block.footprint)), sctx))
      // a crescent block's fence centroid can fall in the bay: no compound there (its POI would sit in water)
      if (res && !inWater(terrain, ringCentroid(res.fence))) {
        emit(block, district, 'compound', ctx, res.lots)
        const cid = `CMP${compounds.length + 1}`
        compounds.push({ id: cid, name: '', blockId: block.id, districtId: district.id, center: ringCentroid(res.fence), fence: res.fence, gate: res.gate })
        outBlocks.push({ ...block, style: 'compound', alleys: [], flags: { ...block.flags, compound: cid } })
        continue
      }
    }

    // R22 cut, R1 simplify, R2 setbacks, R3 buildable
    const home = landmarks?.arcologies.find((a) => a.access !== 'ring' && pointInRings(a.center, [block.footprint]))
    const pieces: Array<{ poly: Pt[]; setbacks: number[]; holes: Pt[][] }> = []
    for (const cut of cutPlazas(ccw(simplified(block.footprint)), plazas)) {
      const fp = ccw(cut), sb = edgeSetbacks(fp, sctx, simplifyFace(block.footprint))
      for (const poly0 of buildable(fp, sb)) {
        // a plaza clear of the piece edge stays a hole the lots face, 6 m (the ground setback) out, less where the piece is too tight; one reaching the edge is cut out
        const covered = (pl: Pt[], d: number) => difference([toRing(ccw(outset(ccw(pl), d + 1.5)))], [toRing(poly0)]).length === 0 // 1.5 m to spare: the clipper misreads a hole that nearly touches its piece
        const grounds = plazas.map((pl) => ccw(outset(ccw(pl), [SETBACK.ground, 4, 2, 0].find((d) => covered(pl, d)) ?? SETBACK.ground)))
          .filter((h) => h.some((p) => pointInRings(p, [poly0])) || poly0.some((p) => pointInRings(p, [h])))
        const clear = roadClearance(poly0, sctx)
        const polys = grounds.length || clear.length ? difference([toRing(poly0)], ...[...grounds, ...clear].map((h) => [toRing(h)] as Geom)) : [[[...toRing(poly0), toRing(poly0)[0]]]]
        for (const pg of polys) {
          const poly = ccw(fromRing(pg[0]))
          if (ringArea(poly) >= 200) pieces.push({ poly, setbacks: pieceSetbacks(poly, fp, sb), holes: pg.slice(1).map((r) => ccw(fromRing(r))) })
        }
      }
    }
    const strip = !mega && isStripBlock(block, highway, frontage)
    let style: BlockStyle = 'rows'
    let alleys: Array<[Pt, Pt]> = []

    if (mega) {
      // the piece holding the centre, else the biggest; a block with no piece at all lots its footprint
      const fallback = ccw(block.footprint)
      const all = pieces.length ? pieces : [{ poly: fallback, setbacks: [] as number[], holes: [] as Pt[][] }]
      const area = (p: { poly: Pt[] }) => Math.abs(ringArea(p.poly))
      const main = all.find((p) => pointInRings(mega.center, [p.poly])) ?? all.reduce((b, p) => (area(p) > area(b) ? p : b))
      const radius = mega.core.length ? mega.core.reduce((t, p) => t + dist(p, mega.center), 0) / mega.core.length : 100
      const r = megablockLots(main.poly, sidesOf(main.poly, main.setbacks), radius, ctx, stream('megablocks', block))
      megablockCores.set(mega.id, r.core)
      emit(block, district, 'megablock', ctx, r.lots)
      alleys = r.alleys
      style = 'megablock'
      for (const p of all) if (p !== main) emit(block, district, 'rows', ctx, layoutPiece(p.poly, sidesOf(p.poly, p.setbacks), 'rows', ctx))
    } else {
      const fabricRng = stream('fabric', block)
      pieces.forEach((p, k) => {
        const sides = sidesOf(p.poly, p.setbacks)
        const longest = sides.reduce((b, s) => (dist(...s.chord) > dist(...b.chord) ? s : b)).chord
        const box = fitBox(p.poly, longest)
        const fits = (f: BlockStyle) => { const m = MIN_FIT[f]; return !m || (box.w >= m[0] && box.d >= m[1]) || (box.w >= m[1] && box.d >= m[0]) }
        let fabric: BlockStyle = strip ? 'strip' : forceStyle ?? chooseFabric(ctx.zone, dc, fabricCell(params.seed, cc), fabricRng, fits)
        // R39: a ground-side block gets a built front
        if (home && !strip && !forceStyle && WHOLE.has(fabric)) fabric = 'perimeter'
        if (p.holes.length && !STRIP_PARAMS[fabric]) fabric = 'perimeter'
        const out = p.holes.length
          ? stripLots(p.poly, sides, STRIP_PARAMS[fabric]!(ctx.rng.lots), ctx.rng.lots, p.holes).map((l) => buildLot(l, fabric, ctx))
          : layoutPiece(p.poly, sides, fabric, ctx)
        if (k === 0) style = fabric
        emit(block, district, fabric, ctx, out)
      })
    }
    outBlocks.push({ ...block, style, alleys, flags: { ...block.flags, ...(mega ? { megablock: mega.id } : {}), ...(home ? { arcology: home.id } : {}) } })
  }

  return { buildings, lots, blocks: outBlocks, megablockCores, compounds, rejected }
}
