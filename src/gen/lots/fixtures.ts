import { expect } from 'vitest'
// test helpers for the lot pass (not production code)
import type { Pt } from '../geometry'
import type { Terrain } from '../types'
import { distToPolyline } from '../terrain/rivers'

export const rectPoly = (x: number, y: number, w: number, h: number): Pt[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
]

export const dryTerrain: Terrain = {
  landform: 'inland', river: false, lakes: false, islands: false, metroSeed: 0,
  water: [],
  land: [[[[0, 0], [4000, 0], [4000, 4000], [0, 4000]]]],
  riverSlice: null,
}

export const circleRing = (c: Pt, r: number, n: number): Pt[] =>
  Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }))

export const distToRing = (p: Pt, ring: Pt[]): number => distToPolyline(p, [...ring, ring[0]])

export const expectBox = (ring: Pt[], box: { x0: number; y0: number; x1: number; y1: number }, tol: number): void => {
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y)
  expect(Math.abs(Math.min(...xs) - box.x0)).toBeLessThanOrEqual(tol)
  expect(Math.abs(Math.min(...ys) - box.y0)).toBeLessThanOrEqual(tol)
  expect(Math.abs(Math.max(...xs) - box.x1)).toBeLessThanOrEqual(tol)
  expect(Math.abs(Math.max(...ys) - box.y1)).toBeLessThanOrEqual(tol)
}
