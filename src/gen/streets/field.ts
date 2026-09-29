import type { Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import { effectiveIrregularity } from '../sector/zoning'
import { fractalNoise2D } from '../terrain/noise'
import { nearestOnPolyline } from '../terrain/rivers'
import type { SectorParams, Terrain } from '../types'

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v))
const PATCH_MARGIN = 500
const SHORE_DIST = 300
const SEAM_BAND = 100
const BOUNDARY_REACH = 250
const NOISE_SCALE = 350
const NOISE_MAX = (35 * Math.PI) / 180
const GRID_STEP = 20

export interface Patch { center: Pt; angle: number; size: number; shore: boolean }
export interface FieldSample { major: Pt; minor: Pt } // unit vectors, minor ⟂ major
export interface BasisField {
  name: 'grid' | 'boundary' | 'noise' | 'spine'
  /** line-field angle in radians, or null when this basis has nothing to say at p */
  angle(p: Pt): number | null
  weight(p: Pt): number
}
export interface RoadField { sizeM: number; patches: Patch[]; sample(p: Pt): FieldSample }

// terrain is immutable and reused across every shoreTangent call within a
// build (once per patch, twice per 20 m cache cell) — memoize the derived
// polylines per terrain instance instead of re-mapping every ring vertex
// on every call.
const shoreLinesCache = new WeakMap<Terrain, Pt[][]>()

/** every ring in terrain.water plus the river course, as closed polylines */
function shoreLines(terrain: Terrain): Pt[][] {
  const cached = shoreLinesCache.get(terrain)
  if (cached) return cached
  const lines: Pt[][] = []
  for (const poly of terrain.water) {
    for (const ring of poly) {
      if (ring.length < 2) continue
      const pts: Pt[] = ring.map(([x, y]) => ({ x, y }))
      pts.push(pts[0])
      lines.push(pts)
    }
  }
  if (terrain.riverSlice && terrain.riverSlice.course.length >= 2) lines.push(terrain.riverSlice.course)
  shoreLinesCache.set(terrain, lines)
  return lines
}

/** nearest edge across all water rings/river course: its direction and distance */
export function shoreTangent(terrain: Terrain, p: Pt): { angle: number; dist: number } | null {
  const lines = shoreLines(terrain)
  let best: { dist: number; line: Pt[] } | null = null
  for (const line of lines) {
    const { dist } = nearestOnPolyline(p, line)
    if (!best || dist < best.dist) best = { dist, line }
  }
  if (!best) return null
  // find the segment that realizes the winning distance, for its tangent angle
  let segDist = Infinity
  let angle = 0
  const line = best.line
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const len2 = abx * abx + aby * aby || 1
    const t = clamp(0, 1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)
    const d = Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
    if (d < segDist) { segDist = d; angle = Math.atan2(aby, abx) }
  }
  return { angle, dist: best.dist }
}

function nearestOf(from: Pt, pool: Patch[]): Patch | null {
  let best: Patch | null = null
  let bestD = Infinity
  for (const patch of pool) {
    const d = Math.hypot(from.x - patch.center.x, from.y - patch.center.y)
    if (d < bestD) { bestD = d; best = patch }
  }
  return best
}

/** jittered lattice of orientation patches over the window plus a 500 m margin (spec §5) */
export function buildPatches(params: SectorParams, terrain: Terrain, sizeM: number): Patch[] {
  const irr = effectiveIrregularity(params)
  const rng = mulberry32(hashSeed(params.seed, 'patches'))
  const lo = -PATCH_MARGIN
  const hi = sizeM + PATCH_MARGIN
  const patches: Patch[] = []

  for (let y = lo; y <= hi; ) {
    const spacing = clamp(400, 900, 900 - 500 * ((irr({ x: lo, y }) - 0.05) / 0.9))
    for (let x = lo; x <= hi; x += spacing) {
      const center = {
        x: x + (rng.next() * 2 - 1) * 0.3 * spacing,
        y: y + (rng.next() * 2 - 1) * 0.3 * spacing,
      }
      const tangent = shoreTangent(terrain, center)
      const shore = tangent !== null && tangent.dist < SHORE_DIST
      patches.push({ center, angle: shore ? tangent!.angle : 0, size: spacing, shore })
    }
    y += spacing
  }

  const shorePatches = patches.filter((patch) => patch.shore)
  for (const patch of patches) {
    if (patch.shore) continue
    if (rng.chance(0.6)) {
      const nearestShore = nearestOf(patch.center, shorePatches)
      patch.angle = nearestShore ? nearestShore.angle : rng.next() * Math.PI
    } else {
      patch.angle = rng.next() * Math.PI
    }
  }
  return patches
}

/** grid basis: blend of nearest + second-nearest patch, doubled-angle, smooth across the Voronoi seam */
function gridBasis(patches: Patch[]): BasisField {
  return {
    name: 'grid',
    angle(p) {
      let first: Patch | null = null
      let second: Patch | null = null
      let d1 = Infinity
      let d2 = Infinity
      for (const patch of patches) {
        const d = Math.hypot(p.x - patch.center.x, p.y - patch.center.y)
        if (d < d1) { second = first; d2 = d1; first = patch; d1 = d }
        else if (d < d2) { second = patch; d2 = d }
      }
      if (!first) return null
      if (!second) return first.angle
      const w2 = clamp(0, 1, 1 - (d2 - d1) / SEAM_BAND)
      const sx = Math.cos(2 * first.angle) + w2 * Math.cos(2 * second.angle)
      const sy = Math.sin(2 * first.angle) + w2 * Math.sin(2 * second.angle)
      return sx === 0 && sy === 0 ? 0 : Math.atan2(sy, sx) / 2
    },
    weight: () => 1,
  }
}

function boundaryBasis(terrain: Terrain): BasisField {
  // angle() then weight() are always called back-to-back for the same p by
  // the sample() cache fill — memoize the one-point lookback so we don't
  // walk every shoreline segment twice per point.
  let lastP: Pt | null = null
  let lastTangent: ReturnType<typeof shoreTangent> = null
  const tangentAt = (p: Pt) => {
    if (!lastP || lastP.x !== p.x || lastP.y !== p.y) {
      lastP = p
      lastTangent = shoreTangent(terrain, p)
    }
    return lastTangent
  }
  return {
    name: 'boundary',
    angle: (p) => tangentAt(p)?.angle ?? null,
    weight: (p) => {
      const tangent = tangentAt(p)
      return tangent ? clamp(0, 1, 1 - tangent.dist / BOUNDARY_REACH) : 0
    },
  }
}

function noiseBasis(params: SectorParams, grid: BasisField): BasisField {
  const irr = effectiveIrregularity(params)
  const noise = fractalNoise2D(hashSeed(params.seed, 'field-noise'), 2)
  return {
    name: 'noise',
    angle: (p) => {
      const base = grid.angle(p)
      if (base === null) return null
      const offset = (noise(p.x / NOISE_SCALE, p.y / NOISE_SCALE) - 0.5) * 2 * NOISE_MAX
      return base + offset
    },
    weight: (p) => {
      const i = irr(p)
      return i > 0.4 ? 0.5 * i : 0
    },
  }
}

export function buildBasisFields(
  params: SectorParams,
  terrain: Terrain,
  _sizeM: number,
  patches: Patch[],
  extra: BasisField[] = [],
): BasisField[] {
  const grid = gridBasis(patches)
  const boundary = boundaryBasis(terrain)
  const noise = noiseBasis(params, grid)
  return [grid, boundary, noise, ...extra]
}

export function buildRoadField(
  params: SectorParams,
  terrain: Terrain,
  sizeM: number,
  extra?: BasisField[],
): RoadField {
  const patches = buildPatches(params, terrain, sizeM)
  const bases = buildBasisFields(params, terrain, sizeM, patches, extra)

  // ponytail: lazy cache fill, precompute the whole grid if profiling says so
  const cols = Math.floor(sizeM / GRID_STEP) + 1
  const filled = new Uint8Array(cols * cols)
  const vx = new Float32Array(cols * cols)
  const vy = new Float32Array(cols * cols)

  const cellVector = (ix: number, iy: number): [number, number] => {
    const idx = iy * cols + ix
    if (!filled[idx]) {
      const p = { x: ix * GRID_STEP, y: iy * GRID_STEP }
      let sx = 0
      let sy = 0
      for (const basis of bases) {
        const a = basis.angle(p)
        if (a === null) continue
        const w = basis.weight(p)
        if (w === 0) continue
        sx += w * Math.cos(2 * a)
        sy += w * Math.sin(2 * a)
      }
      vx[idx] = sx
      vy[idx] = sy
      filled[idx] = 1
    }
    return [vx[idx], vy[idx]]
  }

  const sample = (p: Pt): FieldSample => {
    const cx = clamp(0, cols - 1, p.x / GRID_STEP)
    const cy = clamp(0, cols - 1, p.y / GRID_STEP)
    const ix0 = Math.floor(cx)
    const iy0 = Math.floor(cy)
    const ix1 = Math.min(cols - 1, ix0 + 1)
    const iy1 = Math.min(cols - 1, iy0 + 1)
    const fx = cx - ix0
    const fy = cy - iy0
    const [x00, y00] = cellVector(ix0, iy0)
    const [x10, y10] = cellVector(ix1, iy0)
    const [x01, y01] = cellVector(ix0, iy1)
    const [x11, y11] = cellVector(ix1, iy1)
    const sx = (x00 * (1 - fx) + x10 * fx) * (1 - fy) + (x01 * (1 - fx) + x11 * fx) * fy
    const sy = (y00 * (1 - fx) + y10 * fx) * (1 - fy) + (y01 * (1 - fx) + y11 * fx) * fy
    const theta = sx === 0 && sy === 0 ? 0 : Math.atan2(sy, sx) / 2
    const major = { x: Math.cos(theta), y: Math.sin(theta) }
    const minor = { x: -major.y, y: major.x }
    return { major, minor }
  }

  return { sizeM, patches, sample }
}
