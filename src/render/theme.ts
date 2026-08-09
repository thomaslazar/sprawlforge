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

// "Restrained Neon" palette (docs/specs research): desaturated base + a
// tight lightness ramp per district so all six zones separate at a glance,
// glow reserved for highway/arterial strokes only (see svg.ts) rather than
// blooming labels/markers into an indistinct mass.
const neon: Theme = {
  id: 'neon',
  label: 'Neon',
  bg: '#0a0c12',
  water: '#0d1c2b',
  waterShallow: '#163449',
  shoreGlow: '#05080d',
  districtFill: {
    corp: '#172038',
    residential: '#1b1c26',
    slum: '#2a2019',
    industrial: '#1a2117',
    entertainment: '#23172c',
    docks: '#12262a',
  },
  districtLabel: '#9fb8c8',
  road: { highway: '#e8577f', arterial: '#4fc9d9', street: '#3a4560' },
  building: { fill: '#202840', stroke: '#4a5a7a' },
  poi: { marker: '#ffb454', label: '#ffdca8' },
  bridge: { deck: '#8a93a6', shadow: '#04060a' },
  scaleBar: '#9fb8c8',
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

// classic architectural-drafting look: deep blueprint-blue field, near-white
// linework for roads/buildings (buildings barely filled, read as outlines),
// white-cyan labels, no glow — district fills are barely-differentiated blue
// tints so zoning still reads without competing with the linework
const blueprint: Theme = {
  id: 'blueprint',
  label: 'Blueprint',
  bg: '#0b2e59',
  water: '#082444',
  waterShallow: '#0e3a6b',
  shoreGlow: '#0b2e59',
  districtFill: {
    corp: '#0f3564',
    residential: '#0d3160',
    slum: '#0b2c58',
    industrial: '#0e3462',
    entertainment: '#11386a',
    docks: '#0c305d',
  },
  districtLabel: '#dff3ff',
  road: { highway: '#ffffff', arterial: '#f1fbff', street: '#9dc4e0' },
  building: { fill: '#0e335f', stroke: '#e4f4ff' },
  poi: { marker: '#eaf7ff', label: '#dff3ff' },
  bridge: { deck: '#e4f4ff', shadow: '#071c38' },
  scaleBar: '#dff3ff',
  glow: false,
}

const synthwave: Theme = {
  id: 'synthwave',
  label: 'Synthwave',
  bg: '#14091f',
  water: '#190f33',
  waterShallow: '#2c1a4a',
  shoreGlow: '#0a0616',
  districtFill: {
    corp: '#201040',
    residential: '#241629',
    slum: '#2e1220',
    industrial: '#16202e',
    entertainment: '#33184a',
    docks: '#12203a',
  },
  districtLabel: '#d9b8ff',
  road: { highway: '#ff3fa4', arterial: '#33c2e6', street: '#4a3a66' },
  building: { fill: '#251a3a', stroke: '#6b4f99' },
  poi: { marker: '#ffe14d', label: '#fff2cc' },
  bridge: { deck: '#a893c9', shadow: '#0c0616' },
  scaleBar: '#d9b8ff',
  glow: true,
}

const tokyoNight: Theme = {
  id: 'tokyo-night',
  label: 'Tokyo Night',
  bg: '#1a1b26',
  water: '#13141f',
  waterShallow: '#232b45',
  shoreGlow: '#0f1019',
  districtFill: {
    corp: '#202340',
    residential: '#22242f',
    slum: '#2a2230',
    industrial: '#202a22',
    entertainment: '#2a2140',
    docks: '#1c2735',
  },
  districtLabel: '#c0caf5',
  road: { highway: '#f7768e', arterial: '#7dcfff', street: '#414868' },
  building: { fill: '#24283b', stroke: '#565f89' },
  poi: { marker: '#e0af68', label: '#f0c894' },
  bridge: { deck: '#a9b1d6', shadow: '#0d0e14' },
  scaleBar: '#c0caf5',
  glow: false,
}

export const themes: Record<string, Theme> = { neon, print, blueprint, synthwave, tokyoNight }

export function getTheme(id: string): Theme {
  return Object.hasOwn(themes, id) ? themes[id] : neon
}
