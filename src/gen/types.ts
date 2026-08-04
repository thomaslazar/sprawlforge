import type { Pt, Rect } from './geometry'

export const GENERATOR_VERSION = 2

export const ZONE_TYPES = [
  'corp', 'residential', 'slum', 'industrial', 'entertainment', 'docks',
] as const

export type ZoneType = (typeof ZONE_TYPES)[number]

export const TERRAIN_KINDS = [
  'inland', 'river', 'coastal', 'bay', 'estuary', 'island', 'lakes',
] as const

export type TerrainKind = (typeof TERRAIN_KINDS)[number]

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
  /** terrain template; 'auto' resolves deterministically from the seed */
  terrain: TerrainKind | 'auto'
  /** pier/harbor decoration pass (spec §4, last task) */
  piers: boolean
  /** flavor pack id */
  pack: string
  /** theme id (render-side concern, carried in params for URL round-trip) */
  theme: string
}

export interface Water {
  kind: 'none' | 'coast' | 'river'
  /** closed polygon in meters; empty when kind === 'none' */
  polygon: Pt[]
  /** axis-aligned bounding rect used to keep land layout out of water; null when none */
  bounds: Rect | null
}

export interface Road {
  id: string
  class: RoadClass
  /** centerline, meters */
  points: Pt[]
  /** total paved width, meters */
  width: number
  name: string | null
}

export interface District {
  id: string
  zone: ZoneType
  name: string
  bounds: Rect
}

export interface Block {
  id: string
  districtId: string
  rect: Rect
}

export interface Building {
  id: string
  blockId: string
  districtId: string
  rect: Rect
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
  }
  water: Water
  roads: Road[]
  districts: District[]
  blocks: Block[]
  buildings: Building[]
  pois: Poi[]
}
