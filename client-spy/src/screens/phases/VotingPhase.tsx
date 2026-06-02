import { useGameStore } from '../../store/gameStore'
import { getSocket } from '../../hooks/useSocket'

export function VotingPhase() {
  const { gameState, myIndex } = useGameStore()
  if (!gameState) return null

  const { players, votes, accusedId } = gameState
  const accused = accusedId !== null ? players[accusedId] : null
  const me = players[myIndex]
  const myVote = votes[myIndex]
  const alivePlayers = players.filter(p => p.isAlive)
  const votedCount = alivePlayers.filter(p => votes[p.id] !== undefined).length

  function vote(v: 'for' | 'against') {
    getSocket().emit('action', { type: 'spy_vote', data: { vote: v } })
  }

  const COLORS = ['#7c3aed','#db2777','#059669','#d97706','#2563eb','#dc2626','#0891b2']

  return (
    <div style={{
      height: '100%', overflowY: 'auto', padding: '24px 16px',
      display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center',
    }}>
      {/* Звинувачений */}
      <div className="anim-slide-up spy-card" style={{
        width: '100%', maxWidth: 380, textAlign: 'center',
        background: 'rgba(220,38,38,0.08)', borderColor: 'rgba(220,38,38,0.3)',
      }}>
        <div style={{ fontSize: 12, color: 'var(--spy-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 10 }}>⚖️ Звинувачений</div>
        <div className="spy-avatar" style={{
          width: 64, height: 64, fontSize: 24, background: '#dc2626', margin: '0 auto 10px',
        }}>
          {accused?.name[0]?.toUpperCase() ?? '?'}
        </div>
        <div style={{ fontSize: 22, fontWeight: 900 }}>{accused?.name ?? '—'}</div>
        <div style={{ fontSize: 13, color: 'var(--spy-muted)', marginTop: 6 }}>Проголосуйте чи є він шпигуном</div>
      </div>

      {/* Прогрес голосування */}
      <div style={{ fontSize: 14, color: 'var(--spy-muted)' }}>
        Проголосували: <b style={{ color: 'var(--spy-text)' }}>{votedCount}</b> / {alivePlayers.length}
      </div>

      {/* Кнопки голосування */}
      {me && !myVote ? (
        <div style={{ display: 'flex', gap: 12, width: '100%', maxWidth: 380 }}>
          <button className="spy-btn spy-btn-danger" style={{ flex: 1 }} onClick={() => vote('for')}>
            👎 Так, це шпигун
          </button>
          <button className="spy-btn spy-btn-outline" style={{ flex: 1 }} onClick={() => vote('against')}>
            ✋ Ні, помилка
          </button>
        </div>
      ) : myVote ? (
        <div style={{ fontSize: 15, color: 'var(--spy-muted)', textAlign: 'center' }}>
          {myVote === 'for' ? '👎 Ви проголосували ЗА обвинувачення' : '✋ Ви проголосували ПРОТИ'}
        </div>
      ) : null}

      {/* Хто як голосував */}
      <div style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 12, color: 'var(--spy-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Статус голосів</div>
        {alivePlayers.map((p, i) => {
          const v = votes[p.id]
          return (
            <div key={p.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 12px', borderRadius: 10,
              background: 'rgba(255,255,255,0.04)', border: '1px solid var(--spy-border)',
            }}>
              <div className="spy-avatar" style={{ width: 30, height: 30, fontSize: 12, background: COLORS[i % COLORS.length] }}>
                {p.name[0]?.toUpperCase()}
              </div>
              <span style={{ flex: 1, fontSize: 14, fontWeight: p.id === myIndex ? 700 : 400 }}>{p.name}</span>
              <span style={{ fontSize: 14 }}>
                {v === 'for' ? '👎' : v === 'against' ? '✋' : '⏳'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
