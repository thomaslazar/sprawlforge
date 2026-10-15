import { difference, intersection, type Geom } from '../clip'
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
import { compoundLots, megablockLots } from './landmarks'
import { fillerOf, layoutPiece, type BlockCtx, type LotOut } from './layout'
import { buildable, edgeSetbacks, pieceSetbacks, sidesOf, type SetbackCtx } from './setback'

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

/** R22: the face minus its non-ring arcology plazas, hole-free (a ring with a hole is split by a line through the hole along the face's long axis) */
function cutPlazas(fp: Pt[], plazas: Pt[][]): Pt[][] {
  const hit = plazas.filter((pl) => pl.some((p) => pointInRings(p, [fp])) || fp.some((p) => pointInRings(p, [pl])) || pointInRings(ringCentroid(pl), [fp]))
  if (!hit.length) return [fp]
  const out: Pt[][] = []
  for (const pg of difference([toRing(fp)], ...hit.map((pl) => [toRing(pl)] as Geom))) {
    if (pg.length === 1) { out.push(fromRing(pg[0])); continue }
    const o = fromRing(pg[0]), c = ringCentroid(fromRing(pg[1]))
    const e = o.reduce((b, p, i) => (dist(p, o[(i + 1) % o.length]) > dist(b[0], b[1]) ? [p, o[(i + 1) % o.length]] : b), [o[0], o[1]])
    const l = dist(e[0], e[1]) || 1, u = { x: (e[1].x - e[0].x) / l, y: (e[1].y - e[0].y) / l }, n = { x: -u.y, y: u.x }, B = 1e5
    for (const s of [1, -1]) {
      const half = [[-B, 0], [B, 0], [B, s * B], [-B, s * B]].map(([a, b]) => ({ x: c.x + u.x * a + n.x * b, y: c.y + u.y * a + n.y * b }))
      for (const q of intersection([toRing(o)], [toRing(half)])) out.push(fromRing(q[0]))
    }
  }
  return out
}

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
      const res = compoundLots(block.footprint, comp.gateToward, ctx, stream('compound-lots', block))
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
    const sctx: SetbackCtx = { index, highway, terrain, sizeM, grounds: plazas }
    const pieces: Array<{ poly: Pt[]; setbacks: number[] }> = []
    for (const cut of cutPlazas(ccw(simplified(block.footprint)), plazas)) {
      const fp = ccw(cut), sb = edgeSetbacks(fp, sctx)
      for (const poly of buildable(fp, sb)) pieces.push({ poly, setbacks: pieceSetbacks(poly, fp, sb) })
    }
    const strip = !mega && isStripBlock(block, highway, frontage)
    let style: BlockStyle = 'rows'
    let alleys: Array<[Pt, Pt]> = []

    if (mega) {
      // the piece holding the centre, else the biggest; a block with no piece at all lots its footprint
      const fallback = ccw(block.footprint)
      const all = pieces.length ? pieces : [{ poly: fallback, setbacks: [] as number[] }]
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
        if (k === 0) style = fabric
        emit(block, district, fabric, ctx, layoutPiece(p.poly, sides, fabric, ctx))
      })
    }
    outBlocks.push({ ...block, style, alleys, flags: { ...block.flags, ...(mega ? { megablock: mega.id } : {}), ...(home ? { arcology: home.id } : {}) } })
  }

  return { buildings, lots, blocks: outBlocks, megablockCores, compounds, rejected }
}
