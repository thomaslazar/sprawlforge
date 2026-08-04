import { useRef, useState } from 'react'

export function MapView({ svg, onZoom }: { svg: string; onZoom?: (zoom: number) => void }) {
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  // synchronous zoom mirror: wheel handlers read/write it directly, so rapid
  // events compound correctly and the updater below never reads mutable state
  const zoomRef = useRef(1)

  return (
    <div
      style={{ flex: 1, overflow: 'hidden', cursor: drag.current ? 'grabbing' : 'grab' }}
      onWheel={(e) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
        const zoom = Math.min(20, Math.max(0.2, zoomRef.current * factor))
        zoomRef.current = zoom
        setView((v) => ({ ...v, zoom }))
        onZoom?.(zoom)
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
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}
