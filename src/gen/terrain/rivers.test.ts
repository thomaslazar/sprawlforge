import { describe, expect, it } from 'vitest'
import { METRO_SIZE, makeFieldBase, sectorWindow } from './field'
import { makeTerrainField, traceRiver } from './rivers'

const sizeM = 4000

describe('traceRiver', () => {
  it('returns null when the kind has no river', () => {
    expect(traceRiver(makeFieldBase(42, 'coastal', sizeM), 42, sizeM)).toBeNull()
  })
  it('is deterministic', () => {
    const a = traceRiver(makeFieldBase(42, 'river', sizeM), 42, sizeM)
    const b = traceRiver(makeFieldBase(42, 'river', sizeM), 42, sizeM)
    expect(a).toEqual(b)
  })
  it('river kind: course crosses the sector window and ends at the metro boundary', () => {
    for (const seed of [1, 42, 999]) {
      const base = makeFieldBase(seed, 'river', sizeM)
      const r = traceRiver(base, seed, sizeM)!
      expect(r.course.length).toBeGreaterThan(10)
      const win = sectorWindow(sizeM)
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
  it('estuary: course ends in the sea', () => {
    for (const seed of [1, 42, 999]) {
      const base = makeFieldBase(seed, 'estuary', sizeM)
      const r = traceRiver(base, seed, sizeM)!
      const end = r.course[r.course.length - 1]
      expect(base.heightRaw(end.x, end.y)).toBeLessThan(0)
    }
  })
})

describe('makeTerrainField carving', () => {
  it('carved height is water on the course, unchanged far away', () => {
    const f = makeTerrainField(42, 'river', sizeM)
    const mid = f.river!.course[Math.floor(f.river!.course.length / 2)]
    expect(f.height(mid.x, mid.y)).toBeLessThan(0)
    // far from the river the field is untouched
    const far = { x: mid.x + 5000, y: mid.y + 5000 }
    expect(f.height(far.x, far.y)).toBe(f.heightRaw(far.x, far.y))
  })
  it('kinds without river carve nothing', () => {
    const f = makeTerrainField(42, 'coastal', sizeM)
    expect(f.river).toBeNull()
    expect(f.height(16000, 16000)).toBe(f.heightRaw(16000, 16000))
  })
  it('carved height sampling is fast enough for a 128² window', () => {
    const f = makeTerrainField(42, 'river', 4000)
    const t0 = performance.now()
    for (let i = 0; i < 128 * 128; i++) f.height(14000 + (i % 128) * 30, 14000 + Math.floor(i / 128) * 30)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})
