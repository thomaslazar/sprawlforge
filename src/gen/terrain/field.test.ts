import { describe, expect, it } from 'vitest'
import { METRO_SIZE, makeFieldBase, sectorWindow } from './field'

const sizeM = 4000
const win = sectorWindow(sizeM)
const grid = (h: (x: number, y: number) => number, n = 32) => {
  const vals: number[] = []
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++)
      vals.push(h(win.x + (i / n) * win.w, win.y + (j / n) * win.h))
  return vals
}
const waterFrac = (vals: number[]) => vals.filter((v) => v < 0).length / vals.length

describe('makeFieldBase', () => {
  it('is deterministic', () => {
    const a = makeFieldBase(42, 'coastal', sizeM)
    const b = makeFieldBase(42, 'coastal', sizeM)
    expect(a.heightRaw(15000, 17000)).toBe(b.heightRaw(15000, 17000))
  })
  it('window is centered in the metro', () => {
    expect(win.x + win.w / 2).toBe(METRO_SIZE / 2)
  })
  it('field is window-independent: same metro point, same height', () => {
    const f = makeFieldBase(42, 'coastal', 4000)
    const g = makeFieldBase(42, 'coastal', 2000)
    expect(f.heightRaw(15500, 16500)).toBe(g.heightRaw(15500, 16500))
  })
  it('inland: window is all land, no sea, no river', () => {
    const f = makeFieldBase(42, 'inland', sizeM)
    expect(waterFrac(grid(f.heightRaw))).toBe(0)
    expect(f.hasSea).toBe(false)
    expect(f.hasRiver).toBe(false)
  })
  it('river kind: dry window before carving, river flagged', () => {
    const f = makeFieldBase(42, 'river', sizeM)
    expect(waterFrac(grid(f.heightRaw))).toBe(0)
    expect(f.hasRiver).toBe(true)
    expect(f.hasSea).toBe(false)
  })
  it('coastal: window has both land and sea', () => {
    for (const seed of [1, 42, 999]) {
      const f = makeFieldBase(seed, 'coastal', sizeM)
      const frac = waterFrac(grid(f.heightRaw))
      expect(frac).toBeGreaterThan(0.1)
      expect(frac).toBeLessThan(0.6)
      expect(f.hasSea).toBe(true)
    }
  })
  it('bay: water pocket, mostly land', () => {
    for (const seed of [1, 42, 999]) {
      const frac = waterFrac(grid(makeFieldBase(seed, 'bay', sizeM).heightRaw))
      expect(frac).toBeGreaterThan(0.05)
      expect(frac).toBeLessThan(0.5)
    }
  })
  it('island: land inside, water at the window corners', () => {
    for (const seed of [1, 42, 999]) {
      const f = makeFieldBase(seed, 'island', sizeM)
      expect(f.heightRaw(METRO_SIZE / 2, METRO_SIZE / 2)).toBeGreaterThan(0)
      expect(f.heightRaw(win.x, win.y)).toBeLessThan(0)
      expect(f.heightRaw(win.x + win.w, win.y + win.h)).toBeLessThan(0)
    }
  })
  it('lakes: some water, far less than coastal, no sea', () => {
    for (const seed of [1, 42, 999]) {
      const f = makeFieldBase(seed, 'lakes', sizeM)
      const frac = waterFrac(grid(f.heightRaw, 64))
      expect(frac).toBeGreaterThan(0.01)
      expect(frac).toBeLessThan(0.3)
      expect(f.hasSea).toBe(false)
    }
  })
  it('estuary: sea and river both flagged', () => {
    const f = makeFieldBase(42, 'estuary', sizeM)
    expect(f.hasSea).toBe(true)
    expect(f.hasRiver).toBe(true)
  })
})
