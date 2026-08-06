import { partitionPolygon } from '../../src/gen/partition/twisted'
import { hashSeed, mulberry32 } from '../../src/gen/rng'
import { sampleTerrain } from '../../src/gen/terrain'
import type { Pt } from '../../src/gen/geometry'

const IRREGULARITY = [0.1, 0.4, 0.7, 0.95]

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
    { seed, size: 4, density: 0.5, corpDominance: 0.5, poiDensity: 0.5,
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
        .map((c) => `<polyline points="${c.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#fff" stroke-width="3" opacity="0.5"/>`)
        .join('')
      out.insertAdjacentHTML(
        'beforeend',
        `<figure><svg viewBox="0 0 1000 1000">${cellsSvg}${cutsSvg}</svg>
         <figcaption>${shape.name} irr=${irr} cells=${cells.length}</figcaption></figure>`,
      )
    }
  }
}

document.getElementById('seed')!.addEventListener('change', draw)
document.getElementById('mincell')!.addEventListener('change', draw)
draw()
