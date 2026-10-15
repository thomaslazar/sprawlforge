import { describe, expect, it } from 'vitest'
import { generateSector } from '../gen/sector/generate'
import type { Pt, Rect } from '../gen/geometry'
import { GENERATOR_VERSION, type SectorModel, type SectorParams } from '../gen/types'
import { insetOrLargest } from '../gen/streets/lots'
import { designShape } from '../gen/landmarks/designs'
import { renderSector } from './svg'
import { getTheme, themes } from './theme'

const rectPoly = (r: Rect): Pt[] => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
]

const base: SectorParams = {
  seed: 42, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
  landform: 'coastal', river: false, lakes: false, islands: false, piers: false, arcology: false, megablock: false, pack: 'generic', theme: 'neon',
}
const model = generateSector(base)
const frontageCount = (svg: string) => [...svg.matchAll(/<path data-frontage="1" data-count="(\d+)"/g)].reduce((a, x) => a + Number(x[1]), 0)

describe('renderSector', () => {
  it('is deterministic', () => {
    expect(renderSector(model, getTheme('neon'))).toBe(renderSector(model, getTheme('neon')))
  })
  it('is a standalone svg with metric viewBox', () => {
    const svg = renderSector(model, getTheme('neon'))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain(`viewBox="0 0 ${model.meta.sizeM} ${model.meta.sizeM}"`)
  })
  it('renders every district, building and poi with data-id', () => {
    const svg = renderSector(model, getTheme('neon'))
    for (const d of model.districts) expect(svg).toContain(`data-id="${d.id}"`)
    for (const p of model.pois) expect(svg).toContain(`data-id="${p.id}"`)
    expect(svg.match(/<polygon data-id="BLD/g)!.length + frontageCount(svg)).toBe(model.buildings.length) // strip lots are one data-frontage path
  })
  // field-driven irregularity samples the noise field per cut (arterials
  // and streets both), so a 6km sector's extra fabric pushes this past the
  // 5s default under parallel test load — same headroom bump other
  // generation-heavy tests in this codebase already use
  it('has a metric scale bar', { timeout: 90000 }, () => {
    expect(renderSector(model, getTheme('neon'))).toContain('500 m')
    const big = generateSector({ ...base, size: 6 })
    expect(renderSector(big, getTheme('neon'))).toContain('1 km')
  })
  it('themes change output', () => {
    expect(renderSector(model, getTheme('neon'))).not.toBe(renderSector(model, getTheme('print')))
  })
  it('escapes xml in names', () => {
    const hacked = {
      ...model,
      districts: [{ ...model.districts[0], name: 'A & B <X>' }, ...model.districts.slice(1)],
    }
    const svg = renderSector(hacked, getTheme('neon'))
    expect(svg).toContain('A &amp; B &lt;X&gt;')
  })
  it('ships neon, print and blueprint themes; getTheme falls back to neon', () => {
    expect(Object.keys(themes).sort()).toEqual(['blueprint', 'neon', 'print', 'synthwave', 'tokyo-night'])
    expect(getTheme('nope').id).toBe('neon')
  })
  it('getTheme falls back to neon for prototype-polluting ids', () => {
    expect(getTheme('constructor').id).toBe('neon')
  })
  const handModel = (pois: SectorModel['pois']): SectorModel => ({
    meta: { seed: 1, generatorVersion: GENERATOR_VERSION, params: base, sizeM: 1000, metroSeed: 1 },
    terrain: {
      landform: 'inland', river: false, lakes: false, islands: false,
      metroSeed: 1,
      water: [],
      land: [[[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]]],
      riverSlice: null,
    },
    roads: [],
    districts: [],
    blocks: [],
    buildings: [], lots: [],
    pois,
    piers: [],
    arcologies: [], megablocks: [], compounds: [],
  })
  const poi = (id: string, name: string, x: number, y: number, type = 'x') => ({
    id, buildingId: `BLD${id}`, districtId: 'D01', type, name, at: { x, y },
  })

  const wetModel: SectorModel = {
    meta: { seed: 1, generatorVersion: GENERATOR_VERSION, params: base, sizeM: 1000, metroSeed: 1 },
    terrain: {
      landform: 'coastal', river: true, lakes: false, islands: false,
      metroSeed: 1,
      water: [[[[250, 250], [750, 250], [750, 750], [250, 750]]]],
      // land is the window MINUS the water square (outer ring + hole) —
      // not the full window: a full-square land fixture made the district
      // clip-path test vacuous, since fill would have looked identical
      // whether or not the clip existed.
      land: [[
        [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
        [[250, 250], [750, 250], [750, 750], [250, 750]],
      ]],
      riverSlice: { course: [{ x: 0, y: 500 }, { x: 1000, y: 500 }], width: 20 },
    },
    roads: [
      {
        id: 'R01',
        class: 'arterial',
        points: [{ x: 500, y: 0 }, { x: 500, y: 1000 }],
        width: 25,
        name: 'Bridge Road',
        bridge: true,
      },
    ],
    // spans the full window, deliberately overlapping the water square —
    // proves the land-clip actually confines the fill (C2)
    districts: [{ id: 'D01', zone: 'corp', name: 'Test District', bounds: { x: 0, y: 0, w: 1000, h: 1000 }, poly: rectPoly({ x: 0, y: 0, w: 1000, h: 1000 }), irregularity: 0.5, shore: true, labelAt: { x: 500, y: 500 }, flags: {} }],
    blocks: [],
    buildings: [], lots: [],
    pois: [],
    piers: [{ id: 'PR01', points: [{ x: 700, y: 500 }, { x: 760, y: 500 }], width: 6 }],
    arcologies: [], megablocks: [], compounds: [],
  }

  it('scopes the glow filter to highway/arterial road strokes only, never labels or poi markers', () => {
    const theme = getTheme('neon')
    const glowModel: SectorModel = {
      meta: { seed: 1, generatorVersion: GENERATOR_VERSION, params: base, sizeM: 1000, metroSeed: 1 },
      terrain: {
        landform: 'inland', river: false, lakes: false, islands: false, metroSeed: 1,
        water: [], land: [[[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]]], riverSlice: null,
      },
      roads: [
        { id: 'RH', class: 'highway', points: [{ x: 0, y: 100 }, { x: 1000, y: 100 }], width: 20, name: 'Highway', bridge: false },
        { id: 'RA', class: 'arterial', points: [{ x: 0, y: 200 }, { x: 1000, y: 200 }], width: 15, name: 'Arterial', bridge: false },
        { id: 'RS', class: 'street', points: [{ x: 0, y: 300 }, { x: 1000, y: 300 }], width: 8, name: 'Street', bridge: false },
      ],
      districts: [{ id: 'D01', zone: 'corp', name: 'Test District', bounds: { x: 0, y: 0, w: 1000, h: 1000 }, poly: rectPoly({ x: 0, y: 0, w: 1000, h: 1000 }), irregularity: 0.5, shore: false, labelAt: { x: 500, y: 500 }, flags: {} }],
      blocks: [],
      buildings: [], lots: [],
      pois: [poi('P01', 'Alpha Tower', 500, 600)],
      piers: [],
      arcologies: [], megablocks: [], compounds: [],
    }
    const svg = renderSector(glowModel, theme)
    // highway and arterial polylines carry the glow filter
    expect(svg).toMatch(new RegExp(`stroke="${theme.road.highway}"[^/]*filter="url\\(#glow\\)"`))
    expect(svg).toMatch(new RegExp(`stroke="${theme.road.arterial}"[^/]*filter="url\\(#glow\\)"`))
    // street never does
    expect(svg).not.toMatch(new RegExp(`stroke="${theme.road.street}"[^/]*filter="url\\(#glow\\)"`))
    // labels (district + poi) and the poi marker never carry the glow filter
    expect(svg.match(/<text[^>]*filter="url\(#glow\)"/)).toBeNull()
    expect(svg.match(/<circle[^>]*filter="url\(#glow\)"/)).toBeNull()
  })

  it('draws elevated and sunken highways with hachures over one colour', () => {
    const theme = getTheme('neon')
    const seg = (from: number, to: number, level: 'elevated' | 'sunken' | 'ground') => ({ from, to, level, districtId: 'D01', transition: false })
    const m: SectorModel = {
      meta: { seed: 1, generatorVersion: GENERATOR_VERSION, params: base, sizeM: 1000, metroSeed: 1 },
      terrain: { landform: 'inland', river: false, lakes: false, islands: false, metroSeed: 1, water: [], land: [[[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]]], riverSlice: null },
      roads: [{ id: 'RH', class: 'highway', points: [{ x: 0, y: 500 }, { x: 900, y: 500 }], width: 20, name: 'Highway', bridge: false, segments: [seg(0, 0.34, 'ground'), seg(0.34, 0.67, 'elevated'), seg(0.67, 1, 'sunken')] }],
      districts: [], blocks: [], buildings: [], lots: [], pois: [], piers: [], arcologies: [], megablocks: [], compounds: [],
    }
    const svg = renderSector(m, theme)
    const group = (l: string) => svg.match(new RegExp(`<g data-level="${l}">[\\s\\S]*?</g>`))![0]
    expect(group('elevated')).toContain('stroke="url(#hachure-elevated)"')
    expect(group('sunken')).toContain('stroke="url(#hachure-sunken)"')
    expect(group('ground')).not.toContain('url(#hachure')
    for (const l of ['sunken', 'ground', 'elevated']) expect(group(l)).toContain(`stroke="${theme.road.highway}" stroke-width="32"`)
    expect(svg).toContain('<pattern id="hachure-elevated"')
    expect(svg).toContain('<pattern id="hachure-sunken"')
  })

  it('renders shallow band and shore glow via clip paths', () => {
    const svg = renderSector(wetModel, getTheme('neon'))
    expect(svg).toContain('id="water-clip"')
    expect(svg).toContain('id="land-clip"')
    expect(svg).toContain(getTheme('neon').waterShallow)
    expect(svg).toContain('feGaussianBlur')
    expect(svg).toContain('data-water=""')
  })

  it('never double-draws a bridge road as a plain class-colored polyline (only the deck)', () => {
    const svg = renderSector(wetModel, getTheme('neon'))
    // wetModel's only road (R01) is bridge:true — the road loop must skip it
    // entirely, so its class color (arterial) never appears as a polyline stroke
    expect(svg).not.toContain(`stroke="${getTheme('neon').road.arterial}"`)
    // wetModel's only other polyline is the river course; bridge adds shadow + deck
    expect(svg.match(/<polyline/g)!.length).toBe(3)
  })

  it('renders bridge deck and shadow', () => {
    const svg = renderSector(wetModel, getTheme('neon'))
    expect(svg).toContain(getTheme('neon').bridge.deck)
    expect(svg).toContain(getTheme('neon').bridge.shadow)
    expect(svg).toContain('data-bridge=""')
  })

  it('renders pier decks with data-id', () => {
    const svg = renderSector(wetModel, getTheme('neon'))
    expect(svg).toContain('data-id="PR01"')
  })

  it('never renders wave ornaments', () => {
    expect(renderSector(wetModel, getTheme('neon'))).not.toMatch(/wave/i)
  })

  it('clips district fills to the land shape and the river to the frame (C2/I3)', () => {
    const svg = renderSector(wetModel, getTheme('neon'))
    expect(svg).toContain('id="frame-clip"')
    // district polys sit inside a land-clipped group, not painted bare
    expect(svg).toMatch(/<g clip-path="url\(#land-clip\)">[\s\S]*<polygon data-id="D01"[\s\S]*<\/g>/)
    // the river polyline sits inside a frame-clipped group
    expect(svg).toMatch(/<g clip-path="url\(#frame-clip\)">[\s\S]*<polyline[\s\S]*<\/g>/)
  })

  it('renders the water fill once via <use>, not once per polygon (T10)', () => {
    const svg = renderSector(wetModel, getTheme('neon'))
    expect(svg.match(/data-water=""/g)!.length).toBe(1)
    expect(svg).toContain('<use href="#water-shape"')
  })

  it('nudges a colliding poi label to another side instead of dropping it', () => {
    const svg = renderSector(
      handModel([poi('P01', 'Alpha Tower', 500, 500), poi('P02', 'Beta Tower', 500, 500)]),
      getTheme('neon'),
    )
    // both labels survive: second one lands on a different side
    expect(svg).toContain('Alpha Tower')
    expect(svg).toContain('Beta Tower')
  })

  it('drops the label only when all candidate positions collide, markers always render', () => {
    const pois = ['A', 'B', 'C', 'D', 'E'].map((s, i) =>
      poi(`P0${i + 1}`, `${s} Tower`, 500, 500),
    )
    const svg = renderSector(handModel(pois), getTheme('neon'))
    for (const p of pois) expect(svg).toContain(`data-id="${p.id}"`)
    const labels = svg.match(/[A-E] Tower<\/text>/g) ?? []
    // several nudge candidates place, the rest drop — never all five
    expect(labels.length).toBeGreaterThanOrEqual(2)
    expect(labels.length).toBeLessThan(5)
  })

  it('important poi types win the label contest', () => {
    const svg = renderSector(
      handModel([
        // bar comes first in model order but must lose to the corp hq
        ...['A', 'B', 'C', 'D'].map((s, i) => poi(`P0${i + 1}`, `${s} Dive`, 500, 500, 'bar')),
        poi('P05', 'Zeta Spire HQ', 500, 500, 'corp_hq'),
      ]),
      getTheme('neon'),
    )
    expect(svg).toContain('Zeta Spire HQ')
  })

  it('every poi marker carries a tooltip with its name', () => {
    const svg = renderSector(model, getTheme('neon'))
    expect(svg.match(/<title>/g)!.length).toBe(model.pois.length)
  })

  it('clamps edge labels into the viewbox', () => {
    const svg = renderSector(handModel([poi('P01', 'Edge Post', 995, 3)]), getTheme('neon'))
    const text = svg.match(/<text x="([\d.-]+)" y="([\d.-]+)"[^>]*>Edge Post<\/text>/)
    expect(text).not.toBeNull()
    const fontP = 1000 * 0.011
    const y = Number(text![2])
    expect(y).toBeGreaterThanOrEqual(fontP) // label box top edge at y-h >= 0
    expect(Number(text![1])).toBeLessThanOrEqual(1000)
  })

  it('labelZoom shrinks label fonts and never loses labels', () => {
    const base1 = renderSector(model, getTheme('neon'))
    const zoomed = renderSector(model, getTheme('neon'), { labelZoom: 4 })
    const countLabels = (s: string) => (s.match(/<text /g) ?? []).length
    expect(countLabels(zoomed)).toBeGreaterThanOrEqual(countLabels(base1))
    expect(zoomed).toContain(`font-size="${(model.meta.sizeM * 0.011) / 4}"`)
  })

  it('shore band skips water-ring segments on the window border', () => {
    // water square touching the right border: the ring's border-lying edge
    // must not appear in the shallow-band stroke path
    const wet = handModel([])
    wet.terrain = {
      landform: 'coastal', metroSeed: 1, river: false, lakes: false, islands: false, riverSlice: null,
      water: [[[[600, 200], [1000, 200], [1000, 800], [600, 800]]]],
      land: [[[[0, 0], [1000, 0], [1000, 200], [600, 200], [600, 800], [1000, 800], [1000, 1000], [0, 1000]]]],
    }
    const svg = renderSector(wet, getTheme('neon'))
    const band = svg.match(new RegExp(`<path d="([^"]*)" fill="none" stroke="${getTheme('neon').waterShallow}"`))
    expect(band).not.toBeNull()
    // the border segment x=1000 from y=200..800 must be absent: no move/line
    // pair connecting 1000,200 -> 1000,800 in the band path
    expect(band![1]).not.toMatch(/1000,200L1000,800|1000,800L1000,200/)
    // but the real shoreline (x=600) is present
    expect(band![1]).toContain('600,')
  })

  it('export keeps per-element detail; interactive batches and drops filters', { timeout: 90000 }, () => {
    const m = generateSector({ ...base, landform: 'inland', irregularity: 0.15 })
    const theme = getTheme('neon')
    const svg = renderSector(m, theme)
    expect(svg).toMatch(/data-class="ramp"/)
    expect(svg).not.toMatch(/data-class="ramp"[^>]*filter=/)
    expect(svg).toMatch(/<polygon data-id="BLD/)
    expect(svg).toContain('filter="url(#glow)"')
    expect(svg).toMatch(/data-level="(elevated|sunken|ground)"/)
    const cnt = (x: string, a: string) => Number(x.match(new RegExp(`${a}[^>]*data-count="(\\d+)"`))?.[1] ?? 0)
    const junctions = cnt(svg, 'data-junctions')
    expect(junctions).toBeGreaterThanOrEqual(20)

    const ia = renderSector(m, theme, { interactive: true })
    expect(ia).not.toContain('url(#glow)') // shoreblur (shoreline) is unchanged
    expect(ia).not.toContain('<filter id="glow"')
    expect(ia).not.toContain('<polygon data-id="BLD')
    const sum = (re: RegExp) => [...ia.matchAll(re)].reduce((a, x) => a + Number(x[1]), 0)
    expect(sum(/<path data-buildings="1" data-count="(\d+)"/g) + frontageCount(ia) + (ia.match(/<polygon points=[^>]*stroke-width="0.5"/g) ?? []).length).toBe(m.buildings.length)
    expect(cnt(ia, 'data-streets')).toBe(m.roads.filter((r) => r.class === 'street' && !r.bridge).length)
    expect(cnt(ia, 'data-ramps')).toBe(m.roads.filter((r) => r.class === 'ramp' && !r.bridge).length)
    expect(cnt(ia, 'data-junctions')).toBe(junctions)
    const opens = (ia.match(/</g) ?? []).length
    expect(opens).toBeLessThan(6000) // measured 4751: POI markers+titles, labels, arterial halos remain (POIs scale with buildings, which concave-block fill tripled here)
  })

  it('interactive halo is one path per class', { timeout: 90000 }, () => {
    const m = generateSector({
      ...base, seed: 2982258224, size: 2, density: 0.25, corpDominance: 0.15, irregularity: 0.85, landform: 'bay',
    })
    const ia = renderSector(m, getTheme('neon'), { interactive: true })
    for (const c of ['highway', 'arterial']) {
      const paths = ia.match(new RegExp(`<path data-halo="${c}"[^>]*>`, 'g')) ?? []
      expect(paths).toHaveLength(1)
      expect(paths[0]).toContain('stroke-linecap="round"')
      expect(paths[0]).toContain('stroke-linejoin="round"')
    }
    expect(ia).not.toMatch(/<polyline[^>]*stroke-opacity="0.35"/)
    expect(renderSector(m, getTheme('neon'))).not.toContain('data-halo')
  })
})

const hsl = (hex: string): [number, number] => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2
  if (!d) return [0, 0]
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [(h * 60 + 360) % 360, d / (1 - Math.abs(2 * l - 1))]
}
describe('lots and details', () => {
  const s42 = { ...base, seed: 42, size: 4, landform: 'coastal', river: true, arcology: true } as SectorParams
  it('lot and details paths in both modes', { timeout: 120000 }, () => {
    const m = generateSector(s42)
    for (const interactive of [false, true]) {
      const svg = renderSector(m, getTheme('neon'), { interactive })
      for (const k of ['parking', 'plaza', 'yard', 'green'] as const) {
        const n = m.lots.filter((l) => l.kind === k).length
        if (n) expect(svg).toContain(`<path data-lots="${k}" data-count="${n}"`)
      }
      expect(svg.indexOf('data-lots')).toBeLessThan(svg.indexOf('data-buildings') === -1 ? svg.indexOf('data-id="BLD') : svg.indexOf('data-buildings'))
      expect(svg).toMatch(/<path data-details="1"[^>]*vector-effect="non-scaling-stroke"/)
      expect(svg).toMatch(/<pattern id="parking-\d+"/)
    }
  })
  it('every theme has a green lot tint', () => {
    for (const t of Object.values(themes)) { const [h, s] = hsl(t.lot.green); expect(h, t.id).toBeGreaterThanOrEqual(80); expect(h).toBeLessThanOrEqual(160); expect(s).toBeGreaterThanOrEqual(0.2) }
  })
})

describe('landmarks', () => {
  const corp = generateSector({ ...base, landform: 'inland', corpDominance: 0.85 })
  const fringe = generateSector({ ...base, seed: 7, landform: 'bay', corpDominance: 0.15 })
  it('landmark names print once as text (no duplicate POI label)', { timeout: 90000 }, () => {
    const a = renderSector(corp, getTheme('neon'), { interactive: false })
    const k = corp.arcologies[0]
    const esc = k.name.replace(/&/g, '&amp;')
    expect(a.split(`>${esc}</text>`).length - 1).toBe(1)
  })
  it('every design renders', () => {
    const designs = ['rings', 'ziggurat', 'cluster', 'satellites', 'twins', 'crescent', 'stack'] as const
    const counts = [0, 4, 6, 5, 0, 0, 3]
    const arcologies = designs.map((design, i) => {
      const center = { x: 150 + i * 150, y: 500 }
      const detail = { count: counts[i], twist: 0.2 }
      const s = designShape(design, center, 60, 0.3, detail)
      return { id: `ARC${i + 1}`, name: design, design, angle: 0.3, center, radius: 60, footprint: s.outline, plaza: s.outline, ringRoadId: `K${i + 1}`, access: 'ring' as const, detail }
    })
    const withArc = { ...model, arcologies, megablocks: [] }
    const svg = renderSector(withArc, getTheme('neon'))
    const count = (d: string, tag: string) => {
      const k = designs.indexOf(d as never)
      const start = svg.indexOf(`data-arcology="ARC${k + 1}"`)
      const end = k === designs.length - 1 ? start + svg.slice(start).search(/<(path|polyline|text)/) : svg.indexOf(`data-arcology="ARC${k + 2}"`)
      return (svg.slice(start, end).match(new RegExp(`<${tag} `, 'g')) ?? []).length
    }
    for (const d of designs) expect(svg).toContain(`data-design="${d}"`)
    expect(svg).toContain(`data-access="ring"`)
    // slice starts inside the outline tag; a non-last slice also holds the next plaza and the next outline tag (2 extra polygons)
    const polys = (d: string) => count(d, 'polygon') - (d === 'stack' ? 0 : 2)
    expect(polys('rings')).toBe(2)
    expect(polys('ziggurat')).toBe(4)
    expect(count('ziggurat', 'line')).toBe(4)
    expect(polys('cluster')).toBe(7)
    expect(polys('satellites')).toBe(6)
    expect(count('satellites', 'line')).toBe(5)
    expect(polys('twins')).toBe(2)
    expect(count('twins', 'line')).toBe(1)
    expect(polys('crescent')).toBe(2)
    expect(polys('stack')).toBe(3)
  })
  it('renders arcology and megablock marks', { timeout: 90000 }, () => {
    expect(corp.arcologies.length).toBeGreaterThan(0)
    expect(fringe.megablocks.length).toBeGreaterThan(0)
    for (const interactive of [false, true]) {
      const a = renderSector(corp, getTheme('neon'), { interactive })
      for (const k of corp.arcologies) {
        expect(a).toContain(`data-arcology="${k.id}"`)
        expect(a).toContain(k.name.replace(/&/g, '&amp;'))
      }
      expect(a.match(/<polygon[^>]*data-arcology/g)!.length).toBe(corp.arcologies.length)
      expect(a.indexOf('data-arcology')).toBeLessThan(a.search(/<polyline(?! data-fence)/))
      const m = renderSector(fringe, getTheme('neon'), { interactive })
      for (const k of fringe.megablocks) expect(m).toContain(`data-megablock="${k.id}"`)
      expect(m).toMatch(/<polygon data-megablock="MEG\d+"[^>]*stroke-width="2"/)
      // hive cells are drawn by the landmark pass, not the generic building draw
      const hiveIds = new Set(fringe.blocks.filter((b) => b.flags.megablock).map((b) => b.id))
      const hive = fringe.buildings.filter((b) => hiveIds.has(b.blockId))
      expect(hive.length).toBeGreaterThan(0)
      if (!interactive) expect(m.match(/<polygon data-id="BLD/g)!.length + frontageCount(m)).toBe(fringe.buildings.length) // each once: hive cells only in the landmark draw
      else {
        const generic = m.match(/<path data-buildings[^>]*>/g)!.join('')
        expect(generic.split('M').length - 1 + frontageCount(m)).toBe(fringe.buildings.length - hive.length)
        expect(m).not.toContain('<polygon data-id="BLD')
      }
      expect(m).toMatch(/<path data-landmark-alleys="1" d="M/) // the megablock draw keeps its alleys
      expect(m).not.toContain('data-alleys="1"') // the generic alley path is gone
      expect(m).toContain('data-landmark-label=""') // valueless attrs are invalid XML, which breaks PNG export
    }
  })
  it('strip lots render in the frontage batch', { timeout: 120000 }, () => {
    const m = generateSector({ ...base, seed: 42, size: 4, landform: 'coastal', river: true })
    const strip = new Set(m.blocks.filter((b) => b.style === 'strip').map((b) => b.id))
    const count = m.buildings.filter((b) => strip.has(b.blockId)).length
    expect(count).toBeGreaterThan(0)
    for (const interactive of [false, true]) {
      const svg = renderSector(m, getTheme('neon'), { interactive })
      expect(svg).toContain(`<path data-frontage="1" data-count="${count}"`)
      if (interactive) expect(svg.match(/<path data-buildings[^>]*>/g)!.join('').split('M').length - 1).toBe(m.buildings.length - count)
      else expect(svg.match(/<polygon data-id="BLD/g)!.length).toBe(m.buildings.length - count)
    }
  })
})

describe('compounds', () => {
  it('renders compound ground and double fence with a gate gap', { timeout: 300000 }, () => {
    const m = generateSector({ ...base, landform: 'inland', corpDominance: 0.85 })
    expect(m.compounds.length).toBeGreaterThan(0)
    const svg = renderSector(m, getTheme('neon'))
    expect(svg.match(/<polygon data-compound="CMP\d+"/g)).toHaveLength(m.compounds.length)
    const lines = [...svg.matchAll(/<polyline data-fence="(CMP\d+)" points="([^"]+)"/g)]
    expect(lines).toHaveLength(2 * m.compounds.length)
    const len = (s: string) => { const p = s.split(' ').map((q) => q.split(',').map(Number)); return p.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0) }
    const per = (r: Pt[]) => r.reduce((a, p, i) => a + Math.hypot(r[(i + 1) % r.length].x - p.x, r[(i + 1) % r.length].y - p.y), 0)
    for (const c of m.compounds) {
      const mine = lines.filter((l) => l[1] === c.id).map((l) => len(l[2]))
      expect(mine).toHaveLength(2)
      const inner = insetOrLargest(c.fence, 1.5)
      expect(inner).not.toBeNull()
      expect(mine[0] + mine[1]).toBeGreaterThan(per(c.fence) + per(inner!) - 24 - 2)
      expect(mine[0] + mine[1]).toBeLessThan(per(c.fence) + per(inner!) - 24 + 2)
    }
  })
})

describe('xml well-formedness', () => {
  it('rendered svg is well-formed xml (no bare attributes)', () => {
    for (const interactive of [false, true]) {
      const svg = renderSector(model, getTheme('neon'), { interactive })
      expect(svg).not.toMatch(/ data-[a-z-]+(?=[\s>/])/)
      // strict: inside every tag, each attribute name must be followed by ="
      for (const tag of svg.match(/<[a-zA-Z][^>]*>/g)!) {
        const attrs = tag.replace(/^<[a-zA-Z0-9:-]+/, '').replace(/\/?>$/, '').replace(/"[^"]*"/g, '""')
        expect(attrs, tag.slice(0, 80)).toMatch(/^(\s+[\w:-]+="")*\s*$/)
      }
    }
  })
})
