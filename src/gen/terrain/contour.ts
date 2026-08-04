import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping'
import type { Rect } from '../geometry'

// fraction along the edge where the 0-contour sits, from height a to b.
// Clamped away from 0/1: an unclamped t can land a crossing exactly on a
// grid corner (degenerate zero-length sub-edge), which is what let a plane
// crossing a corner height of exactly 0 crash the union below.
const lerp0 = (a: number, b: number) => Math.min(0.999, Math.max(0.001, a / (a - b)))

// Round to a shared grid so two cells computing "the same" crossing from
// opposite directions (t vs 1-t, see contourWater) land on bit-identical
// coordinates — polygon-clipping's ring-matcher requires exact equality on
// shared edges, and float rounding alone was enough to break that match.
const snap = (v: number): number => Math.round(v * 1e6) / 1e6

interface Corner { x: number; y: number; h: number }
const crossing = (a: Corner, b: Corner): [number, number] => {
  const t = lerp0(a.h, b.h)
  return [snap(a.x + (b.x - a.x) * t), snap(a.y + (b.y - a.y) * t)]
}

// Deterministic epsilon shifts for the retry belt below — fixed sequence,
// not random, so a retried run is still reproducible from the same seed.
const RETRY_EPSILONS = [1e-4, -1e-4, 3e-4]

/**
 * Marching squares, cell-polygon variant: for each grid cell emit the
 * below-threshold (water) sub-polygon, merge full-water runs per row into
 * strips, union everything. Robust against open contours at the window
 * border by construction — cell polygons are always closed.
 *
 * polygon-clipping's union/difference occasionally throws "unable to
 * complete output ring" on a degenerate configuration the belts above
 * don't fully rule out (e.g. near-coincident vertices from an adjacent
 * saddle). Rather than chase every such case, retry the whole pass with the
 * sample function nudged by a tiny fixed epsilon — enough to break the
 * degeneracy — up to 3 times before giving up.
 */
export function contourWater(
  sample: (x: number, y: number) => number,
  win: Rect,
  n: number,
  attempt = 0,
): { water: MultiPolygon; land: MultiPolygon } {
  try {
    return buildContour(sample, win, n)
  } catch (err) {
    if (attempt >= RETRY_EPSILONS.length) throw err
    const eps = RETRY_EPSILONS[attempt]
    return contourWater((x, y) => sample(x, y) + eps, win, n, attempt + 1)
  }
}

function buildContour(
  sample: (x: number, y: number) => number,
  win: Rect,
  n: number,
): { water: MultiPolygon; land: MultiPolygon } {
  const dx = win.w / n
  const dy = win.h / n
  // heights at grid corners, window-local coordinates
  const h: number[][] = []
  for (let j = 0; j <= n; j++) {
    h[j] = []
    for (let i = 0; i <= n; i++) h[j][i] = sample(win.x + i * dx, win.y + j * dy)
  }

  const pieces: Polygon[] = []
  for (let j = 0; j < n; j++) {
    let runStart = -1
    const flushRun = (end: number) => {
      if (runStart < 0) return
      pieces.push([[
        [runStart * dx, j * dy], [end * dx, j * dy],
        [end * dx, (j + 1) * dy], [runStart * dx, (j + 1) * dy],
      ]])
      runStart = -1
    }
    for (let i = 0; i < n; i++) {
      const tl = h[j][i]
      const tr = h[j][i + 1]
      const br = h[j + 1][i + 1]
      const bl = h[j + 1][i]
      const wet = [tl < 0, tr < 0, br < 0, bl < 0]
      const count = wet.filter(Boolean).length
      if (count === 4) {
        if (runStart < 0) runStart = i
        continue
      }
      flushRun(i)
      if (count === 0) continue
      // partial cell: walk the square boundary, inserting contour crossings
      const x0 = i * dx
      const y0 = j * dy
      const corners: Corner[] = [
        { x: x0, y: y0, h: tl },
        { x: x0 + dx, y: y0, h: tr },
        { x: x0 + dx, y: y0 + dy, h: br },
        { x: x0, y: y0 + dy, h: bl },
      ]
      // saddle: two diagonal wet corners. The bilinear field is ambiguous
      // between one connected region and two disjoint ones — disambiguate
      // by the cell-center height (avg of the 4 corners).
      const isSaddle = (wet[0] && wet[2] && !wet[1] && !wet[3]) || (wet[1] && wet[3] && !wet[0] && !wet[2])
      if (isSaddle && (tl + tr + br + bl) / 4 >= 0) {
        for (let c = 0; c < 4; c++) {
          if (!wet[c]) continue
          const prev = corners[(c + 3) % 4]
          const cur = corners[c]
          const next = corners[(c + 1) % 4]
          pieces.push([[crossing(prev, cur), [cur.x, cur.y], crossing(cur, next)]])
        }
        continue
      }
      const ring: [number, number][] = []
      for (let c = 0; c < 4; c++) {
        const a = corners[c]
        const b = corners[(c + 1) % 4]
        if (a.h < 0) ring.push([a.x, a.y])
        if (a.h < 0 !== b.h < 0) ring.push(crossing(a, b))
      }
      if (ring.length >= 3) pieces.push([ring])
    }
    flushRun(n)
  }

  const windowPoly: Polygon = [[
    [0, 0], [win.w, 0], [win.w, win.h], [0, win.h],
  ]]
  const water: MultiPolygon = pieces.length ? polygonClipping.union(pieces[0], ...pieces.slice(1)) : []
  const land: MultiPolygon = water.length
    ? polygonClipping.difference([windowPoly], water)
    : [windowPoly]
  return { water, land }
}
