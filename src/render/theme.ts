import type { RoadClass, ZoneType } from '../gen/types'

export interface Theme {
  id: string
  label: string
  bg: string
  water: string
  waterShallow: string
  shoreGlow: string
  districtFill: Record<ZoneType, string>
  districtLabel: string
  road: Record<RoadClass, string>
  building: { fill: string; stroke: string }
  poi: { marker: string; label: string }
  bridge: { deck: string; shadow: string }
  scaleBar: string
  glow: boolean
}

const neon: Theme = {
  id: 'neon',
  label: 'Neon',
  bg: '#0a0a12',
  water: '#0d1b2e',
  waterShallow: '#16324f',
  shoreGlow: '#000814',
  districtFill: {
    corp: '#14203a',
    residential: '#1a1a2e',
    slum: '#241a1a',
    industrial: '#1f2418',
    entertainment: '#2a142e',
    docks: '#12262c',
  },
  districtLabel: '#7fdbff',
  road: { highway: '#ff2975', arterial: '#00e5ff', street: '#2a3550' },
  building: { fill: '#151d30', stroke: '#3a4a6b' },
  poi: { marker: '#ffe066', label: '#ffe066' },
  bridge: { deck: '#8a93a6', shadow: '#05070d' },
  scaleBar: '#7fdbff',
  glow: true,
}

const print: Theme = {
  id: 'print',
  label: 'Print',
  bg: '#ffffff',
  water: '#dce8f0',
  waterShallow: '#c7dbe8',
  shoreGlow: '#9fb4c0',
  districtFill: {
    corp: '#eef1f6',
    residential: '#f4f4f0',
    slum: '#f6efe9',
    industrial: '#eff3ea',
    entertainment: '#f5edf6',
    docks: '#e9f2f4',
  },
  districtLabel: '#333333',
  road: { highway: '#222222', arterial: '#555555', street: '#bbbbbb' },
  building: { fill: '#e2e2dc', stroke: '#88888a' },
  poi: { marker: '#b03030', label: '#222222' },
  bridge: { deck: '#e8e8e2', shadow: '#b5b5b0' },
  scaleBar: '#222222',
  glow: false,
}

export const themes: Record<string, Theme> = { neon, print }

export function getTheme(id: string): Theme {
  return Object.hasOwn(themes, id) ? themes[id] : neon
}
