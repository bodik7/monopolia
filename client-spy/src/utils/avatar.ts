export function avatarInitial(name: string): string {
  return (name?.[0] ?? '?').toUpperCase()
}

export function renderAvatar(
  _avatarId: string | null,
  color: string,
  name: string,
  size = 36,
): string {
  const initial = avatarInitial(name)
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-weight:900;font-size:${Math.round(size * 0.4)}px;color:#fff;flex-shrink:0">${initial}</div>`
}
