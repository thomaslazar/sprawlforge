import { generateSector } from '../../src/gen/sector/generate'
import { renderSector } from '../../src/render/svg'
import { themes } from '../../src/render/theme'
import { resolveTags } from '../../src/app/tags'

function draw(): void {
  const seed = Number((document.getElementById('seed') as HTMLInputElement).value) >>> 0
  const tags = (document.getElementById('tags') as HTMLInputElement).value.split(',').map((s) => s.trim())
  const params = { seed, pack: 'generic', theme: 'neon', ...resolveTags(tags) }
  const model = generateSector(params)
  const out = document.getElementById('out')!
  out.innerHTML = ''
  for (const theme of Object.values(themes)) {
    out.insertAdjacentHTML(
      'beforeend',
      `<figure><figcaption>${theme.label}</figcaption>${renderSector(model, theme)}</figure>`,
    )
  }
}

document.getElementById('seed')!.addEventListener('change', draw)
document.getElementById('tags')!.addEventListener('change', draw)
draw()
