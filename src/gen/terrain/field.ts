import type { Rect } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { TerrainKind } from '../types'
import { fractalNoise2D } from './noise'

export const METRO_SIZE = 32000

export function sectorWindow(sizeM: number): Rect {
  const off = (METRO_SIZE - sizeM) / 2
  return { x: off, y: off, w: sizeM, h: sizeM }
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

export function makeFieldBase(
  metroSeed: number,
  kind: TerrainKind,
  sizeM: number,
): TerrainFieldBase {
  // sizeM is part of the signature for later tasks (Task 4+ carve/contour a
  // specific window) but gradient anchoring below is metro-scale and fixed,
  // so heightRaw is independent of which window is being viewed — see
  // "field is window-independent" in field.test.ts.
  void sizeM
  const rng = mulberry32(hashSeed(metroSeed, 'field'))
  const noise = fractalNoise2D(hashSeed(metroSeed, 'height'))
  const cx = METRO_SIZE / 2
  const cy = METRO_SIZE / 2

  // seed-stable direction for one-sided features (coast side, bay side)
  const theta = rng.next() * Math.PI * 2
  const dir = { x: Math.cos(theta), y: Math.sin(theta) }

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
    case 'lakes':
      gradient = () => LAKE_GRADIENT
      amp = LAKE_AMP
      scale = LAKE_NOISE_SCALE
      break
  }

  return {
    kind,
    hasSea: kind === 'coastal' || kind === 'estuary' || kind === 'bay' || kind === 'island',
    hasRiver: kind === 'river' || kind === 'estuary',
    heightRaw: (x, y) => gradient(x, y) + amp * (noise(x / scale, y / scale) - 0.5),
  }
}
