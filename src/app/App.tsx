import { useEffect, useMemo, useRef, useState } from 'react'
import type { SectorModel, SectorParams } from '../gen/types'
import { renderSector } from '../render/svg'
import { getTheme } from '../render/theme'
import type { GenRequest, GenResponse } from './genWorker'
import { KnobPanel } from './KnobPanel'
import { SHAPE_NAMES } from '../gen/lots/shapes'
import { useName } from '../gen/lots/uses'
import { describeAt, type Pick } from './inspect'
import { t } from './strings'
import { MapView } from './MapView'
import { stateFromSearch, stateToSearch, type AppState } from './params'
import { materializeTags, resolveTags, type Tag } from './tags'

// ponytail: crypto.getRandomValues is the one non-seeded random — first-visit seed only
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

const cap = (x: string) => x[0].toUpperCase() + x.slice(1)

export function App() {
  // `applied` drives the visible map + URL. `pendingTags` is the chip
  // staging area — clicking a chip only ever touches this. Reroll is the
  // sole place pendingTags flows into applied (see terrain-v2 tag-staging).
  const [applied, setApplied] = useState<AppState>(() => {
    const loaded = stateFromSearch(window.location.search, randomSeed())
    return { ...loaded, tags: materializeTags(loaded.seed, loaded.tags) }
  })
  const [pendingTags, setPendingTags] = useState<Tag[]>(applied.tags)
  // display-only, session-scoped (no URL persistence): toggling re-renders
  // the SVG from the existing model with pois filtered out — zero regen
  // off by default until the POI rework (ROADMAP: too many, clustered);
  // revert to true in that round
  const [showPois, setShowPois] = useState(false)
  // export-only knob, session-scoped like showPois — never part of the URL
  const [pngScale, setPngScale] = useState(2)

  // generation runs in a worker (off the main thread) — model is null until
  // the first reply lands, so the initial load shows the busy overlay
  // instead of a blank/frozen page. Each request carries an id; a reply
  // whose id doesn't match the latest sent request is a stale straggler
  // from a superseded params change and is dropped.
  const [model, setModel] = useState<SectorModel | null>(null)
  const [busy, setBusy] = useState(true)
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    const worker = new Worker(new URL('./genWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<GenResponse>) => {
      if (e.data.id !== requestIdRef.current) return
      setModel(e.data.model)
      setBusy(false)
    }
    workerRef.current = worker
    return () => worker.terminate()
  }, [])

  // three seed/tag actions, all routed through the same worker (see the
  // genParams effect below) — see KnobPanel for what each does:
  // Reroll = new random seed AND every tag group freshly re-rolled from it
  // (materializeTags from an empty set — the same full surprise-me roll a
  // bare URL gets), staged tags are discarded, not kept;
  // Update = same seed, apply staged tags as-is;
  // Dice = new random seed, tag set untouched.
  const reroll = () => {
    const seed = randomSeed()
    const tags = materializeTags(seed, [])
    setPendingTags(tags)
    update({ ...applied, tags, seed })
  }
  const applyUpdate = () => {
    const tags = materializeTags(applied.seed, pendingTags)
    setPendingTags(tags)
    update({ ...applied, tags })
  }
  const rerollSeed = () => update({ ...applied, seed: randomSeed() })

  useEffect(() => {
    window.history.replaceState(null, '', stateToSearch(applied))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (s: AppState) => {
    setApplied(s)
    window.history.replaceState(null, '', stateToSearch(s))
  }

  // theme is a render-side concern only (see SectorParams) — keyed apart
  // from the generation-relevant fields so a theme switch never re-runs the
  // generator (M5: it used to regenerate the whole sector on every swap)
  const genParams = useMemo(
    () => ({ seed: applied.seed, pack: applied.pack, ...resolveTags(applied.tags) }),
    [applied.seed, applied.pack, applied.tags],
  )
  const params: SectorParams = useMemo(
    () => ({ ...genParams, theme: applied.theme }),
    [genParams, applied.theme],
  )

  // generation itself only depends on genParams — post to the worker on
  // change, tagging the request so a stale reply (superseded by a newer
  // params change before it comes back) never clobbers a fresher one
  useEffect(() => {
    const id = ++requestIdRef.current
    setBusy(true)
    workerRef.current?.postMessage({ id, params: genParams } satisfies GenRequest)
  }, [genParams])

  // semantic zoom: labels re-render per zoom band (1|2|4|8) so more of them
  // fit as you zoom in; generation itself never re-runs for this
  const [labelZoom, setLabelZoom] = useState(1)
  // memoized so the {...model} spread doesn't mint a new object every App
  // re-render while POIs are hidden (would invalidate the svg memo below)
  const visibleModel = useMemo(
    () => (model ? (showPois ? model : { ...model, pois: [] }) : null),
    [model, showPois],
  )
  const svg = useMemo(
    () => (visibleModel ? renderSector(visibleModel, getTheme(params.theme), { labelZoom, interactive: true }) : ''),
    [visibleModel, params.theme, labelZoom],
  )

  // click-to-inspect popover; Escape or a click on bare ground closes it
  const [pick, setPick] = useState<{ pick: Pick; at: { x: number; y: number } } | null>(null)
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPick(null)
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])
  useEffect(() => setPick(null), [model])
  const onPick = (p: { x: number; y: number }, at: { x: number; y: number }) => {
    const r = model && describeAt(model, p)
    setPick(r && (r.building || r.lot || r.arcology || r.megablock) ? { pick: r, at } : null)
  }

  const exportName = `sprawlforge-sector-${params.seed}`
  // ponytail: jspdf pulls ~688kB into the main chunk — defer the whole
  // exports module to the click that actually needs it
  const onExport = async (kind: 'svg' | 'png' | 'pdf') => {
    if (!visibleModel) return
    const m = await import('./exports')
    // exports always use base label sizing, independent of viewport zoom;
    // WYSIWYG — exports match what's on screen, POIs included or not
    const exportSvg = renderSector(visibleModel, getTheme(params.theme))
    switch (kind) {
      case 'svg':
        m.downloadSvg(exportSvg, exportName)
        break
      case 'png':
        await m.downloadPng(exportSvg, pngScale, exportName)
        break
      case 'pdf':
        await m.downloadPdf(exportSvg, exportName)
        break
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', margin: 0 }}>
      <KnobPanel
        applied={applied}
        pendingTags={pendingTags}
        busy={busy}
        showPois={showPois}
        pngScale={pngScale}
        onChange={update}
        onPendingTagsChange={setPendingTags}
        onReroll={reroll}
        onUpdate={applyUpdate}
        onDice={rerollSeed}
        onShowPoisChange={setShowPois}
        onPngScaleChange={setPngScale}
        onExport={onExport}
      />
      <MapView
        svg={svg}
        busy={busy}
        onPick={onPick}
        onZoom={(z) => setLabelZoom(Math.min(8, Math.max(1, 2 ** Math.floor(Math.log2(z)))))}
      />
      {pick && (
        <div
          data-popover
          style={{
            position: 'fixed',
            left: Math.min(pick.at.x + 12, window.innerWidth - 272),
            top: Math.min(pick.at.y + 12, window.innerHeight - 140),
            maxWidth: 260,
            padding: '6px 10px',
            font: '13px/1.4 system-ui, sans-serif',
            background: '#fff',
            color: '#111',
            border: '1px solid #888',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            pointerEvents: 'none',
          }}
        >
          {pick.pick.arcology || pick.pick.megablock ? (
            <>
              <div><b>{pick.pick.arcology ? t.inspect.arcology : t.inspect.megablock}</b></div>
              <div>{(pick.pick.arcology ?? pick.pick.megablock)!.name}</div>
              {pick.pick.arcology && <div>{t.inspect.design}: {pick.pick.arcology.design} · {t.inspect.access}: {pick.pick.arcology.access}</div>}
            </>
          ) : (
            <>
              <div>
                <b>{pick.pick.building && pick.pick.block && pick.pick.district ? cap(useName(pick.pick.building, pick.pick.block, pick.pick.district)) : t.inspect.noBuilding}</b>
              </div>
              {pick.pick.building && <div>{`${pick.pick.building.shape} ${SHAPE_NAMES[pick.pick.building.shape] ?? ''}`.trim()}</div>}
              {pick.pick.block && <div>{t.inspect.fabric}: {pick.pick.block.style}</div>}
              {pick.pick.lot && !pick.pick.building && <div>{t.inspect.lot}: {pick.pick.lot.kind}</div>}
            </>
          )}
          {pick.pick.district && <div>{t.inspect.district}: {pick.pick.district.name} ({pick.pick.district.zone})</div>}
        </div>
      )}
    </div>
  )
}
