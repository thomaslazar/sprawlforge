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
        cursor: drag.current ? 'grabbing' : 'grab',
      }}
      onWheel={(e) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
        const zoom = Math.min(20, Math.max(0.2, zoomRef.current * factor))
        zoomRef.current = zoom
        setView((v) => ({ ...v, zoom }))
        clearTimeout(zoomDebounce.current)
        zoomDebounce.current = setTimeout(() => onZoom?.(zoom), 150)
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX - view.x, y: e.clientY - view.y }
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
      onPointerUp={() => (drag.current = null)}
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
