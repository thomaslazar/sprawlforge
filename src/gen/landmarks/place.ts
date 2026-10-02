import type { Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { effectiveIrregularity } from '../sector/zoning'
import { inWater } from '../sector/bridges'
import type { RoadField } from '../streets/field'
import { distToPolyline } from '../terrain/rivers'
import type { Arcology, Megablock, Road, SectorParams, Terrain } from '../types'

export interface Landmarks { arcologies: Arcology[]; megablocks: Megablock[] }

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

export function ringRoad(a: Arcology): Road {
  const r = a.radius + 60
  const points = Array.from({ length: 48 }, (_, i) => {
    const t = (i * 2 * Math.PI) / 48
    return { x: a.center.x + r * Math.cos(t), y: a.center.y + r * Math.sin(t) }
  })
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

/** counts per spec §2.4: [arcology min,max, megablock min,max] */
function countRanges(c: number): [number, number, number, number] {
  if (c >= 0.7) return [2, 3, 0, 1]
  if (c >= 0.3) return [1, 2, 1, 2]
  return [0, 1, 2, 4]
}

export function placeLandmarks(
  params: SectorParams, terrain: Terrain, sizeM: number, highway: Road | undefined, field: RoadField,
): Landmarks {
  const rng = mulberry32(hashSeed(params.seed, 'landmarks'))
  const [aLo, aHi, mLo, mHi] = countRanges(params.corpDominance)
  const cap = sizeM <= 2000 ? 1 : Infinity
  // draw order is fixed: arcology count, radii, megablock count, jitters, megaRadii
  const nArc = Math.min(rng.int(aLo, aHi), cap)
  const radii = Array.from({ length: nArc }, () => rng.int(100, 180))
  const nMega = Math.min(rng.int(mLo, mHi), cap)
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
  const arcologies: Arcology[] = arcCentres.map((center, i) => {
    const radius = radii[i]
    const m = field.sample(center).major
    const angle = Math.atan2(m.y, m.x)
    return {
      id: `ARC${i + 1}`, name: '', center, radius,
      footprint: octagon(center, radius, angle),
      plaza: octagon(center, radius + 40, angle),
      ringRoadId: `${RING_ID_PREFIX}${i + 1}`,
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
