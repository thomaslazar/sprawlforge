import type { Rect } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { Landform } from '../types'
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
 * or all-land at small sizeM (C3, spec §2 restoration). coastal pushes the
 * window along `dir` toward the waterline; bay toward its pocket; island
 * pushes toward its rim. This only moves the window's POSITION — heightRaw
 * stays a pure function of (x, y, metroSeed, landform) either way (see
 * field.test.ts "field is window-independent"). Water modifiers (river,
 * lakes) never move the window.
 */
export function sectorWindow(sizeM: number, landform: Landform, metroSeed: number): Rect {
  const cx = METRO_SIZE / 2
  const cy = METRO_SIZE / 2
  const dir = seedDir(metroSeed)
  // signed offset of the window center from the metro center, along `dir`
  let along = 0
  switch (landform) {
    case 'coastal': {
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
  landform: Landform
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

// Lakes modifier (I6): subtract a seeded radial dip from whichever
// landform's gradient is already in play, so a basin always exists
// regardless of landform. Depth must beat the baseline *and* the
// worst-case noise excursion (amp/2) even right at the dip center, with
// enough margin that the resulting wet radius clears the smoke test's 1%
// floor — see smoke.test.ts. Positioned near the metro center (± spread),
// same as v2's standalone 'lakes' kind — inland's window is always
// centered there, so the dip is guaranteed visible for inland+lakes; for
// other landforms the dip may land outside a pushed window, which is fine
// since those landforms already guarantee their own water.
const LAKE_DIP_RADIUS = 600
const LAKE_DIP_DEPTH = 1.3
const LAKE_DIP_SPREAD = 400 // dip center stays within this of the metro center

export function makeFieldBase(
  metroSeed: number,
  landform: Landform,
  water: { river: boolean; lakes: boolean },
): TerrainFieldBase {
  const noise = fractalNoise2D(hashSeed(metroSeed, 'height'))
  const cx = METRO_SIZE / 2
  const cy = METRO_SIZE / 2
  const dir = seedDir(metroSeed)

  let gradient: (x: number, y: number) => number
  let amp = NOISE_AMP
  const scale = NOISE_SCALE
  switch (landform) {
    case 'inland':
      gradient = () => 0.5
      amp = 0.45 // dips can't reach 0.5-0.45/2 → never water
      break
    case 'coastal': {
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
  }

  if (water.lakes) {
    const landGradient = gradient
    const lrng = mulberry32(hashSeed(metroSeed, 'lake-basin'))
    const langle = lrng.next() * Math.PI * 2
    const lr = lrng.next() * LAKE_DIP_SPREAD
    const dc = { x: cx + Math.cos(langle) * lr, y: cy + Math.sin(langle) * lr }
    gradient = (x, y) => {
      const d = Math.hypot(x - dc.x, y - dc.y)
      const t = Math.max(0, 1 - d / LAKE_DIP_RADIUS)
      const s = t * t * (3 - 2 * t) // smooth falloff, no basin-edge crease
      return landGradient(x, y) - LAKE_DIP_DEPTH * s
    }
  }

  return {
    landform,
    hasSea: landform !== 'inland',
    hasRiver: water.river,
    heightRaw: (x, y) => gradient(x, y) + amp * (noise(x / scale, y / scale) - 0.5),
  }
}
