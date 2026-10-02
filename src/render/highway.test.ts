import { describe, expect, it } from 'vitest'
import type { HighwayCrossing, HighwaySegment, Road, SectorModel } from '../gen/types'
import { GENERATOR_VERSION } from '../gen/types'
import { renderHighway } from './highway'
import { getTheme } from './theme'

const theme = getTheme('neon')
const seg = (from: number, to: number, level: HighwaySegment['level'], transition: boolean): HighwaySegment =>
  ({ from, to, level, districtId: 'D01', transition })
const segments = [seg(0, 0.4, 'sunken', false), seg(0.4, 0.7, 'ground', true), seg(0.7, 1, 'elevated', true)]
const crossings: HighwayCrossing[] = [
  { roadId: 'A001', at: 0.2, kind: 'over', interchange: false },
  { roadId: 'S001', at: 0.85, kind: 'under', interchange: false },
]
const road = (id: string, cls: Road['class'], pts: Array<[number, number]>, extra: Partial<Road> = {}): Road => ({
  id, class: cls, points: pts.map(([x, y]) => ({ x, y })), width: 12, name: id, bridge: false, ...extra,
})
const model = (roads: Road[]): SectorModel => ({
  meta: { seed: 1, generatorVersion: GENERATOR_VERSION, params: {} as never, sizeM: 4000, metroSeed: 1 },
  terrain: { landform: 'inland', river: false, lakes: false, islands: false, metroSeed: 1, water: [], land: [], riverSlice: null },
  roads, districts: [], blocks: [], buildings: [], pois: [], piers: [], arcologies: [], megablocks: [],
})
const hw = [
  road('H1-1', 'highway', [[2000, 0], [2000, 1500]], { width: 32, segments, crossings }),
  road('H1-b1', 'highway', [[2000, 1500], [2000, 2000]], { width: 32, bridge: true, segments, crossings }),
  road('H1-2', 'highway', [[2000, 2000], [2000, 4000]], { width: 32, segments, crossings }),
]

describe('renderHighway', () => {
  const out: string[] = []
  renderHighway(model([
    ...hw,
    road('A001-1', 'arterial', [[1000, 800], [1990, 800]]),
    road('A001-2', 'arterial', [[1990, 800], [3000, 800]]),
    road('S001', 'street', [[1000, 3400], [3000, 3400]]),
  ]), theme, out)
  const svg = out.join('')

  it('emits level groups in order with trench, shoulders, columns, decks, hatch', () => {
    expect([...svg.matchAll(/data-level="(\w+)"/g)].map((m) => m[1])).toEqual(['sunken', 'ground', 'elevated'])
    expect(svg).toContain(`stroke="${theme.highway.trench}" stroke-width="1.5"`)
    expect(svg).toContain(`stroke="${theme.highway.trench}" stroke-width="1"`)
    const col = svg.match(new RegExp(`<path d="([^"]*)" fill="none" stroke="${theme.highway.column}"`))!
    const xs = [...col[1].matchAll(/[ML]([\d.-]+),/g)].map((m) => Number(m[1]))
    expect(xs.some((x) => x > 2016)).toBe(true)
    expect(xs.some((x) => x < 1984)).toBe(true)
    expect(svg.match(/opacity="0.6"/g)!.length).toBe(2)
  })
  it('places over deck near y=800 and dashed under near y=3400', () => {
    const deck = svg.match(new RegExp(`<polyline points="([^"]*)" fill="none" stroke="${theme.bridge.deck}"`))!
    const ys = deck[1].split(' ').map((p) => Number(p.split(',')[1]))
    expect(ys.every((y) => Math.abs(y - 800) < 5)).toBe(true)
    const dash = svg.match(/<polyline points="([^"]*)"[^>]*stroke-dasharray="4 4"/)!
    expect(dash[1].split(' ').every((p) => Math.abs(Number(p.split(',')[1]) - 3400) < 5)).toBe(true)
  })
  it('draws nothing without a highway', () => {
    const o: string[] = []
    renderHighway(model([road('S1', 'street', [[0, 0], [10, 10]])]), theme, o)
    expect(o.join('')).not.toContain('data-level')
  })
})
