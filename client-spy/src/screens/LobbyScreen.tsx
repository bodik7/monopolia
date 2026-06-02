import { useState } from 'react'
import { useGameStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'

const SESSION_KEY = 'monopolia_session'

export function LobbyScreen() {
  const { error, setError, setRoom, setMyName } = useGameStore()
  const [name, setName]       = useState('')
  const [code, setCode]       = useState('')
  const [tab, setTab]         = useState<'create' | 'join'>('create')
  const [loading, setLoading] = useState(false)

  function saveSession(roomCode: string, playerIndex: number, playerName: string) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ code: roomCode, playerIndex, playerName }))
    localStorage.setItem('spy_auth', localStorage.getItem('monopolia_auth') || '')
  }

  function createRoom() {
    const n = name.trim()
    if (!n) { setError('Введіть ваше ім\'я'); return }
    setLoading(true); setError(null)
    const s = getSocket()
    s.emit('createRoom', { gameType: 'spy', playerName: n }, (res: { code?: string; playerIndex?: number; error?: string }) => {
      setLoading(false)
      if (res.error) { setError(res.error); return }
      setMyName(n)
      saveSession(res.code!, res.playerIndex!, n)
      setRoom(res.code!, res.playerIndex!, [n])
    })
  }

  function joinRoom() {
    const n = name.trim(), c = code.trim().toUpperCase()
    if (!n) { setError('Введіть ваше ім\'я'); return }
    if (!c) { setError('Введіть код кімнати'); return }
    setLoading(true); setError(null)
    const s = getSocket()
    s.emit('joinRoom', { code: c, playerName: n }, (res: { playerIndex?: number; players?: string[]; error?: string }) => {
      setLoading(false)
      if (res.error) { setError(res.error); return }
      setMyName(n)
      saveSession(c, res.playerIndex!, n)
      setRoom(c, res.playerIndex!, res.players || [])
    })
  }

  return (
    <div className="spy-screen" style={{ alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}>
      <div style={{ width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Header */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 64, lineHeight: 1, marginBottom: 12 }}>🕵️</div>
          <h1 style={{ fontSize: 28, fontWeight: 900, marginBottom: 4 }}>Шпигун</h1>
          <p style={{ fontSize: 13, color: 'var(--spy-muted)' }}>Знайди шпигуна серед гравців</p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 4 }}>
          {(['create', 'join'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                flex: 1, padding: '9px 0', borderRadius: 9, border: 'none', cursor: 'pointer',
                fontWeight: 700, fontSize: 14, transition: 'all 0.2s',
                background: tab === t ? 'rgba(124,58,237,0.8)' : 'transparent',
                color: tab === t ? 'white' : 'var(--spy-muted)',
              }}>
              {t === 'create' ? '🏠 Створити' : '🔗 Приєднатись'}
            </button>
          ))}
        </div>

        {/* Form */}
        <div className="spy-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--spy-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Ваше ім'я</label>
            <input value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (tab === 'create' ? createRoom() : joinRoom())}
              placeholder="Як вас звати?"
              maxLength={20}
              style={{
                width: '100%', marginTop: 6, padding: '11px 14px', borderRadius: 10,
                background: 'rgba(255,255,255,0.07)', border: '1px solid var(--spy-border)',
                color: 'white', fontSize: 15, outline: 'none',
              }}
            />
          </div>
          {tab === 'join' && (
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--spy-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Код кімнати</label>
              <input value={code} onChange={e => setCode(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && joinRoom()}
                placeholder="CITY-1234"
                maxLength={20}
                style={{
                  width: '100%', marginTop: 6, padding: '11px 14px', borderRadius: 10,
                  background: 'rgba(255,255,255,0.07)', border: '1px solid var(--spy-border)',
                  color: 'white', fontSize: 15, outline: 'none', fontFamily: 'monospace',
                }}
              />
            </div>
          )}
          {error && <div style={{ fontSize: 13, color: '#f87171', background: 'rgba(220,38,38,0.1)', padding: '8px 12px', borderRadius: 8 }}>{error}</div>}
          <button className="spy-btn spy-btn-primary" onClick={tab === 'create' ? createRoom : joinRoom} disabled={loading}>
            {loading ? '...' : tab === 'create' ? '🕵️ Створити кімнату' : '🔗 Приєднатись'}
          </button>
        </div>

        <button className="spy-btn spy-btn-outline" onClick={() => location.replace('/')}>
          ← Назад до лобі
        </button>
      </div>
    </div>
  )
}
