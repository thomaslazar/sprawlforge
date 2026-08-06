import { describe, expect, it } from 'vitest'
import { METRO_SIZE, makeFieldBase, sectorWindow } from './field'
import { fractalNoise2D } from './noise'
import { makeTerrainField, traceRiver, widthMultiplier } from './rivers'

const sizeM = 4000
const DRY = { river: false, lakes: false, islands: false }
const RIVER = { river: true, lakes: false, islands: false }

describe('traceRiver', () => {
  it('returns null when there is no river modifier', () => {
    expect(traceRiver(makeFieldBase(42, 'coastal', DRY), 42, sizeM)).toBeNull()
  })
  it('is deterministic', () => {
    const a = traceRiver(makeFieldBase(42, 'inland', RIVER), 42, sizeM)
    const b = traceRiver(makeFieldBase(42, 'inland', RIVER), 42, sizeM)
    expect(a).toEqual(b)
  })
  it('inland + river: course crosses the sector window and ends at the metro boundary', () => {
    for (const seed of [1, 42, 999]) {
      const base = makeFieldBase(seed, 'inland', RIVER)
      const r = traceRiver(base, seed, sizeM)!
      expect(r.course.length).toBeGreaterThan(10)
      const win = sectorWindow(sizeM, 'inland', seed)
      const inWindow = r.course.some(
        (p) => p.x >= win.x && p.x <= win.x + win.w && p.y >= win.y && p.y <= win.y + win.h,
      )
      expect(inWindow).toBe(true)
      const end = r.course[r.course.length - 1]
      const margin = 400
      const atBoundary =
        end.x < margin || end.y < margin ||
        end.x > METRO_SIZE - margin || end.y > METRO_SIZE - margin
      expect(atBoundary).toBe(true)
    }
  })
  it('coastal + river: course ends in the sea (the estuary case)', () => {
    for (const seed of [1, 42, 999]) {
      const base = makeFieldBase(seed, 'coastal', RIVER)
      const r = traceRiver(base, seed, sizeM)!
      const end = r.course[r.course.length - 1]
      expect(base.heightRaw(end.x, end.y)).toBeLessThan(0)
    }
  })
})

describe('widthMultiplier', () => {
  it('is deterministic and bounded 0.6..1.6', () => {
    const noise = fractalNoise2D(42, 5)
    for (let i = 0; i <= 50; i++) {
      const t01 = i / 50
      const m = widthMultiplier(noise, t01)
      expect(m).toBeGreaterThanOrEqual(0.6)
      expect(m).toBeLessThan(1.6)
      expect(m).toBe(widthMultiplier(noise, t01))
    }
  })
})

describe('makeTerrainField carving', () => {
  it('carved height is water on the course, unchanged far away', () => {
    const f = makeTerrainField(42, 'inland', RIVER, sizeM)
    const mid = f.river!.course[Math.floor(f.river!.course.length / 2)]
    expect(f.height(mid.x, mid.y)).toBeLessThan(0)
    // far from the river the field is untouched
    const far = { x: mid.x + 5000, y: mid.y + 5000 }
    expect(f.height(far.x, far.y)).toBe(f.heightRaw(far.x, far.y))
  })
  it('no river modifier carves nothing', () => {
    const f = makeTerrainField(42, 'coastal', DRY, sizeM)
    expect(f.river).toBeNull()
    expect(f.height(16000, 16000)).toBe(f.heightRaw(16000, 16000))
  })
  it('carved height sampling is fast enough for a 128² window', () => {
    const f = makeTerrainField(42, 'inland', RIVER, 4000)
    const t0 = performance.now()
    for (let i = 0; i < 128 * 128; i++) f.height(14000 + (i % 128) * 30, 14000 + Math.floor(i / 128) * 30)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})
