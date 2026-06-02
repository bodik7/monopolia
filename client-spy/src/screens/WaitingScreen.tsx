import { useGameStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'

export function WaitingScreen() {
  const { roomCode, roomPlayers, roomBots, myIndex, isHost } = useGameStore()

  const inviteUrl = `${location.origin}/?join=${roomCode}`

  function copyLink() {
    navigator.clipboard.writeText(inviteUrl).catch(() => {})
  }

  function startGame() {
    getSocket().emit('startGame', {})
  }

  function leaveRoom() {
    localStorage.removeItem('monopolia_session')
    getSocket().emit('leaveRoom')
    useGameStore.getState().reset()
  }

  const allPlayers = roomPlayers.map((name, i) => ({ name, isBot: roomBots[i] || false }))
  const canStart = isHost && allPlayers.length >= 3

  return (
    <div className="spy-screen" style={{ alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
      <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 16 }}>

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>⏳</div>
          <h2 style={{ fontSize: 22, fontWeight: 900 }}>Зала очікування</h2>
          <p style={{ fontSize: 13, color: 'var(--spy-muted)', marginTop: 4 }}>Поділіться посиланням — чекаємо гравців</p>
        </div>

        {/* Invite */}
        <div className="spy-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--spy-muted)', fontWeight: 700, textTransform: 'uppercase' }}>📎 Посилання</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{inviteUrl}</div>
          <button className="spy-btn spy-btn-outline" style={{ padding: '9px' }} onClick={copyLink}>📋 Скопіювати</button>
        </div>

        {/* Players */}
        <div className="spy-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Гравці</span>
            <span style={{ fontSize: 12, color: 'var(--spy-muted)' }}>{allPlayers.length}/10</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {allPlayers.map((p, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'rgba(255,255,255,0.04)', borderRadius: 10 }}>
                <div className="spy-avatar" style={{ width: 32, height: 32, fontSize: 13, background: 'var(--spy-accent)' }}>
                  {p.isBot ? '🤖' : p.name[0]?.toUpperCase()}
                </div>
                <span style={{ fontSize: 14, fontWeight: i === myIndex ? 700 : 400 }}>
                  {p.name} {i === myIndex && <span style={{ color: 'var(--spy-muted)', fontSize: 11 }}>· ви</span>}
                  {i === 0 && <span style={{ color: '#fbbf24', fontSize: 11 }}> · хост</span>}
                </span>
                {p.isBot && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--spy-muted)' }}>бот</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        {isHost ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="spy-btn spy-btn-primary" onClick={startGame} disabled={!canStart}>
              {canStart ? '🕵️ Почати гру' : `Потрібно ще ${3 - allPlayers.length} гравців`}
            </button>
          </div>
        ) : (
          <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--spy-muted)', padding: '12px 0' }}>
            ⏳ Чекаємо поки хост почне гру...
          </div>
        )}

        <button className="spy-btn spy-btn-outline" style={{ fontSize: 13 }} onClick={leaveRoom}>
          ← Вийти
        </button>
      </div>
    </div>
  )
}
