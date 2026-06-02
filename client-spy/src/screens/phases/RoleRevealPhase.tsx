import { useState } from 'react'
import { useGameStore } from '../../store/gameStore'
import { getSocket } from '../../hooks/useSocket'

export function RoleRevealPhase() {
  const { gameState, myIndex } = useGameStore()
  const [revealed, setRevealed] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  if (!gameState) return null

  const { iAmSpy, myRole, locationName, locationEmoji, players } = gameState
  const me = players[myIndex]
  const readyCount = players.filter(p => p.ready).length

  function confirm() {
    setConfirmed(true)
    getSocket().emit('action', { type: 'spy_ready', data: {} })
  }

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '24px 20px', gap: 24,
    }}>
      {/* Картка ролі */}
      <div
        className="anim-slide-up"
        onClick={() => !revealed && setRevealed(true)}
        style={{
          width: '100%', maxWidth: 340,
          background: revealed
            ? iAmSpy
              ? 'linear-gradient(135deg, rgba(220,38,38,0.2), rgba(127,29,29,0.1))'
              : 'linear-gradient(135deg, rgba(124,58,237,0.2), rgba(49,46,129,0.1))'
            : 'rgba(255,255,255,0.12)',
          border: `2px solid ${revealed
            ? (iAmSpy ? 'rgba(220,38,38,0.5)' : 'rgba(124,58,237,0.5)')
            : 'rgba(255,255,255,0.25)'}`,
          borderRadius: 24, padding: '36px 28px',
          textAlign: 'center', cursor: revealed ? 'default' : 'pointer',
          transition: 'all 0.4s',
          boxShadow: revealed
            ? `0 8px 40px ${iAmSpy ? 'rgba(220,38,38,0.2)' : 'rgba(124,58,237,0.2)'}`
            : '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)',
        }}
      >
        {!revealed ? (
          <>
            <div style={{ fontSize: 64, marginBottom: 16 }}>🃏</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--spy-muted)' }}>Натисніть щоб переглянути картку</div>
            <div style={{ fontSize: 12, color: 'var(--spy-muted)', marginTop: 8, opacity: 0.6 }}>Переконайтесь що інші не дивляться!</div>
          </>
        ) : iAmSpy ? (
          <>
            <div style={{ fontSize: 72, marginBottom: 16 }}>🕵️</div>
            <div style={{ fontSize: 24, fontWeight: 900, color: '#f87171', marginBottom: 8 }}>ВИ — ШПИГУН!</div>
            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>
              Локація невідома. Слухайте уважно,<br />щоб її вгадати. Не видайте себе!
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 48, marginBottom: 8 }}>{locationEmoji || '📍'}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--spy-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Локація</div>
            <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 20 }}>{locationName}</div>
            <div style={{ width: '100%', height: 1, background: 'var(--spy-border)', marginBottom: 20 }} />
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--spy-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Ваша роль</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: '#c4b5fd' }}>{myRole}</div>
          </>
        )}
      </div>

      {/* Статус готовності */}
      <div style={{ fontSize: 13, color: 'var(--spy-muted)' }}>
        Готові: {readyCount} / {players.length}
      </div>

      {/* Кнопка підтвердження */}
      {revealed && !confirmed && (
        <button className="spy-btn spy-btn-primary anim-fade-in" style={{ maxWidth: 340 }} onClick={confirm}>
          ✅ Я переглянув, почати гру
        </button>
      )}
      {confirmed && (
        <div style={{ fontSize: 14, color: 'var(--spy-muted)', textAlign: 'center' }}>
          ✅ Готово! Чекаємо на інших...
        </div>
      )}

      {/* Ім'я персонажа */}
      {me && (
        <div style={{ fontSize: 13, color: 'var(--spy-muted)' }}>
          Ви граєте за: <b style={{ color: 'var(--spy-text)' }}>{me.name}</b>
        </div>
      )}
    </div>
  )
}
