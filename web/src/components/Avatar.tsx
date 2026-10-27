interface AvatarProps {
  emoji: string
  color: string
  size?: number
  glow?: boolean
}

/** Uploaded avatars (data URLs) and http(s) links render as images. */
export const isImageAvatar = (value: string) => /^(data:image\/|https?:\/\/)/i.test(value)

export function Avatar({ emoji, color, size = 38, glow = false }: AvatarProps) {
  return (
    <span
      className={`avatar${glow ? ' avatar-glow' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        background: `linear-gradient(140deg, ${color}2e, ${color}0d)`,
        borderColor: `${color}66`,
        boxShadow: glow ? `0 0 0 3px ${color}22, 0 0 18px ${color}44` : undefined,
      }}
    >
      {isImageAvatar(emoji) ? <img src={emoji} alt="" draggable={false} /> : emoji || '🤖'}
    </span>
  )
}
