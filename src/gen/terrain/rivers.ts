import type { Pt } from '../geometry'
import { hashSeed, mulberry32 } from '../rng'
import type { TerrainKind } from '../types'
import { METRO_SIZE, makeFieldBase, sectorWindow, type TerrainFieldBase } from './field'

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
  const win = sectorWindow(sizeM) // window position is size-independent (centered)

  // start: highest of K samples on the window's far side from the water
  let start: Pt = { x: METRO_SIZE / 2, y: METRO_SIZE / 2 }
  let bestH = -Infinity
  for (let k = 0; k < 60; k++) {
    const p = { x: rng.next() * METRO_SIZE, y: rng.next() * METRO_SIZE }
    const h = base.heightRaw(p.x, p.y)
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
        const h = base.heightRaw(p.x, p.y)
        if (h < low) {
          low = h
          dest = p
        }
      }
    }
  }

  // steer through the window center so the sector actually sees the river
  const via: Pt = { x: METRO_SIZE / 2 + (rng.next() - 0.5) * win.w * 0.5,
                    y: METRO_SIZE / 2 + (rng.next() - 0.5) * win.h * 0.5 }

  const phase = rng.next() * Math.PI * 2
  const course: Pt[] = [start]
  let p = { ...start }
  let passedVia = false
  for (let s = 0; s < MAX_STEPS; s++) {
    if (base.heightRaw(p.x, p.y) < -0.05) break // reached the sea
    if (p.x < 0 || p.y < 0 || p.x > METRO_SIZE || p.y > METRO_SIZE) break
    const gx = (base.heightRaw(p.x + EPS, p.y) - base.heightRaw(p.x - EPS, p.y)) / (2 * EPS)
    const gy = (base.heightRaw(p.x, p.y + EPS) - base.heightRaw(p.x, p.y - EPS)) / (2 * EPS)
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
    // meander wobble, perpendicular to travel
    const wob = Math.sin(s * 0.45 + phase) * 0.5
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

export function makeTerrainField(
  metroSeed: number,
  kind: TerrainKind,
  sizeM: number,
): TerrainField {
  const base = makeFieldBase(metroSeed, kind, sizeM)
  const river = traceRiver(base, metroSeed, sizeM)
  const height = (x: number, y: number): number => {
    const h = base.heightRaw(x, y)
    if (!river) return h
    const { dist: d, t01 } = nearestOnPolyline({ x, y }, river.course)
    // width tapers monotonically downstream (spec §7)
    const w = river.widthStart + (river.widthEnd - river.widthStart) * t01
    if (d >= 3 * w) return h
    const t = Math.max(0, (d - w / 2) / (2.5 * w))
    const s = t * t * (3 - 2 * t)
    return Math.min(h, CHANNEL_H * (1 - s) + h * s)
  }
  return { ...base, height, river }
}
