import type { Pt } from '../../src/gen/geometry'
import { hashSeed, mulberry32 } from '../../src/gen/rng'
import { inWater } from '../../src/gen/sector/bridges'
import { effectiveIrregularity } from '../../src/gen/sector/zoning'
import { sampleTerrain } from '../../src/gen/terrain'
import { buildRoadField, type RoadField } from '../../src/gen/streets/field'
import {
  MAJOR, MINOR, RoadIndex, poissonSeeds, riverCrossingSeeds, seedsAlong, traceLayer,
} from '../../src/gen/streets/trace'
import { traceHighway } from '../../src/gen/streets/highway'
import {
  buildPlanarGraph, degree4Vertices, facesOf, pruneDanglers, windowRing,
} from '../../src/gen/streets/graph'
import type { Road, SectorParams, Terrain } from '../../src/gen/types'

const IRREGULARITY: Record<string, number> = { planned: 0.15, mixed: 0.5, sprawl: 0.85 }

function syncInputsFromQuery(): void {
  const q = new URLSearchParams(location.search)
  const seedInput = document.getElementById('seed') as HTMLInputElement
  const sizeInput = document.getElementById('size') as HTMLInputElement
  const tagSelect = document.getElementById('tag') as HTMLSelectElement
  if (q.has('seed')) seedInput.value = q.get('seed')!
  if (q.has('size')) sizeInput.value = q.get('size')!
  if (q.has('tag')) tagSelect.value = q.get('tag')!
}

function ringToPoints(ring: Pt[]): string {
  return ring.map((p) => `${p.x},${p.y}`).join(' ')
}

/** water fill + land outline, shared background for every figure */
function backgroundSvg(terrain: Terrain | undefined): string {
  if (!terrain) return ''
  const waterD = terrain.water
    .flatMap((poly) => poly.map((ring) => `M${ring.map(([x, y]) => `${x},${y}`).join('L')}Z`))
    .join(' ')
  const water = waterD ? `<path d="${waterD}" fill="#123a56" fill-rule="evenodd"/>` : ''
  const land = terrain.land
    .map((poly) => `<polygon points="${ringToPoints(poly[0].map(([x, y]) => ({ x, y })))}" fill="none" stroke="#3d6b52" stroke-width="6" opacity="0.6"/>`)
    .join('')
  return water + land
}

function figure(sizeM: number, caption: string, inner: string): string {
  return `<figure><svg viewBox="0 0 ${sizeM} ${sizeM}">${inner}</svg><figcaption>${caption}</figcaption></figure>`
}

function patchesSvg(field: RoadField | undefined): string {
  if (!field) return ''
  return field.patches
    .map((patch) => {
      const color = patch.shore ? '#ffaa44' : '#88ccee'
      const half = patch.size / 8
      const dx = Math.cos(patch.angle) * half
      const dy = Math.sin(patch.angle) * half
      const { x, y } = patch.center
      return (
        `<line x1="${x - dx}" y1="${y - dy}" x2="${x + dx}" y2="${y + dy}" stroke="${color}" stroke-width="6"/>` +
        `<circle cx="${x}" cy="${y}" r="20" fill="${color}"/>`
      )
    })
    .join('')
}

function fieldSvg(field: RoadField | undefined, sizeM: number): string {
  if (!field) return ''
  const parts: string[] = []
  const half = 30
  for (let y = 0; y <= sizeM; y += 100) {
    for (let x = 0; x <= sizeM; x += 100) {
      const { major } = field.sample({ x, y })
      const dx = major.x * half
      const dy = major.y * half
      parts.push(`<line x1="${x - dx}" y1="${y - dy}" x2="${x + dx}" y2="${y + dy}" stroke="#99ff99" stroke-width="5" opacity="0.85"/>`)
    }
  }
  return parts.join('')
}

function roadSvg(road: Road, color: string, width: number): string {
  if (road.points.length < 2) return ''
  return `<polyline points="${ringToPoints(road.points)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`
}

function roadsSvg(highway: Road, arterials: Road[], streets: Road[]): string {
  const streetsSvg = streets.map((r) => roadSvg(r, '#999999', 9)).join('')
  const arterialsSvg = arterials.map((r) => roadSvg(r, '#00ccff', 18)).join('')
  const highwaySvg = roadSvg(highway, '#ee3333', 32)
  return streetsSvg + arterialsSvg + highwaySvg
}

function facesSvg(districtFaces: Pt[][], blockFaces: Pt[][], crossroads: Pt[]): string {
  const blocks = blockFaces
    .map((f) => `<polygon points="${ringToPoints(f)}" fill="none" stroke="#ffffff" stroke-width="5" opacity="0.4"/>`)
    .join('')
  const districts = districtFaces
    .map((f) => `<polygon points="${ringToPoints(f)}" fill="none" stroke="#ffdd00" stroke-width="20"/>`)
    .join('')
  const crossings = crossroads
    .map((p) => `<circle cx="${p.x}" cy="${p.y}" r="18" fill="#ff33ff"/>`)
    .join('')
  return blocks + districts + crossings
}

function draw(): void {
  const t0 = performance.now()
  const statsLines: string[] = []
  const errors: string[] = []

  const timeIt = <T,>(label: string, fn: () => T): T | undefined => {
    const start = performance.now()
    try {
      const value = fn()
      statsLines.push(`${label}: ${(performance.now() - start).toFixed(1)}ms`)
      return value
    } catch (e) {
      statsLines.push(`${label}: ${(performance.now() - start).toFixed(1)}ms (error)`)
      errors.push(`${label} failed: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
  }
  const safe = (fn: () => string): string => {
    try { return fn() } catch (e) {
      errors.push(`render failed: ${e instanceof Error ? e.message : String(e)}`)
      return ''
    }
  }

  const seed = Number((document.getElementById('seed') as HTMLInputElement).value) >>> 0
  const sizeKm = Number((document.getElementById('size') as HTMLInputElement).value)
  const tag = (document.getElementById('tag') as HTMLSelectElement).value
  const irregularity = IRREGULARITY[tag] ?? 0.5
  const sizeM = sizeKm * 1000

  const params: SectorParams = {
    seed, size: sizeKm, density: 0.5, corpDominance: 0.5, poiDensity: 0.5, irregularity,
    landform: 'coastal', river: true, lakes: false, islands: false, piers: false,
    pack: 'generic', theme: 'neon',
  }

  const irregularityAt = effectiveIrregularity(params)

  const terrain = timeIt('terrain', () => sampleTerrain(params, sizeM))
  const field = terrain && timeIt('field', () => buildRoadField(params, terrain, sizeM))

  const emptyHighway: Road = { id: 'H1', class: 'highway', points: [], width: 32, name: null }
  const highway = (terrain && timeIt('highway', () => traceHighway(params, terrain, sizeM).road)) ?? emptyHighway

  const index = new RoadIndex(200)
  if (highway.points.length > 0) index.add('H1', highway.points, 'highway')

  const arterials: Road[] = terrain && field
    ? timeIt('arterials', () => {
        const seedRng = mulberry32(hashSeed(seed, 'arterial-seeds'))
        const seeds = [
          ...seedsAlong(highway.points, 400, false),
          ...riverCrossingSeeds(terrain, seedRng),
          ...poissonSeeds(sizeM, 400, seedRng, (p) => !inWater(terrain, p)),
        ]
        return traceLayer(
          field, 'major', seeds, terrain, sizeM, index, MAJOR,
          mulberry32(hashSeed(seed, 'arterials')), irregularityAt, 'A', 'arterial',
        )
      }) ?? []
    : []

  const streets: Road[] = terrain && field
    ? timeIt('streets', () => {
        const seeds = arterials.flatMap((a) => seedsAlong(a.points, 100, true))
        return traceLayer(
          field, 'minor', seeds, terrain, sizeM, index, MINOR,
          mulberry32(hashSeed(seed, 'streets')), irregularityAt, 'S', 'street',
        )
      }) ?? []
    : []

  // R13 fix round 1: the first minor pass alone only seeds streets off
  // arterials (combs, one direction) — a second minor pass seeded off the
  // streets themselves, walking the 'major' axis, closes the grid the other
  // way. Same class/width as streets (both are street-grade).
  const lanes: Road[] = terrain && field
    ? timeIt('lanes', () => {
        const seeds = streets.flatMap((s) => seedsAlong(s.points, 100, true))
        return traceLayer(
          field, 'major', seeds, terrain, sizeM, index, MINOR,
          mulberry32(hashSeed(seed, 'streets-2')), irregularityAt, 'L', 'street',
        )
      }) ?? []
    : []

  const boundaries: Pt[][] = [
    windowRing(sizeM),
    ...(terrain ? terrain.land.map((poly) => poly[0].map(([x, y]) => ({ x, y }))) : []),
  ]
  const majorRoads = highway.points.length > 0 ? [highway, ...arterials] : arterials

  const districtFaces = timeIt('district-faces', () => facesOf(pruneDanglers(buildPlanarGraph(majorRoads, boundaries)))) ?? []

  let blockFaces: Pt[][] = []
  let crossroads: Pt[] = []
  timeIt('block-faces', () => {
    const g = pruneDanglers(buildPlanarGraph([...majorRoads, ...streets, ...lanes], boundaries))
    blockFaces = facesOf(g)
    crossroads = degree4Vertices(g)
  })

  const bg = backgroundSvg(terrain)
  const out = document.getElementById('out')!
  out.innerHTML =
    figure(sizeM, `patches (${field?.patches.length ?? 0})`, bg + safe(() => patchesSvg(field))) +
    figure(sizeM, 'field', bg + safe(() => fieldSvg(field, sizeM))) +
    figure(sizeM, `roads (H=${highway.points.length > 0 ? 1 : 0} A=${arterials.length} S=${streets.length} L=${lanes.length})`, bg + safe(() => roadsSvg(highway, arterials, [...streets, ...lanes]))) +
    figure(sizeM, `faces (district=${districtFaces.length} block=${blockFaces.length} x=${crossroads.length})`, bg + safe(() => facesSvg(districtFaces, blockFaces, crossroads)))

  const totalMs = performance.now() - t0
  const statsText = [
    `tag=${tag} seed=${seed} size=${sizeKm}km irregularity=${irregularity}`,
    ...statsLines,
    `total=${totalMs.toFixed(1)}ms`,
    `counts: patches=${field?.patches.length ?? 0} highway=${highway.points.length > 0 ? 1 : 0} arterials=${arterials.length} streets=${streets.length} lanes=${lanes.length} districtFaces=${districtFaces.length} blockFaces=${blockFaces.length} crossroads=${crossroads.length}`,
    ...(errors.length ? ['ERRORS:', ...errors] : []),
  ].join('\n')
  document.getElementById('stats')!.textContent = statsText
}

syncInputsFromQuery()
document.getElementById('seed')!.addEventListener('change', draw)
document.getElementById('size')!.addEventListener('change', draw)
document.getElementById('tag')!.addEventListener('change', draw)
draw()
