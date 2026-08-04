import type { Rect } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { TerrainKind } from '../types'
import { fractalNoise2D } from './noise'

export const METRO_SIZE = 32000

// seed-stable unit direction for one-sided features (coast side, bay side)
// — and, since C3, for where the sector window itself gets pushed so the
// waterline lands in frame. Shared by makeFieldBase and sectorWindow so
// both agree on the same side without depending on each other's internals.
function seedDir(metroSeed: number): { x: number; y: number } {
  const theta = mulberry32(hashSeed(metroSeed, 'field')).next() * Math.PI * 2
  return { x: Math.cos(theta), y: Math.sin(theta) }
}

/**
 * The sector window into the metro-scale field: always sizeM×sizeM,
 * centered on the metro except where centering would leave the window dry
 * or all-land at small sizeM (C3, spec §2 restoration). coastal/estuary/bay
 * push the window along `dir` toward their feature; island pushes toward
 * its rim. This only moves the window's POSITION — heightRaw stays a pure
 * function of (x, y, metroSeed, kind) either way (see field.test.ts
 * "field is window-independent").
 */
export function sectorWindow(sizeM: number, kind: TerrainKind, metroSeed: number): Rect {
  const cx = METRO_SIZE / 2
  const cy = METRO_SIZE / 2
  const dir = seedDir(metroSeed)
  // signed offset of the window center from the metro center, along `dir`
  let along = 0
  switch (kind) {
    case 'coastal':
    case 'estuary': {
      // A fixed target *fraction* of window area beyond the coastline
      // isn't enough: for a near-axis-aligned dir, that area can sit right
      // at the shallow edge of the gradient (barely past zero), and the
      // height noise on top (±NOISE_AMP/2) erases it before any water
      // actually contours out — the seed-8-at-sizeM-2000 dry failure.
      // Instead push until the window's farthest reachable point along dir
      // (the far corner, `reach` below — the square's support function)
      // clears the coastline by COAST_DEPTH_MARGIN of guaranteed gradient
      // depth, comfortably past what noise alone can undo.
      const reach = (sizeM / 2) * (Math.abs(dir.x) + Math.abs(dir.y))
      along = COAST_ANCHOR - reach + COAST_DEPTH_MARGIN
      break
    }
    case 'bay':
      // no-op until the window is small enough that a centered view would
      // miss the pocket's near rim (BAY_CENTER_OFFSET - BAY_RADIUS) entirely
      along = Math.max(0, BAY_CENTER_OFFSET - BAY_RADIUS - sizeM * 0.3)
      break
    case 'island':
      // island radius is metro-fixed; a small window centered on the
      // island is all-land. Push toward the rim until the shoreline
      // crosses the frame.
      along = Math.max(0, ISLAND_RADIUS - sizeM * 0.3)
      break
    default:
      along = 0
  }
  return {
    x: cx + dir.x * along - sizeM / 2,
    y: cy + dir.y * along - sizeM / 2,
    w: sizeM,
    h: sizeM,
  }
}

export interface TerrainFieldBase {
  heightRaw(x: number, y: number): number
  kind: TerrainKind
  hasSea: boolean
  hasRiver: boolean
}

// calibration constants — tune together with the field tests, never silently
const NOISE_SCALE = 6000 // m per noise lattice unit
const NOISE_AMP = 0.55

// Gradient anchors are fixed metro-scale distances, not sizeM-derived, so
// heightRaw(x, y) depends only on the metro seed and kind — never on which
// sector window a caller happens to be viewing (see field.test.ts
// "field is window-independent"). Values are `factor * win.w` evaluated at
// the reference sector size 4000m (the brief's default sizeM), frozen as
// constants instead of read from `win.w` at call time.
const COAST_ANCHOR = 1200 // 0.3 * 4000
const BAY_CENTER_OFFSET = 2200 // 0.55 * 4000
const BAY_RADIUS = 1800 // 0.45 * 4000
const ISLAND_RADIUS = 1520 // 0.38 * 4000
// guaranteed gradient depth (raw numerator, /4000 below) at the coastal
// window's farthest corner — 1600/4000 = 0.4, safely past NOISE_AMP/2
// (0.275) so noise alone can never dry the whole window out
const COAST_DEPTH_MARGIN = 1600

// Lakes reuse the shared height noise but at a finer lattice frequency: at
// NOISE_SCALE (6000m/unit) the sector window sits inside ~1 lattice cell, so
// the whole window shares one broad, seed-biased offset (some seeds land on
// a locally-high cell, others locally-low) — no amp/gradient constant can
// carve small pockets out of that per-seed bias. At 1200m/unit several
// lattice cells span the window, giving multiple independent local minima
// per seed, so a small consistent water fraction (found by sweeping
// gradient/scale against seeds 1, 42, 999) survives across seeds.
const LAKE_NOISE_SCALE = 1200
const LAKE_GRADIENT = 0.15
const LAKE_AMP = 0.75
// Guaranteed basin (I6): the broad gradient above still leaves ~7% of seeds
// with no pool at all (noise never dips the local cell below 0). Subtract
// one seeded radial dip so a basin always exists. Depth must beat the
// baseline *and* the worst-case noise excursion (LAKE_AMP/2) even right at
// the dip center, with enough margin that the resulting wet radius clears
// the smoke test's 1% floor — see smoke.test.ts.
const LAKE_DIP_RADIUS = 600
const LAKE_DIP_DEPTH = 1.3
const LAKE_DIP_SPREAD = 400 // dip center stays within this of the metro center

export function makeFieldBase(metroSeed: number, kind: TerrainKind): TerrainFieldBase {
  const noise = fractalNoise2D(hashSeed(metroSeed, 'height'))
  const cx = METRO_SIZE / 2
  const cy = METRO_SIZE / 2
  const dir = seedDir(metroSeed)

  let gradient: (x: number, y: number) => number
  let amp = NOISE_AMP
  let scale = NOISE_SCALE
  switch (kind) {
    case 'inland':
    case 'river':
      gradient = () => 0.5
      amp = 0.45 // dips can't reach 0.5-0.45/2 → never water
      break
    case 'coastal':
    case 'estuary': {
      // waterline ~70% toward one side of the window
      gradient = (x, y) => -((x - cx) * dir.x + (y - cy) * dir.y - COAST_ANCHOR) / 4000
      break
    }
    case 'bay': {
      const c = { x: cx + dir.x * BAY_CENTER_OFFSET, y: cy + dir.y * BAY_CENTER_OFFSET }
      gradient = (x, y) => (Math.hypot(x - c.x, y - c.y) - BAY_RADIUS) / 2500
      amp = 0.35
      break
    }
    case 'island': {
      gradient = (x, y) => (ISLAND_RADIUS - Math.hypot(x - cx, y - cy)) / 3000
      amp = 0.35
      break
    }
    case 'lakes': {
      const lrng = mulberry32(hashSeed(metroSeed, 'lake-basin'))
      const langle = lrng.next() * Math.PI * 2
      const lr = lrng.next() * LAKE_DIP_SPREAD
      const dc = { x: cx + Math.cos(langle) * lr, y: cy + Math.sin(langle) * lr }
      gradient = (x, y) => {
        const d = Math.hypot(x - dc.x, y - dc.y)
        const t = Math.max(0, 1 - d / LAKE_DIP_RADIUS)
        const s = t * t * (3 - 2 * t) // smooth falloff, no basin-edge crease
        return LAKE_GRADIENT - LAKE_DIP_DEPTH * s
      }
      amp = LAKE_AMP
      scale = LAKE_NOISE_SCALE
      break
    }
  }

  return {
    kind,
    hasSea: kind === 'coastal' || kind === 'estuary' || kind === 'bay' || kind === 'island',
    hasRiver: kind === 'river' || kind === 'estuary',
    heightRaw: (x, y) => gradient(x, y) + amp * (noise(x / scale, y / scale) - 0.5),
  }
}
