import { useGameStore } from '../../store/gameStore'
import { getSocket } from '../../hooks/useSocket'

export function ResultPhase() {
  const { gameState, myIndex, isHost } = useGameStore()
  if (!gameState) return null

  const { winner, players, locationName, locationEmoji, iAmSpy } = gameState
  const iWon = winner === 'spy' ? iAmSpy : !iAmSpy
  const spies = players.filter(p => p.isSpy)
  const town  = players.filter(p => !p.isSpy)

  const COLORS = ['#7c3aed','#db2777','#059669','#d97706','#2563eb','#dc2626','#0891b2']

  function leaveRoom() {
    localStorage.removeItem('monopolia_session')
    getSocket().emit('leaveRoom')
    useGameStore.getState().reset()
  }

  return (
    <div style={{
      height: '100%', overflowY: 'auto', padding: '24px 16px',
      display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center',
    }}>
      {/* Результат */}
      <div className="anim-slide-up" style={{
        textAlign: 'center', padding: '28px 24px', width: '100%', maxWidth: 380, borderRadius: 24,
        background: iWon
          ? 'linear-gradient(135deg, rgba(22,163,74,0.2), rgba(5,150,105,0.1))'
          : 'linear-gradient(135deg, rgba(220,38,38,0.15), rgba(127,29,29,0.08))',
        border: `2px solid ${iWon ? 'rgba(22,163,74,0.4)' : 'rgba(220,38,38,0.3)'}`,
      }}>
        <div style={{ fontSize: 64, marginBottom: 12 }}>
          {iWon ? '🏆' : '💀'}
        </div>
        <div style={{ fontSize: 24, fontWeight: 900, marginBottom: 6 }}>
          {iWon ? 'Ви перемогли!' : 'Ви програли'}
        </div>
        <div style={{ fontSize: 14, color: 'var(--spy-muted)' }}>
          {winner === 'spy' ? '🕵️ Перемога шпигуна!' : '🏙️ Перемога мирних!'}
        </div>
      </div>

      {/* Локація розкрита */}
      <div className="spy-card" style={{ width: '100%', maxWidth: 380, textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--spy-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>Секретна локація</div>
        <div style={{ fontSize: 40, marginBottom: 8 }}>{locationEmoji}</div>
        <div style={{ fontSize: 22, fontWeight: 900 }}>{locationName}</div>
      </div>

      {/* Шпигун(и) */}
      <div className="spy-card" style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ fontSize: 12, color: '#f87171', fontWeight: 700, textTransform: 'uppercase', marginBottom: 12 }}>
          🕵️ Шпигун(и)
        </div>
        {spies.map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div className="spy-avatar" style={{ width: 36, height: 36, fontSize: 14, background: '#dc2626' }}>
              {p.name[0]?.toUpperCase()}
            </div>
            <span style={{ fontWeight: p.id === myIndex ? 900 : 600 }}>
              {p.name} {p.id === myIndex && <span style={{ color: 'var(--spy-muted)', fontSize: 11 }}>· ви</span>}
            </span>
          </div>
        ))}
        <div style={{ width: '100%', height: 1, background: 'var(--spy-border)', margin: '12px 0' }} />
        <div style={{ fontSize: 12, color: 'var(--spy-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 12 }}>
          🏙️ Мирні та їх ролі
        </div>
        {town.map((p, idx) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div className="spy-avatar" style={{ width: 36, height: 36, fontSize: 14, background: COLORS[idx % COLORS.length] }}>
              {p.name[0]?.toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: p.id === myIndex ? 900 : 600, fontSize: 14 }}>
                {p.name} {p.id === myIndex && <span style={{ color: 'var(--spy-muted)', fontSize: 11 }}>· ви</span>}
              </div>
              <div style={{ fontSize: 12, color: '#c4b5fd' }}>{p.role}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Кнопки */}
      <div style={{ width: '100%', maxWidth: 380, display: 'flex', gap: 10 }}>
        {isHost && (
          <button className="spy-btn spy-btn-primary" style={{ flex: 1 }}
            onClick={() => getSocket().emit('restartGame')}>
            🔄 Реванш
          </button>
        )}
        <button className="spy-btn spy-btn-outline" style={{ flex: 1 }} onClick={leaveRoom}>
          🏠 Вийти
        </button>
      </div>
    </div>
  )
}
