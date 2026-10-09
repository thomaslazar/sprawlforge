import { ringArea, ringCentroid, type Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { landM2 } from '../sector/bridges'
import type { Block, District, Road, SectorParams, Terrain } from '../types'

const MIN_LAND_M2 = 15_000
const BIG_DISTRICT_M2 = 400_000
const NEAR_ROAD_M = 15
/** chance a corp district holds a compound, by corpDominance band */
const bandP = (c: number): number => (c >= 0.7 ? 0.6 : c >= 0.3 ? 0.3 : 0.1)

const dist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

/** midpoint of the footprint edge nearest the widest road within 15 m of a footprint vertex, else nearest the district centroid */
function gateToward(block: Block, district: District, roads: Road[]): Pt {
  const fp = block.footprint
  let target = ringCentroid(district.poly)
  let widest = 0
  let best: { r: Road; d: number } | null = null
  for (const r of roads) {
    if (r.width <= widest) continue
    let d = Infinity
    for (const p of fp) for (let i = 0; i + 1 < r.points.length; i++) d = Math.min(d, dist(p, r.points[i], r.points[i + 1]))
    if (d <= NEAR_ROAD_M) { widest = r.width; best = { r, d } }
  }
  const edges = fp.map((p, i) => ({ a: p, b: fp[(i + 1) % fp.length] }))
  const near = (e: { a: Pt; b: Pt }) => {
    if (!best) return Math.hypot((e.a.x + e.b.x) / 2 - target.x, (e.a.y + e.b.y) / 2 - target.y)
    let d = Infinity
    const pts = best.r.points
    for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, dist({ x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }, pts[i], pts[i + 1]))
    return d
  }
  let pick = edges[0]
  let pd = near(pick)
  for (const e of edges) { const d = near(e); if (d < pd) { pick = e; pd = d } }
  return { x: (pick.a.x + pick.b.x) / 2, y: (pick.a.y + pick.b.y) / 2 }
}

/** picks which corp-district blocks become walled compounds (spec 3.1); geometry is lots.ts's job */
export function selectCompounds(districts: District[], blocks: Block[], params: SectorParams, terrain: Terrain, isStrip: (b: Block) => boolean, roads: Road[]): Array<{ id: string; blockId: string; districtId: string; gateToward: Pt }> {
  const rng = mulberry32(hashSeed(params.seed, 'compounds'))
  const p = bandP(params.corpDominance)
  const out: Array<{ id: string; blockId: string; districtId: string; gateToward: Pt }> = []
  for (const d of [...districts].sort((a, b) => a.id.localeCompare(b.id))) {
    if (d.zone !== 'corp' || d.flags.arcology) continue
    const cands = blocks
      .filter((b) => b.districtId === d.id && !b.flags.arcology && !b.flags.megablock && !b.flags.compound && !isStrip(b))
      .map((b) => ({ b, land: landM2(terrain, b.footprint) }))
      .filter((c) => c.land >= MIN_LAND_M2)
      .sort((x, y) => y.land - x.land)
    const hits = [rng.next() < p]
    if (Math.abs(ringArea(d.poly)) > BIG_DISTRICT_M2) hits.push(rng.next() < p)
    hits.forEach((hit, k) => {
      const c = cands[k]
      if (hit && c) out.push({ id: `C${String(out.length + 1).padStart(2, '0')}`, blockId: c.b.id, districtId: d.id, gateToward: gateToward(c.b, d, roads) })
    })
  }
  return out
}
