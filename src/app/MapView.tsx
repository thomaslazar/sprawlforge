import { useEffect, useRef, useState } from 'react'
import { t } from './strings'

export function MapView({
  svg,
  busy,
  onZoom,
}: {
  svg: string
  busy?: boolean
  onZoom?: (zoom: number) => void
}) {
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  // drag state itself lives in the ref above (read/written mid-gesture
  // without a re-render); this just flips the cursor style at drag start/end
  const [dragging, setDragging] = useState(false)
  // synchronous zoom mirror: wheel handlers read/write it directly, so rapid
  // events compound correctly and the updater below never reads mutable state
  const zoomRef = useRef(1)
  // onZoom triggers a labelZoom band re-render in the parent (SVG rebuild);
  // debounce it trailing ~150ms so a wheel gesture settles before that
  // happens, instead of rebuilding on every band crossing mid-scroll. The
  // transform itself (view.zoom, below) stays synchronous — only this
  // callback is delayed.
  const zoomDebounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(zoomDebounce.current), [])

  return (
    <div
      style={{
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        cursor: dragging ? 'grabbing' : 'default',
      }}
      onWheel={(e) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
        const oldZoom = zoomRef.current
        const zoom = Math.min(20, Math.max(0.2, oldZoom * factor))
        zoomRef.current = zoom
        // anchor zoom to the cursor: keep the world point under it fixed on
        // screen — c.x - (c.x - view.x) * (newZoom/oldZoom), same for y
        const rect = e.currentTarget.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const ratio = zoom / oldZoom
        setView((v) => ({ x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio, zoom }))
        clearTimeout(zoomDebounce.current)
        zoomDebounce.current = setTimeout(() => onZoom?.(zoom), 150)
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX - view.x, y: e.clientY - view.y }
        setDragging(true)
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        // read the ref NOW — the updater runs later, possibly after pointerup
        // has nulled it, and a throw during render unmounts the whole app
        const x = e.clientX - drag.current.x
        const y = e.clientY - drag.current.y
        setView((v) => ({ ...v, x, y }))
      }}
      onPointerUp={() => {
        drag.current = null
        setDragging(false)
      }}
    >
      <div
        className="map-viewport"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          transformOrigin: '0 0',
          width: '100%',
          height: '100%',
          willChange: 'transform',
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {busy && (
        // pointerEvents: 'none' — a generation in flight must never block
        // pan/drag on the (still visible, now slightly dimmed) previous map
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.35)',
            color: '#fff',
            fontSize: 18,
            pointerEvents: 'none',
          }}
        >
          {t.overlay.generating}
        </div>
      )}
    </div>
  )
}
