import { useEffect, useMemo, useState } from 'react'
import { generateSector } from '../gen/sector/generate'
import { hashSeed } from '../gen/rng'
import type { SectorParams } from '../gen/types'
import { renderSector } from '../render/svg'
import { getTheme } from '../render/theme'
import { downloadPdf, downloadPng, downloadSvg } from './exports'
import { KnobPanel } from './KnobPanel'
import { MapView } from './MapView'
import { paramsFromSearch, paramsToSearch } from './params'

// ponytail: crypto.getRandomValues is the one non-seeded random — first-visit seed only
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

export function App() {
  const [params, setParams] = useState<SectorParams>(() =>
    paramsFromSearch(window.location.search, randomSeed()),
  )

  useEffect(() => {
    window.history.replaceState(null, '', paramsToSearch(params))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (p: SectorParams) => {
    setParams(p)
    window.history.replaceState(null, '', paramsToSearch(p))
  }

  const svg = useMemo(() => {
    const model = generateSector(params)
    return renderSector(model, getTheme(params.theme))
  }, [params])

  const exportName = `sprawlforge-sector-${params.seed}`
  const onExport = (kind: 'svg' | 'png' | 'pdf') => {
    if (kind === 'svg') downloadSvg(svg, exportName)
    if (kind === 'png') void downloadPng(svg, 2, exportName)
    if (kind === 'pdf') void downloadPdf(svg, exportName)
  }

  return (
    <div style={{ display: 'flex', height: '100vh', margin: 0 }}>
      <KnobPanel
        params={params}
        onChange={update}
        onReroll={() => update({ ...params, seed: hashSeed(params.seed, 'reroll') })}
        onExport={onExport}
      />
      <MapView svg={svg} />
    </div>
  )
}
