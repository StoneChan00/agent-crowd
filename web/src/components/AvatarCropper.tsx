import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Modal } from './Modal'

/** Crop viewport size, px (the square the user positions over the image). */
const VIEW = 288
/** Exported avatar size, px — matches what every avatar surface renders. */
const OUT = 128
/** Zoom ceiling relative to the cover fit. */
const ZOOM_HEADROOM = 8

interface Offset {
  x: number
  y: number
}

interface AvatarCropperProps {
  imageSrc: string
  onCancel: () => void
  onConfirm: (dataUrl: string) => void
}

function coverOf(img: HTMLImageElement): number {
  return Math.max(VIEW / img.width, VIEW / img.height)
}

/**
 * Drag-to-position + zoom avatar cropper. The square stage IS the final
 * avatar: the image can be dragged and zoomed (wheel or slider) but can
 * never leave the frame, and confirming exports exactly the visible region
 * as a 128px PNG data URL — the same avatar field every surface renders.
 */
export function AvatarCropper({ imageSrc, onCancel, onConfirm }: AvatarCropperProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState('')
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; origin: Offset } | null>(null)

  /** Smallest scale that still covers the stage; doubles as the slider min. */
  const cover = image ? coverOf(image) : 1
  const maxScale = cover * ZOOM_HEADROOM

  const clampOffset = (value: Offset, at: number): Offset => {
    if (!image) return value
    return {
      x: Math.min(0, Math.max(VIEW - image.width * at, value.x)),
      y: Math.min(0, Math.max(VIEW - image.height * at, value.y)),
    }
  }

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      setImage(img)
      const base = coverOf(img)
      setScale(base)
      setOffset({ x: (VIEW - img.width * base) / 2, y: (VIEW - img.height * base) / 2 })
    }
    img.onerror = () => setError('无法读取这张图片')
    img.src = imageSrc
  }, [imageSrc])

  // Wheel zoom needs a native non-passive listener, or preventDefault() is
  // ignored (React attaches wheel handlers passively at the root) and the
  // page scrolls while zooming.
  useEffect(() => {
    const node = stageRef.current
    if (!node || !image) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = node.getBoundingClientRect()
      const next = Math.min(maxScale, Math.max(cover, scale * Math.exp(-event.deltaY * 0.0015)))
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const k = next / scale
      setScale(next)
      setOffset(
        clampOffset({ x: anchor.x - (anchor.x - offset.x) * k, y: anchor.y - (anchor.y - offset.y) * k }, next),
      )
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [image, scale, offset, cover, maxScale])

  const zoomTo = (next: number) => {
    const target = Math.min(maxScale, Math.max(cover, next))
    const k = target / scale
    const anchor = { x: VIEW / 2, y: VIEW / 2 }
    setScale(target)
    setOffset(clampOffset({ x: anchor.x - (anchor.x - offset.x) * k, y: anchor.y - (anchor.y - offset.y) * k }, target))
  }

  const reset = () => {
    if (!image) return
    const base = coverOf(image)
    setScale(base)
    setOffset({ x: (VIEW - image.width * base) / 2, y: (VIEW - image.height * base) / 2 })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { startX: event.clientX, startY: event.clientY, origin: offset }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setOffset(
      clampOffset(
        { x: drag.origin.x + (event.clientX - drag.startX), y: drag.origin.y + (event.clientY - drag.startY) },
        scale,
      ),
    )
  }
  const endDrag = () => {
    dragRef.current = null
  }

  const confirm = () => {
    if (!image) return
    const canvas = document.createElement('canvas')
    canvas.width = OUT
    canvas.height = OUT
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setError('无法处理这张图片')
      return
    }
    // Invert the stage transform (translate + scale, origin 0 0) to get the
    // source rect in image pixels; clamping guarantees it stays in bounds.
    ctx.drawImage(image, -offset.x / scale, -offset.y / scale, VIEW / scale, VIEW / scale, 0, 0, OUT, OUT)
    onConfirm(canvas.toDataURL('image/png'))
  }

  return (
    <Modal
      title="调整头像"
      subtitle="拖动图片调整位置 · 滚轮或滑杆缩放 · 方框内即最终效果"
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-ghost" onClick={reset} disabled={!image}>
            重置
          </button>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-primary" onClick={confirm} disabled={!image}>
            用这张
          </button>
        </>
      }
    >
      {error ? (
        <div className="form-error">{error}</div>
      ) : (
        <div className="crop-body">
          <div
            ref={stageRef}
            className="crop-stage"
            style={{ width: VIEW, height: VIEW, cursor: image ? 'grab' : 'default' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {image && (
              <img
                src={imageSrc}
                alt=""
                draggable={false}
                className="crop-img"
                style={{
                  width: image.width,
                  height: image.height,
                  transformOrigin: '0 0',
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                }}
              />
            )}
            <div className="crop-frame" />
          </div>
          <div className="crop-slider-row">
            <span className="crop-slider-label">缩放</span>
            <input
              type="range"
              min={Math.round(cover * 100)}
              max={Math.round(maxScale * 100)}
              value={Math.round(scale * 100)}
              onChange={(event) => zoomTo(Number(event.target.value) / 100)}
              disabled={!image}
              aria-label="缩放"
            />
          </div>
        </div>
      )}
    </Modal>
  )
}
