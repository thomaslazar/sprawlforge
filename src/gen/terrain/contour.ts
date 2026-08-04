import polygonClipping, { type MultiPolygon, type Polygon } from 'polygon-clipping'
import type { Rect } from '../geometry'

// fraction along the edge where the 0-contour sits, from height a to b
const lerp0 = (a: number, b: number) => a / (a - b)

interface Corner { x: number; y: number; h: number }
const crossing = (a: Corner, b: Corner): [number, number] => {
  const t = lerp0(a.h, b.h)
  return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t]
}

/**
 * Marching squares, cell-polygon variant: for each grid cell emit the
 * below-threshold (water) sub-polygon, merge full-water runs per row into
 * strips, union everything. Robust against open contours at the window
 * border by construction — cell polygons are always closed.
 */
export function contourWater(
  sample: (x: number, y: number) => number,
  window: Rect,
  n: number,
): { water: MultiPolygon; land: MultiPolygon } {
  const dx = window.w / n
  const dy = window.h / n
  // heights at grid corners, window-local coordinates
  const h: number[][] = []
  for (let j = 0; j <= n; j++) {
    h[j] = []
    for (let i = 0; i <= n; i++) h[j][i] = sample(window.x + i * dx, window.y + j * dy)
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
        if (a.h < 0 !== b.h < 0) {
          const t = lerp0(a.h, b.h)
          ring.push([a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t])
        }
      }
      if (ring.length >= 3) pieces.push([ring])
    }
    flushRun(n)
  }

  const windowPoly: Polygon = [[
    [0, 0], [window.w, 0], [window.w, window.h], [0, window.h],
  ]]
  const water: MultiPolygon = pieces.length ? polygonClipping.union(pieces[0], ...pieces.slice(1)) : []
  const land: MultiPolygon = water.length
    ? polygonClipping.difference([windowPoly], water)
    : [windowPoly]
  return { water, land }
}
