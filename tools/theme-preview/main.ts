import { generateSector } from '../../src/gen/sector/generate'
import { renderSector } from '../../src/render/svg'
import { getTheme, type Theme } from '../../src/render/theme'
import { resolveTags } from '../../src/app/tags'

// candidate palettes from temp/neon-palette-research.md — the applied
// "restrained neon" lives in theme.ts; these two are the alternatives
const synthwave: Theme = {
  id: 'synthwave', label: 'Synthwave (candidate b)',
  bg: '#14091f', water: '#190f33', waterShallow: '#2c1a4a', shoreGlow: '#0a0616',
  districtFill: {
    corp: '#201040', residential: '#241629', slum: '#2e1220',
    industrial: '#16202e', entertainment: '#33184a', docks: '#12203a',
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
  id: 'tokyo-night', label: 'Tokyo Night (candidate c)',
  bg: '#1a1b26', water: '#13141f', waterShallow: '#232b45', shoreGlow: '#0f1019',
  districtFill: {
    corp: '#202340', residential: '#22242f', slum: '#2a2230',
    industrial: '#202a22', entertainment: '#2a2140', docks: '#1c2735',
  },
  districtLabel: '#c0caf5',
  road: { highway: '#f7768e', arterial: '#7dcfff', street: '#414868' },
  building: { fill: '#24283b', stroke: '#565f89' },
  poi: { marker: '#e0af68', label: '#f0c894' },
  bridge: { deck: '#a9b1d6', shadow: '#0d0e14' },
  scaleBar: '#c0caf5',
  glow: false,
}

function draw(): void {
  const seed = Number((document.getElementById('seed') as HTMLInputElement).value) >>> 0
  const tags = (document.getElementById('tags') as HTMLInputElement).value.split(',').map((s) => s.trim())
  const params = { seed, pack: 'generic', theme: 'neon', ...resolveTags(tags) }
  const model = generateSector(params)
  const themes: Theme[] = [getTheme('neon'), synthwave, tokyoNight, getTheme('print')]
  const out = document.getElementById('out')!
  out.innerHTML = ''
  for (const theme of themes) {
    const label = theme.id === 'neon' ? 'Restrained Neon (applied)' : theme.label
    out.insertAdjacentHTML(
      'beforeend',
      `<figure><figcaption>${label}</figcaption>${renderSector(model, theme)}</figure>`,
    )
  }
}

document.getElementById('seed')!.addEventListener('change', draw)
document.getElementById('tags')!.addEventListener('change', draw)
draw()
