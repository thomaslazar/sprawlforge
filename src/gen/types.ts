import type { Pt, Rect } from './geometry'

export const GENERATOR_VERSION = 4

export const ZONE_TYPES = [
  'corp', 'residential', 'slum', 'industrial', 'entertainment', 'docks',
] as const

export type ZoneType = (typeof ZONE_TYPES)[number]

export const LANDFORMS = ['inland', 'coastal', 'bay'] as const

export type Landform = (typeof LANDFORMS)[number]

export type RoadClass = 'highway' | 'arterial' | 'street'

export interface SectorParams {
  seed: number
  /** sector edge length in km (map is size × size km) */
  size: number
  /** 0..1 — building coverage / block tightness */
  density: number
  /** 0..1 — how corp-dominated the sector is */
  corpDominance: number
  /** 0..1 — POI frequency */
  poiDensity: number
  /** 0..1 — street-fabric organicness bias (planned ↔ sprawl) */
  irregularity: number
  /** base landform; 'auto' resolves deterministically from the seed */
  landform: Landform | 'auto'
  /** water modifiers — independent of landform and each other */
  river: boolean
  lakes: boolean
  /** offshore islets inside water — independent of landform and each other */
  islands: boolean
  /** pier/harbor decoration pass (spec §4, last task) */
  piers: boolean
  /** flavor pack id */
  pack: string
  /** theme id (render-side concern, carried in params for URL round-trip) */
  theme: string
}

export interface RiverSlice {
  /** window-local course polyline (clipped to the window, margin included) */
  course: Pt[]
  width: number
}

export interface Terrain {
  landform: Landform
  /** resolved water modifiers (see SectorParams) */
  river: boolean
  lakes: boolean
  islands: boolean
  metroSeed: number
  /** window-local multipolygons, meters, origin top-left */
  water: Array<Array<Array<[number, number]>>>
  land: Array<Array<Array<[number, number]>>>
  /** river course geometry actually in-window; null even when `river` is true
   * if the traced course never crosses this sector's window */
  riverSlice: RiverSlice | null
}

export interface Road {
  id: string
  class: RoadClass
  /** centerline, meters */
  points: Pt[]
  /** total paved width, meters */
  width: number
  name: string | null
  /** true for a bridge span crossing water */
  bridge?: boolean
}

export interface District {
  id: string
  zone: ZoneType
  name: string
  bounds: Rect
  /** district shape; bounds is its bbox */
  poly: Pt[]
  shore: boolean
  /** 0.05..0.95 — this district's street-fabric organicness */
  irregularity: number
  /** area-weighted centroid of the district's surviving blocks — where the
   * label anchors; unlike bounds' center, never falls in open water. */
  labelAt: Pt
}

export interface Block {
  id: string
  districtId: string
  /** block outline, meters, in its local street-fabric orientation */
  poly: Pt[]
  /** outer ring, meters; equals poly unless clipped by water */
  footprint: Pt[]
}

export interface Building {
  id: string
  blockId: string
  districtId: string
  /** outer ring, meters; a rotated BSP lot clipped to its block's footprint */
  footprint: Pt[]
}

export interface Pier {
  id: string
  /** deck centerline, land -> water */
  points: [Pt, Pt]
  width: number
}

export interface Poi {
  id: string
  buildingId: string
  districtId: string
  /** poi type id from the flavor pack, e.g. 'corp_hq' */
  type: string
  name: string
  /** marker position (building center), meters */
  at: Pt
}

export interface SectorModel {
  meta: {
    seed: number
    generatorVersion: number
    params: SectorParams
    /** sector edge length in meters */
    sizeM: number
    metroSeed: number
  }
  terrain: Terrain
  roads: Road[]
  districts: District[]
  blocks: Block[]
  buildings: Building[]
  pois: Poi[]
  piers: Pier[]
}
