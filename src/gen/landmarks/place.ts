import type { Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { effectiveIrregularity } from '../sector/zoning'
import { inWater } from '../sector/bridges'
import type { RoadField } from '../streets/field'
import { distToPolyline } from '../terrain/rivers'
import { designShape, openingOf } from './designs'
import type { Arcology, ArcologyAccess, ArcologyDesign, Megablock, RingShape, Road, SectorParams, Terrain } from '../types'

export interface Landmarks { arcologies: Arcology[]; megablocks: Megablock[] }

const DESIGNS: ArcologyDesign[] = ['rings', 'ziggurat', 'cluster', 'satellites', 'twins', 'crescent', 'stack']
const LATTICE = 300
const JITTER = 90
const EDGE_MARGIN = 350
// clearances beyond a landmark's outer radius (ring road r + 60; megablock core 1.2 x r)
const WATER_CLEAR = 40
const HIGHWAY_CLEAR = 150
const RING_GAP = 60
const ARC_SPACING = 900
const MEGA_SPACING = 700

/** id prefix of arcology ring roads */
export const RING_ID_PREFIX = 'K'

export function octagon(center: Pt, radius: number, angle: number, jitter: (i: number) => number = () => 1): Pt[] {
  return Array.from({ length: 8 }, (_, i) => {
    const a = angle + (i * Math.PI) / 4
    const r = radius * jitter(i)
    return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) }
  })
}

/** the K road of a `ring` / `half` arcology; boulevard and embedded have none */
export function ringRoad(a: Arcology): Road | null {
  if (a.access === 'boulevard' || a.access === 'embedded') return null
  const r = a.radius + 60
  const at = (t: number, rr = r) => ({ x: a.center.x + rr * Math.cos(t), y: a.center.y + rr * Math.sin(t) })
  let points: Pt[]
  if (a.access === 'half') {
    return { id: a.ringRoadId, class: 'arterial', width: 18, name: null,
      points: Array.from({ length: 25 }, (_, i) => at(a.angle + (a.side ?? 0) + (i * Math.PI) / 24)) }
  }
  if (a.ringShape === 'octagon') points = octagon(a.center, r, a.angle)
  else if (a.ringShape === 'square') {
    // rounded square, corner radius 0.3 r: four 12-point corner arcs joined by the straight sides
    const c = 0.3 * r, o = r - c
    points = []
    for (let q = 0; q < 4; q++) {
      const base = a.angle + q * (Math.PI / 2) + Math.PI / 4, k = { x: a.center.x + o * Math.SQRT2 * Math.cos(base), y: a.center.y + o * Math.SQRT2 * Math.sin(base) }
      for (let i = 0; i < 12; i++) { const t = base - Math.PI / 4 + (i * Math.PI) / 2 / 11; points.push({ x: k.x + c * Math.cos(t), y: k.y + c * Math.sin(t) }) }
    }
  } else points = Array.from({ length: 48 }, (_, i) => at((i * 2 * Math.PI) / 48))
  points.push({ ...points[0] })
  return { id: a.ringRoadId, class: 'arterial', width: 18, points, name: null }
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

function distToWater(terrain: Terrain, p: Pt): number {
  let best = Infinity
  for (const poly of terrain.water) for (const ring of poly) {
    const line = ring.map(([x, y]) => ({ x, y }))
    if (line.length) line.push(line[0])
    best = Math.min(best, distToPolyline(p, line))
  }
  return best
}

/** count cell: a range, or a probability of exactly one (spec §12.1) */
type Cell = { lo: number; hi: number } | { p: number }
const R = (lo: number, hi: number): Cell => ({ lo, hi })
const P = (p: number): Cell => ({ p })
// rows: corp-run, balanced, fringe; columns: small (<= 2 km), medium (<= 4 km), large
const ARCOLOGIES: Cell[][] = [[P(0.5), R(1, 2), R(2, 3)], [R(0, 0), P(0.5), R(0, 1)], [R(0, 0), R(0, 0), P(0.15)]]
const MEGABLOCKS: Cell[][] = [[R(0, 0), R(0, 0), P(0.2)], [P(0.3), R(0, 1), R(1, 2)], [R(1, 1), R(1, 3), R(2, 4)]]

/** exactly one rng draw per count, whatever the cell kind */
function drawCount(rng: ReturnType<typeof mulberry32>, table: Cell[][], c: number, sizeM: number): number {
  const cell = table[c >= 0.7 ? 0 : c >= 0.3 ? 1 : 2][sizeM <= 2000 ? 0 : sizeM <= 4000 ? 1 : 2]
  return 'p' in cell ? (rng.next() < cell.p ? 1 : 0) : rng.int(cell.lo, cell.hi)
}

export function placeLandmarks(
  params: SectorParams, terrain: Terrain, sizeM: number, highway: Road | undefined, field: RoadField,
): Landmarks {
  const rng = mulberry32(hashSeed(params.seed, 'landmarks'))
  // three independent streams so adding designs/access kinds never moves placements:
  // 'landmarks' (placement: counts, radii, jitters), 'design' (shuffle), 'access' (access/ringShape/side), 'detail' (count/twist)
  const designRng = mulberry32(hashSeed(params.seed, 'landmarks', 'design'))
  const accessRng = mulberry32(hashSeed(params.seed, 'landmarks', 'access'))
  const detailRng = mulberry32(hashSeed(params.seed, 'landmarks', 'detail'))
  // placement draw order is fixed: arcology count, radii, megablock count, jitters, megaRadii
  const nArc = Math.max(drawCount(rng, ARCOLOGIES, params.corpDominance, sizeM), params.arcology ? 1 : 0)
  const radii = Array.from({ length: nArc }, () => rng.int(100, 180))
  const nMega = Math.max(drawCount(rng, MEGABLOCKS, params.corpDominance, sizeM), params.megablock ? 1 : 0)
  const jitters = Array.from({ length: nMega }, () => Array.from({ length: 8 }, () => 0.8 + rng.next() * 0.4))
  const megaRadii = Array.from({ length: nMega }, () => rng.int(150, 250))

  // candidate lattice
  const jr = mulberry32(hashSeed(params.seed, 'landmarks', 'lattice'))
  const cands: Pt[] = []
  for (let x = EDGE_MARGIN; x <= sizeM - EDGE_MARGIN; x += LATTICE)
    for (let y = EDGE_MARGIN; y <= sizeM - EDGE_MARGIN; y += LATTICE) {
      const p = {
        x: Math.min(sizeM - EDGE_MARGIN, Math.max(EDGE_MARGIN, x + (jr.next() * 2 - 1) * JITTER)),
        y: Math.min(sizeM - EDGE_MARGIN, Math.max(EDGE_MARGIN, y + (jr.next() * 2 - 1) * JITTER)),
      }
      if (!inWater(terrain, p)) cands.push(p)
    }
  // per-candidate clearance: water and highway distance must exceed the landmark's outer radius plus a margin
  const waterD = new Map<Pt, number>(cands.map((c) => [c, distToWater(terrain, c)]))
  const hwD = new Map<Pt, number>(cands.map((c) => [c, highway && highway.points.length > 1 ? distToPolyline(c, highway.points) : Infinity]))
  const clear = (c: Pt, outer: number) => waterD.get(c)! >= outer + WATER_CLEAR && hwD.get(c)! >= outer + HIGHWAY_CLEAR

  const centre = { x: sizeM / 2, y: sizeM / 2 }
  const arcCentres: Pt[] = []
  for (let k = 0; k < nArc; k++) {
    const pool = cands.filter((c) => clear(c, radii[k] + RING_GAP) && arcCentres.every((a) => dist(a, c) >= ARC_SPACING))
    if (!pool.length) break
    const score = (c: Pt) => (k === 0 ? -dist(c, centre) : Math.min(...arcCentres.map((a) => dist(a, c))))
    arcCentres.push(pool.reduce((b, c) => (score(c) > score(b) ? c : b)))
  }
  // designs: own stream; shuffled once, a fifth arcology restarts the list
  const order = [...DESIGNS]
  for (let i = order.length - 1; i > 0; i--) { const j = designRng.int(0, i); [order[i], order[j]] = [order[j], order[i]] }
  // access: own stream; weights 40/20/20/20
  const ACCESS: ArcologyAccess[] = ['ring', 'half', 'boulevard', 'embedded']
  const SHAPES: RingShape[] = ['circle', 'square', 'octagon']
  const used = new Set<string>()
  const angleOf = arcCentres.map((c) => { const m = field.sample(c).major; return Math.atan2(m.y, m.x) })
  const accessOf = arcCentres.map((_, i) => {
    const r = accessRng.next()
    let k = r < 0.4 ? 0 : Math.min(3, 1 + Math.floor((r - 0.4) / 0.2))
    // no two arcologies share a (design, access) pair while another pair is free: walk on from the drawn slot
    const design = order[i % order.length]
    for (let n = 0; n < 4 && used.has(`${design}/${ACCESS[k]}`); n++) k = (k + 1) % 4
    used.add(`${design}/${ACCESS[k]}`)
    const access = ACCESS[k]
    const ringShape = access === 'ring' ? SHAPES[Math.min(2, Math.floor(accessRng.next() * 3))] : undefined
    let side = access === 'half' || access === 'boulevard' ? (accessRng.next() < 0.5 ? 0 : Math.PI) : undefined
    // a boulevard follows the field, so it must run tangentially there or it rams the plaza and is pruned: flip to the other side if the drawn one doesn't
    if (access === 'boulevard') {
      const tangential = (t: number) => {
        const f = field.sample({ x: arcCentres[i].x + (radii[i] + 60) * Math.cos(t), y: arcCentres[i].y + (radii[i] + 60) * Math.sin(t) })
        const nx = -Math.sin(t), ny = Math.cos(t)
        return Math.max(Math.abs(f.major.x * nx + f.major.y * ny), Math.abs(f.minor.x * nx + f.minor.y * ny)) >= Math.cos(0.45)
      }
      const t0 = angleOf[i] + side!
      if (!tangential(t0) && tangential(t0 + Math.PI)) side = side === 0 ? Math.PI : 0
    }
    return { access, ringShape, side }
  })
  // details: own stream, two per arcology whatever the design
  const COUNTS: Record<ArcologyDesign, [number, number]> = { rings: [0, 0], twins: [0, 0], crescent: [0, 0], ziggurat: [3, 4], cluster: [5, 8], satellites: [4, 7], stack: [3, 4] }
  const details = arcCentres.map((_, i) => {
    const [lo, hi] = COUNTS[order[i % order.length]]
    const count = lo + Math.floor(detailRng.next() * (hi - lo + 1))
    return { count, twist: detailRng.next() * (Math.PI / 4) }
  })
  const arcologies: Arcology[] = arcCentres.map((center, i) => {
    const radius = radii[i]
    const angle = angleOf[i]
    const design = order[i % order.length]
    return {
      id: `ARC${i + 1}`, name: '', design, angle, center, radius,
      footprint: designShape(design, center, radius, angle, details[i], openingOf(angle, accessOf[i].side, details[i].twist)).outline,
      plaza: octagon(center, radius + 40, angle),
      ringRoadId: `${RING_ID_PREFIX}${i + 1}`,
      ...accessOf[i], detail: details[i],
    }
  })

  const irr = effectiveIrregularity(params)
  const megaCentres: Pt[] = []
  const taken = (c: Pt) => [...arcCentres, ...megaCentres].every((a) => dist(a, c) >= MEGA_SPACING)
  for (let k = 0; k < nMega; k++) {
    const pool = cands.filter((c) => clear(c, 1.2 * megaRadii[k]) && taken(c))
    if (!pool.length) break
    megaCentres.push(pool.reduce((b, c) => (irr(c) > irr(b) ? c : b)))
  }
  const megablocks: Megablock[] = megaCentres.map((center, i) => {
    const m = field.sample(center).major
    return {
      id: `MEG${i + 1}`, name: '', center,
      core: octagon(center, megaRadii[i], Math.atan2(m.y, m.x), (v) => jitters[i][v]),
      footprint: [],
    }
  })
  return { arcologies, megablocks }
}
