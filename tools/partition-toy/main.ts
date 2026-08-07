import { irregularityField } from '../../src/gen/partition/irregularity'
import { partitionPolygon } from '../../src/gen/partition/twisted'
import { hashSeed, mulberry32 } from '../../src/gen/rng'
import { sampleTerrain } from '../../src/gen/terrain'
import type { Pt } from '../../src/gen/geometry'

const IRREGULARITY = [0.05, 0.15, 0.5, 0.95]

const square = (): Pt[] => [
  { x: 50, y: 50 }, { x: 950, y: 50 }, { x: 950, y: 950 }, { x: 50, y: 950 },
]
const wide = (): Pt[] => [
  { x: 50, y: 300 }, { x: 950, y: 300 }, { x: 950, y: 700 }, { x: 50, y: 700 },
]
const blob = (): Pt[] =>
  Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * 2 * Math.PI
    const r = 280 + 170 * Math.abs(Math.sin(i * 2.3))
    return { x: 500 + r * Math.cos(a), y: 500 + r * Math.sin(a) }
  })
// real coastal land ring from the terrain generator, scaled into the 1000-box
function landRing(seed: number): Pt[] {
  const t = sampleTerrain(
    { seed, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity: 0.5,
      landform: 'coastal', river: false, lakes: false, islands: false,
      piers: false, pack: 'generic', theme: 'neon' },
    4000,
  )
  const ring = t.land[0][0].map(([x, y]) => ({ x: x / 4, y: y / 4 }))
  return ring
}

const SHAPES: Array<{ name: string; make: (seed: number) => Pt[] }> = [
  { name: 'square', make: () => square() },
  { name: 'wide', make: () => wide() },
  { name: 'blob', make: () => blob() },
  { name: 'coast', make: landRing },
]

const HUES = [200, 260, 320, 20, 80, 140]

// Road hierarchy: cut depth 0-1 is the first split(s) of a polygon (few, long,
// dominant), depth 2 a middle tier, depth 3+ deep, thin fabric — mirrors the
// OSM refs (temp/street-refs/01-barcelona.png, 08-pittsburgh.png): a handful
// of bright avenues, then connectors, then hairline lanes receding into the
// background. `base` is the depth-0/1 (avenue) look; deeper tiers shrink and
// dim from it.
function tierStyle(depth: number, base: { width: number; opacity: number }): { width: number; opacity: number } {
  if (depth <= 1) return base
  if (depth === 2) return { width: base.width * 0.45, opacity: base.opacity * 0.65 }
  return { width: base.width * 0.16, opacity: base.opacity * 0.35 }
}

function draw(): void {
  const seed = Number((document.getElementById('seed') as HTMLInputElement).value) >>> 0
  const minCell = Number((document.getElementById('mincell') as HTMLInputElement).value)
  const out = document.getElementById('out')!
  out.innerHTML = ''
  for (const shape of SHAPES) {
    for (const irr of IRREGULARITY) {
      const poly = shape.make(seed)
      const rng = mulberry32(hashSeed(seed, shape.name, irr))
      const { cells, cuts } = partitionPolygon(poly, { minCell, gap: 9, irregularity: irr, rng })
      const cellsSvg = cells
        .map((c, i) =>
          `<polygon points="${c.map((p) => `${p.x},${p.y}`).join(' ')}" fill="hsl(${HUES[i % 6]} 40% 30%)" stroke="#0af" stroke-width="1.5"/>`)
        .join('')
      const cutsSvg = cuts
        .map((c) => {
          const { width, opacity } = tierStyle(c.depth, { width: 5, opacity: 1 })
          return `<polyline points="${c.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#fff" stroke-width="${width}" opacity="${opacity}"/>`
        })
        .join('')
      out.insertAdjacentHTML(
        'beforeend',
        `<figure><svg viewBox="0 0 1000 1000">${cellsSvg}${cutsSvg}</svg>
         <figcaption>${shape.name} irr=${irr} cells=${cells.length}</figcaption></figure>`,
      )
    }
  }

  // fifth row: whole-map preview — TWO partition levels like the real
  // sector (arterials carve districts, streets carve blocks), both driven
  // by one spatial irregularity field sampled per cut. Style lives in the
  // street-scale fabric, so this row is what a full map's texture will do:
  // grid quarters flowing into meandering ones within a single map.
  // Column 0 is a synthetic vertical ramp (bottom = 0.05 planned grid,
  // top = 0.95 organic) — the capability demo, decoupled from noise luck;
  // columns 1-3 are real noise fields at toy scale.
  const FIELD_ROW_SCALE = 400
  const ramp = (p: Pt): number => 0.05 + 0.9 * Math.min(1, Math.max(0, (950 - p.y) / 900))
  for (let column = 0; column < 4; column++) {
    const poly = square()
    const field = column === 0
      ? ramp
      : irregularityField(hashSeed(seed, 'field-row', column), { scale: FIELD_ROW_SCALE })
    const rng = mulberry32(hashSeed(seed, 'field', column))
    const { cells: districts, cuts: arterials } = partitionPolygon(poly, {
      minCell: 300, gap: 12, irregularity: field, rng,
    })
    const parts: string[] = []
    let blockCount = 0
    districts.forEach((district, di) => {
      const { cells: blocks, cuts: streets } = partitionPolygon(district, {
        minCell: 80, gap: 4, irregularity: field, rng,
      })
      blockCount += blocks.length
      for (const b of blocks)
        parts.push(`<polygon points="${b.map((p) => `${p.x},${p.y}`).join(' ')}" fill="hsl(${HUES[di % 6]} 30% 28%)" stroke="#08c" stroke-width="0.8"/>`)
      for (const s of streets) {
        const { width, opacity } = tierStyle(s.depth, { width: 3.2, opacity: 0.95 })
        parts.push(`<polyline points="${s.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#9ab" stroke-width="${width}" opacity="${opacity}"/>`)
      }
    })
    for (const a of arterials) {
      const { width, opacity } = tierStyle(a.depth, { width: 9, opacity: 1 })
      parts.push(`<polyline points="${a.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#fff" stroke-width="${width}" opacity="${opacity}"/>`)
    }
    out.insertAdjacentHTML(
      'beforeend',
      `<figure><svg viewBox="0 0 1000 1000">${parts.join('')}</svg>
       <figcaption>${column === 0 ? 'field ramp (bottom grid → top organic)' : `field col=${column}`} blocks=${blockCount}</figcaption></figure>`,
    )
  }
}

document.getElementById('seed')!.addEventListener('change', draw)
document.getElementById('mincell')!.addEventListener('change', draw)
draw()
