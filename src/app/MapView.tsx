import { useRef, useState } from 'react'

export function MapView({ svg }: { svg: string }) {
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const drag = useRef<{ x: number; y: number } | null>(null)

  return (
    <div
      style={{ flex: 1, overflow: 'hidden', cursor: drag.current ? 'grabbing' : 'grab' }}
      onWheel={(e) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
        setView((v) => ({ ...v, zoom: Math.min(20, Math.max(0.2, v.zoom * factor)) }))
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX - view.x, y: e.clientY - view.y }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        setView((v) => ({ ...v, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }))
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <div
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
