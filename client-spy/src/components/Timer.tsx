import { useState, useEffect } from 'react'

export function Timer({ deadline }: { deadline: number }) {
  const [left, setLeft] = useState(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))

  useEffect(() => {
    const iv = setInterval(() => {
      const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setLeft(s)
    }, 500)
    return () => clearInterval(iv)
  }, [deadline])

  const mins = Math.floor(left / 60)
  const secs = left % 60
  const urgent = left <= 30 && left > 0

  return (
    <div style={{
      fontSize: 16, fontWeight: 900, fontFamily: 'monospace',
      color: urgent ? '#f87171' : 'rgba(255,255,255,0.85)',
      animation: urgent ? 'pulse-spy 1s ease-in-out infinite' : 'none',
    }}>
      {mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}с`}
    </div>
  )
}
