import type { Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { Landform } from '../types'
import { METRO_SIZE, makeFieldBase, sectorWindow, type TerrainFieldBase } from './field'
import { fractalNoise2D } from './noise'

export interface River {
  course: Pt[]
  widthStart: number
  widthEnd: number
}

export interface TerrainField extends TerrainFieldBase {
  height(x: number, y: number): number
  river: River | null
}

const STEP = 300
const MAX_STEPS = 220
const EPS = 150
// meander wobble was a metronome (pure sine) — a noise-driven wobble gives
// varied bend radii instead of identical S-curves every ~14 steps (2*PI/0.45).
// 0.13 keeps roughly the same step-to-step wavelength as the old 0.45 phase
// rate (a full noise-lattice unit spans ~1/0.13 ≈ 7.7 steps); amp is bigger
// than the old sine's ±0.5 so bends read as more pronounced, not just noisier.
const MEANDER_FREQ = 0.13
const MEANDER_AMP = 0.65
// carve width along the course varies 0.6..1.6x the tapered envelope (pools
// and narrows) — riverSlice.width (bridges/renderer) stays the untouched
// envelope mean; this only affects the carved channel shape.
const WIDTH_MOD_FREQ = 6 // ~6 pool/narrow cycles over the full course

export function distToPolyline(p: Pt, line: Pt[]): number {
  return nearestOnPolyline(p, line).dist
}

/** distance to the polyline plus normalized progress (0 source → 1 mouth) */
export function nearestOnPolyline(p: Pt, line: Pt[]): { dist: number; t01: number } {
  let best = Infinity
  let bestT = 0
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const len2 = abx * abx + aby * aby || 1
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2))
    const d = Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
    if (d < best) {
      best = d
      bestT = (i + t) / (line.length - 1)
    }
  }
  return { dist: best, t01: bestT }
}

export function traceRiver(base: TerrainFieldBase, metroSeed: number, sizeM: number): River | null {
  if (!base.hasRiver) return null
  const rng = mulberry32(hashSeed(metroSeed, 'river'))
  const win = sectorWindow(sizeM, base.landform, metroSeed)

  // start: highest of K samples in the sector window's vicinity — sampling
  // the whole metro fails for small landmasses (an island is <1% of the
  // metro area, so random metro samples usually start the river in the
  // ocean and it dies instantly). The window is positioned on land by
  // construction, so its neighborhood always offers a valid source.
  const wcx = win.x + win.w / 2
  const wcy = win.y + win.h / 2
  const sampleR = Math.max(win.w, win.h) * 1.5
  let start: Pt = { x: wcx, y: wcy }
  let bestH = -Infinity
  for (let k = 0; k < 60; k++) {
    const p = {
      x: wcx + (rng.next() * 2 - 1) * sampleR,
      y: wcy + (rng.next() * 2 - 1) * sampleR,
    }
    const h = base.heightSea(p.x, p.y)
    if (h > bestH) {
      bestH = h
      start = p
    }
  }

  // destination: sea handled by descent; landlocked → lowest boundary point
  let dest: Pt | null = null
  if (!base.hasSea) {
    let low = Infinity
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * METRO_SIZE
      for (const p of [
        { x: t, y: 0 }, { x: t, y: METRO_SIZE },
        { x: 0, y: t }, { x: METRO_SIZE, y: t },
      ]) {
        const h = base.heightSea(p.x, p.y)
        if (h < low) {
          low = h
          dest = p
        }
      }
    }
  }

  // steer through the window center so the sector actually sees the river —
  // tight spread (0.25, not 0.5): a wider via was occasionally landing the
  // whole crossing near a window edge, leaving too short an in-window arc
  // to clear the smoke test's water floor (seeds 36/55 at sizeM 4000)
  // via anchors on the WINDOW center, not the metro center — since window
  // positioning (per landform/size) they are no longer the same point, and a
  // metro-centered via can steer the river outside the visible frame
  const via: Pt = { x: wcx + (rng.next() - 0.5) * win.w * 0.25,
                    y: wcy + (rng.next() - 0.5) * win.h * 0.25 }

  const phase = rng.next() * Math.PI * 2
  const meanderNoise = fractalNoise2D(hashSeed(metroSeed, 'river-meander'))
  const course: Pt[] = [start]
  let p = { ...start }
  let passedVia = false
  for (let s = 0; s < MAX_STEPS; s++) {
    // heightSea, not heightRaw: a lake dip is below sea level too — rivers
    // must flow THROUGH lakes and stop only at the actual sea
    if (base.heightSea(p.x, p.y) < -0.05) break
    if (p.x < 0 || p.y < 0 || p.x > METRO_SIZE || p.y > METRO_SIZE) break
    const gx = (base.heightSea(p.x + EPS, p.y) - base.heightSea(p.x - EPS, p.y)) / (2 * EPS)
    const gy = (base.heightSea(p.x, p.y + EPS) - base.heightSea(p.x, p.y - EPS)) / (2 * EPS)
    const gLen = Math.hypot(gx, gy) || 1
    const down = { x: -gx / gLen, y: -gy / gLen }
    if (!passedVia && Math.hypot(p.x - via.x, p.y - via.y) < STEP * 2) passedVia = true
    const target = passedVia ? dest : via
    let dir = down
    if (target) {
      const td = Math.hypot(target.x - p.x, target.y - p.y) || 1
      const toT = { x: (target.x - p.x) / td, y: (target.y - p.y) / td }
      dir = { x: 0.45 * down.x + 0.55 * toT.x, y: 0.45 * down.y + 0.55 * toT.y }
    }
    // meander wobble, perpendicular to travel — noise-driven, not a metronome
    const wob = (meanderNoise(s * MEANDER_FREQ, phase) - 0.5) * 2 * MEANDER_AMP
    const perp = { x: -dir.y, y: dir.x }
    const dl = Math.hypot(dir.x, dir.y) || 1
    p = {
      x: p.x + (dir.x / dl + perp.x * wob) * STEP,
      y: p.y + (dir.y / dl + perp.y * wob) * STEP,
    }
    course.push({ ...p })
  }

  // one Chaikin smoothing pass
  const smooth: Pt[] = [course[0]]
  for (let i = 0; i < course.length - 1; i++) {
    const a = course[i]
    const b = course[i + 1]
    smooth.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
    smooth.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
  }
  smooth.push(course[course.length - 1])

  return { course: smooth, widthStart: 30, widthEnd: 90 }
}

const CHANNEL_H = -0.15

/**
 * Carve-width factor, bounded [0.6, 1.6) and deterministic per (noise, t01)
 * — pools and narrows along the course. `noise` is the caller's precomputed
 * fractalNoise2D instance (never construct one per call: makeTerrainField's
 * height() runs per grid sample, and building a fresh noise field there
 * would blow the sampling-speed budget — see rivers.test.ts).
 */
export function widthMultiplier(noise: (x: number, y: number) => number, t01: number): number {
  return 0.6 + noise(t01 * WIDTH_MOD_FREQ, 0) // noise is bounded [0,1) → [0.6, 1.6)
}

export function makeTerrainField(
  metroSeed: number,
  landform: Landform,
  water: { river: boolean; lakes: boolean },
  sizeM: number,
): TerrainField {
  const base = makeFieldBase(metroSeed, landform, water)
  const river = traceRiver(base, metroSeed, sizeM)
  const widthNoise = river ? fractalNoise2D(hashSeed(metroSeed, 'river-width')) : null
  const height = (x: number, y: number): number => {
    const h = base.heightRaw(x, y)
    if (!river) return h
    const { dist: d, t01 } = nearestOnPolyline({ x, y }, river.course)
    // width tapers monotonically downstream (spec §7), modulated by
    // pools/narrows on top — the taper envelope stays monotone, the
    // modulation rides on it
    const w = (river.widthStart + (river.widthEnd - river.widthStart) * t01) * widthMultiplier(widthNoise!, t01)
    if (d >= 3 * w) return h
    const t = Math.max(0, (d - w / 2) / (2.5 * w))
    const s = t * t * (3 - 2 * t)
    return Math.min(h, CHANNEL_H * (1 - s) + h * s)
  }
  return { ...base, height, river }
}
