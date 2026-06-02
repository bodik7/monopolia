import { useState, useRef, useEffect } from 'react'
import { useGameStore } from '../../store/gameStore'
import { getSocket } from '../../hooks/useSocket'

export function DiscussionPhase() {
  const { gameState, myIndex, chat } = useGameStore()
  const [tab, setTab]           = useState<'players' | 'chat'>('players')
  const [msg, setMsg]           = useState('')
  const [accuseOpen, setAccuseOpen] = useState(false)
  const chatRef = useRef<HTMLDivElement>(null)
  if (!gameState) return null

  const { players, iAmSpy, locationName, locationEmoji, allLocations, myRole } = gameState
  const me = players[myIndex]
  const alivePlayers = players.filter(p => p.isAlive)

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [chat])

  function sendMsg() {
    const t = msg.trim()
    if (!t) return
    getSocket().emit('chatMessage', { text: t, name: me?.name || '?', color: '#a855f7', icon: iAmSpy ? '🕵️' : '👤' })
    setMsg('')
  }

  function accuse(targetId: number) {
    setAccuseOpen(false)
    getSocket().emit('action', { type: 'spy_accuse', data: { targetId } })
  }

  function guessLocation(locId: number) {
    getSocket().emit('action', { type: 'spy_location_guess', data: { locationId: locId } })
  }

  const PLAYER_COLORS = ['#7c3aed','#db2777','#059669','#d97706','#2563eb','#dc2626','#0891b2','#65a30d']

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>

      {/* Моя роль — зверху компактно */}
      <div style={{
        padding: '8px 16px', background: 'rgba(0,0,0,0.3)',
        borderBottom: '1px solid var(--spy-border)', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        {iAmSpy ? (
          <div style={{ fontSize: 13 }}>
            <span style={{ color: '#f87171', fontWeight: 700 }}>🕵️ Шпигун</span>
            <span style={{ color: 'var(--spy-muted)', marginLeft: 8, fontSize: 12 }}>Знайдіть локацію</span>
          </div>
        ) : (
          <div style={{ fontSize: 13 }}>
            <span style={{ color: 'var(--spy-muted)' }}>{locationEmoji} </span>
            <span style={{ fontWeight: 700 }}>{locationName}</span>
            <span style={{ color: '#c4b5fd', marginLeft: 8 }}>· {myRole}</span>
          </div>
        )}
        <button
          onClick={() => setAccuseOpen(true)}
          style={{
            background: 'rgba(220,38,38,0.15)', border: '1px solid rgba(220,38,38,0.4)',
            color: '#f87171', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}>
          ⚖️ Звинуватити
        </button>
      </div>

      {/* Таби */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--spy-border)', flexShrink: 0 }}>
        {(['players', 'chat'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: '9px 0', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
            background: 'transparent', color: tab === t ? 'var(--spy-text)' : 'var(--spy-muted)',
            borderBottom: `2px solid ${tab === t ? 'var(--spy-accent2)' : 'transparent'}`,
            transition: 'all 0.2s',
          }}>
            {t === 'players' ? `👥 Гравці (${alivePlayers.length})` : '💬 Чат'}
          </button>
        ))}
      </div>

      {/* Контент вкладок */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {tab === 'players' && (
          <div style={{ height: '100%', overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {alivePlayers.map((p, i) => (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px', borderRadius: 12,
                background: p.id === myIndex ? 'rgba(124,58,237,0.12)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${p.id === myIndex ? 'rgba(124,58,237,0.3)' : 'var(--spy-border)'}`,
              }}>
                <div className="spy-avatar" style={{ width: 38, height: 38, fontSize: 15, background: PLAYER_COLORS[i % PLAYER_COLORS.length] }}>
                  {p.name[0]?.toUpperCase()}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>
                    {p.name}
                    {p.id === myIndex && <span style={{ color: 'var(--spy-muted)', fontSize: 11, marginLeft: 6 }}>· ви</span>}
                    {!p.ready && <span style={{ color: 'var(--spy-muted)', fontSize: 10, marginLeft: 6 }}>⏳</span>}
                  </div>
                </div>
              </div>
            ))}
            {/* Шпигун: список локацій для підказки */}
            {iAmSpy && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, color: 'var(--spy-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 10 }}>🗺️ Можливі локації</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {allLocations.map((loc, i) => (
                    <button key={i} onClick={() => guessLocation(i)}
                      style={{
                        background: 'rgba(255,255,255,0.05)', border: '1px solid var(--spy-border)',
                        borderRadius: 10, padding: '8px 6px', fontSize: 11, cursor: 'pointer',
                        color: 'var(--spy-text)', textAlign: 'center', transition: 'all 0.15s',
                        lineHeight: 1.3, minHeight: 44, display: 'flex', alignItems: 'center',
                        justifyContent: 'center', gap: 4, flexDirection: 'column',
                      }}>
                      <span style={{ fontSize: 18 }}>{loc.emoji}</span>
                      <span style={{ fontSize: 10 }}>{loc.name}</span>
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'var(--spy-muted)', textAlign: 'center', marginTop: 8 }}>
                  Натисніть на локацію щоб розкритись і вгадати
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'chat' && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div ref={chatRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {chat.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--spy-muted)', fontSize: 13, marginTop: 20 }}>
                  Чат порожній. Починайте обговорення!
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 14, flexShrink: 0, paddingTop: 1 }}>{m.icon || '👤'}</div>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: m.color || 'var(--spy-accent2)' }}>{m.name}: </span>
                    <span style={{ fontSize: 13, color: 'var(--spy-text)' }}>{m.text}</span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ padding: '10px 12px', borderTop: '1px solid var(--spy-border)', display: 'flex', gap: 8 }}>
              <input value={msg} onChange={e => setMsg(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendMsg()}
                placeholder="Написати..."
                maxLength={200}
                style={{
                  flex: 1, background: 'rgba(255,255,255,0.07)', border: '1px solid var(--spy-border)',
                  borderRadius: 10, padding: '10px 12px', color: 'white', fontSize: 16, outline: 'none',
                }}
              />
              <button onClick={sendMsg} style={{
                background: 'var(--spy-accent)', border: 'none', borderRadius: 10, padding: '0 14px',
                color: 'white', fontSize: 18, cursor: 'pointer',
              }}>➤</button>
            </div>
          </div>
        )}
      </div>

      {/* Модаль звинувачення */}
      {accuseOpen && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10,
          display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
        }} onClick={() => setAccuseOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#111122', borderRadius: '20px 20px 0 0',
            padding: 20, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '60vh', overflowY: 'auto',
          }}>
            <div style={{ fontSize: 16, fontWeight: 900, textAlign: 'center', marginBottom: 4 }}>Звинуватити кого?</div>
            {alivePlayers.filter(p => p.id !== myIndex).map((p, i) => (
              <button key={p.id} onClick={() => accuse(p.id)} className="spy-btn" style={{
                background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)',
                color: '#f87171', justifyContent: 'flex-start', gap: 10,
              }}>
                <div className="spy-avatar" style={{ width: 32, height: 32, fontSize: 13, background: PLAYER_COLORS[i % PLAYER_COLORS.length] }}>
                  {p.name[0]?.toUpperCase()}
                </div>
                {p.name}
              </button>
            ))}
            <button className="spy-btn spy-btn-outline" style={{ marginTop: 4, fontSize: 13 }} onClick={() => setAccuseOpen(false)}>
              Скасувати
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
