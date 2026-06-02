import { useGameStore } from '../../store/gameStore'
import { getSocket } from '../../hooks/useSocket'

export function SpyGuessPhase() {
  const { gameState, myIndex } = useGameStore()
  if (!gameState) return null

  const { allLocations, players, accusedId } = gameState
  const accused = accusedId !== null ? players[accusedId] : null
  const isAccused = myIndex === accusedId

  function guessLocation(locId: number) {
    getSocket().emit('action', { type: 'spy_location_guess', data: { locationId: locId } })
  }

  return (
    <div style={{
      height: '100%', overflowY: 'auto', padding: '24px 16px',
      display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center',
    }}>
      <div className="anim-slide-up" style={{ textAlign: 'center', maxWidth: 380 }}>
        <div style={{ fontSize: 52, marginBottom: 12 }}>🎯</div>
        <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 8 }}>
          {isAccused ? 'Назвіть локацію!' : `${accused?.name ?? 'Шпигун'} має шанс`}
        </div>
        <div style={{ fontSize: 14, color: 'var(--spy-muted)', lineHeight: 1.6 }}>
          {isAccused
            ? 'У вас є 20 секунд щоб правильно назвати локацію. Якщо вгадаєте — перемога за вами!'
            : 'Шпигуна спіймали. Якщо він вгадає локацію — перемагає попри викриття!'}
        </div>
      </div>

      {isAccused ? (
        <div style={{ width: '100%', maxWidth: 400 }}>
          <div style={{ fontSize: 13, color: 'var(--spy-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 12, textAlign: 'center' }}>
            Виберіть локацію
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {allLocations.map((loc, i) => (
              <button key={i} onClick={() => guessLocation(i)}
                className="spy-btn"
                style={{
                  background: 'rgba(124,58,237,0.1)', border: '1.5px solid rgba(124,58,237,0.3)',
                  color: 'var(--spy-text)', fontSize: 13, padding: '12px 10px',
                  justifyContent: 'flex-start', gap: 8,
                }}>
                <span style={{ fontSize: 20 }}>{loc.emoji}</span>
                <span style={{ textAlign: 'left', lineHeight: 1.3 }}>{loc.name}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{
          padding: '20px 24px', background: 'rgba(255,255,255,0.04)',
          borderRadius: 16, border: '1px solid var(--spy-border)',
          textAlign: 'center', maxWidth: 340,
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⏳</div>
          <div style={{ fontSize: 14, color: 'var(--spy-muted)' }}>Чекаємо відповіді шпигуна...</div>
        </div>
      )}
    </div>
  )
}
