import { useSocket }       from './hooks/useSocket'
import { useGameStore }    from './store/gameStore'
import { LobbyScreen }     from './screens/LobbyScreen'
import { WaitingScreen }   from './screens/WaitingScreen'
import { GameScreen }      from './screens/GameScreen'

export default function App() {
  useSocket()
  const screen = useGameStore(s => s.screen)

  // Reconnecting overlay
  const connStatus = useGameStore(s => s.connStatus)
  if (connStatus === 'disconnected' && screen === 'game') {
    return (
      <div className="spy-screen" style={{ alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <div style={{ fontSize: 48 }}>📡</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Відновлення зв'язку...</div>
        <div style={{ fontSize: 13, color: 'var(--spy-muted)' }}>Зачекайте, підключаємось до сервера</div>
      </div>
    )
  }

  if (screen === 'lobby')   return <LobbyScreen />
  if (screen === 'waiting') return <WaitingScreen />
  if (screen === 'game')    return <GameScreen />

  return <LobbyScreen />
}
