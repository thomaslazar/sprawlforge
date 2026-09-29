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

const SHORE_CELL = 100

interface ShoreGrid { ax: number[]; ay: number[]; bx: number[]; by: number[]; cells: Map<number, number[]> }
const shoreGridCache = new WeakMap<Terrain, ShoreGrid>()
const cellKey = (ix: number, iy: number) => ix * 100003 + iy

/** every shore segment, in shoreLines order, bucketed into SHORE_CELL squares by bbox */
function shoreGrid(terrain: Terrain): ShoreGrid {
  const cached = shoreGridCache.get(terrain)
  if (cached) return cached
  const g: ShoreGrid = { ax: [], ay: [], bx: [], by: [], cells: new Map() }
  for (const line of shoreLines(terrain)) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]
      const b = line[i + 1]
      const k = g.ax.length
      g.ax.push(a.x); g.ay.push(a.y); g.bx.push(b.x); g.by.push(b.y)
      const x0 = Math.floor(Math.min(a.x, b.x) / SHORE_CELL), x1 = Math.floor(Math.max(a.x, b.x) / SHORE_CELL)
      const y0 = Math.floor(Math.min(a.y, b.y) / SHORE_CELL), y1 = Math.floor(Math.max(a.y, b.y) / SHORE_CELL)
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          const key = cellKey(ix, iy)
          const cell = g.cells.get(key)
          if (cell) cell.push(k)
          else g.cells.set(key, [k])
        }
      }
    }
  }
  shoreGridCache.set(terrain, g)
  return g
}

/**
 * nearest edge across all water rings/river course: its direction and distance.
 * With `maxDist`, returns null when nothing lies within it (callers that only
 * care about near shore) and searches only the surrounding grid cells; ties
 * resolve to the earliest segment, same as the unbounded linear scan.
 */
export function shoreTangent(terrain: Terrain, p: Pt, maxDist?: number): { angle: number; dist: number } | null {
  if (maxDist !== undefined) return shoreTangentNear(terrain, p, maxDist)
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

function shoreTangentNear(terrain: Terrain, p: Pt, maxDist: number): { angle: number; dist: number } | null {
  const g = shoreGrid(terrain)
  const cx = Math.floor(p.x / SHORE_CELL)
  const cy = Math.floor(p.y / SHORE_CELL)
  const maxR = Math.ceil(maxDist / SHORE_CELL)
  let bestD = Infinity
  let bestK = -1
  const visit = (ix: number, iy: number) => {
    const cell = g.cells.get(cellKey(ix, iy))
    if (!cell) return
    for (const k of cell) {
      const abx = g.bx[k] - g.ax[k]
      const aby = g.by[k] - g.ay[k]
      const len2 = abx * abx + aby * aby || 1
      const t = clamp(0, 1, ((p.x - g.ax[k]) * abx + (p.y - g.ay[k]) * aby) / len2)
      const d = Math.hypot(p.x - (g.ax[k] + t * abx), p.y - (g.ay[k] + t * aby))
      if (d < bestD || (d === bestD && k < bestK)) { bestD = d; bestK = k }
    }
  }
  // after ring r, every segment within r * SHORE_CELL of p has been seen
  for (let r = 0; r <= maxR; r++) {
    if (r === 0) visit(cx, cy)
    else {
      for (let i = -r; i <= r; i++) { visit(cx + i, cy - r); visit(cx + i, cy + r) }
      for (let i = -r + 1; i < r; i++) { visit(cx - r, cy + i); visit(cx + r, cy + i) }
    }
    if (bestD <= r * SHORE_CELL) break
  }
  if (bestK < 0 || bestD > maxDist) return null
  return { angle: Math.atan2(g.by[bestK] - g.ay[bestK], g.bx[bestK] - g.ax[bestK]), dist: bestD }
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
      const tangent = shoreTangent(terrain, center, SHORE_DIST)
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

const PATCH_CELL = 300
const patchKey = (ix: number, iy: number) => ix * 100003 + iy

function patchGrid(patches: Patch[]): Map<number, number[]> {
  const grid = new Map<number, number[]>()
  patches.forEach((patch, k) => {
    const key = patchKey(Math.floor(patch.center.x / PATCH_CELL), Math.floor(patch.center.y / PATCH_CELL))
    const cell = grid.get(key)
    if (cell) cell.push(k)
    else grid.set(key, [k])
  })
  return grid
}

/**
 * The two nearest patches to p, ordered by (distance, index) — the same pair a
 * linear scan in index order with strict `<` picks — found by ring search
 * over the patch grid (after ring r every patch within r * PATCH_CELL is seen).
 */
function nearestTwo(patches: Patch[], grid: Map<number, number[]>, p: Pt): [Patch | null, Patch | null, number, number] {
  let i1 = -1, i2 = -1
  let d1 = Infinity, d2 = Infinity
  const cx = Math.floor(p.x / PATCH_CELL)
  const cy = Math.floor(p.y / PATCH_CELL)
  const visit = (ix: number, iy: number) => {
    const cell = grid.get(patchKey(ix, iy))
    if (!cell) return
    for (const k of cell) {
      const c = patches[k].center
      const d = Math.hypot(p.x - c.x, p.y - c.y)
      if (d < d1 || (d === d1 && k < i1)) { i2 = i1; d2 = d1; i1 = k; d1 = d }
      else if (d < d2 || (d === d2 && k < i2)) { i2 = k; d2 = d }
    }
  }
  // patches.length bounds the search: past that many rings every cell was visited
  for (let r = 0; r <= patches.length + 2; r++) {
    if (r === 0) visit(cx, cy)
    else {
      for (let i = -r; i <= r; i++) { visit(cx + i, cy - r); visit(cx + i, cy + r) }
      for (let i = -r + 1; i < r; i++) { visit(cx - r, cy + i); visit(cx + r, cy + i) }
    }
    if (d2 <= r * PATCH_CELL) break
  }
  return [i1 >= 0 ? patches[i1] : null, i2 >= 0 ? patches[i2] : null, d1, d2]
}

/** grid basis: blend of nearest + second-nearest patch, doubled-angle, smooth across the Voronoi seam */
function gridBasis(patches: Patch[]): BasisField {
  const grid = patchGrid(patches)
  return {
    name: 'grid',
    angle(p) {
      const [first, second, d1, d2] = nearestTwo(patches, grid, p)
      if (!first) return null
      if (!second) return first!.angle
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
      lastTangent = shoreTangent(terrain, p, BOUNDARY_REACH)
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

  /** fills the cell's vector on first use and returns its index into vx/vy */
  const cellVector = (ix: number, iy: number): number => {
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
    return idx
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
    const i00 = cellVector(ix0, iy0), i10 = cellVector(ix1, iy0)
    const i01 = cellVector(ix0, iy1), i11 = cellVector(ix1, iy1)
    const x00 = vx[i00], y00 = vy[i00], x10 = vx[i10], y10 = vy[i10]
    const x01 = vx[i01], y01 = vy[i01], x11 = vx[i11], y11 = vy[i11]
    const sx = (x00 * (1 - fx) + x10 * fx) * (1 - fy) + (x01 * (1 - fx) + x11 * fx) * fy
    const sy = (y00 * (1 - fx) + y10 * fx) * (1 - fy) + (y01 * (1 - fx) + y11 * fx) * fy
    const theta = sx === 0 && sy === 0 ? 0 : Math.atan2(sy, sx) / 2
    const major = { x: Math.cos(theta), y: Math.sin(theta) }
    const minor = { x: -major.y, y: major.x }
    return { major, minor }
  }

  return { sizeM, patches, sample }
}
