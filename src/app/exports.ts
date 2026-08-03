import { jsPDF } from 'jspdf'
import 'svg2pdf.js'

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadSvg(svg: string, name: string): void {
  download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`)
}

export async function downloadPng(svg: string, scale: number, name: string): Promise<void> {
  const px = 2048 * scale
  const img = new Image()
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = px
    canvas.height = px
    canvas.getContext('2d')!.drawImage(img, 0, 0, px, px)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png'),
    )
    download(blob, `${name}.png`)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function downloadPdf(svg: string, name: string): Promise<void> {
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  // A4 landscape in mm: 297 x 210; fit square map into page height with margins
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const side = 190
  await doc.svg(el, { x: (297 - side) / 2, y: 10, width: side, height: side })
  doc.save(`${name}.pdf`)
}
