import { useGameStore } from '../store/gameStore'
import { RoleRevealPhase }  from './phases/RoleRevealPhase'
import { DiscussionPhase }  from './phases/DiscussionPhase'
import { VotingPhase }      from './phases/VotingPhase'
import { SpyGuessPhase }    from './phases/SpyGuessPhase'
import { ResultPhase }      from './phases/ResultPhase'
import { Timer }            from '../components/Timer'

export function GameScreen() {
  const gameState = useGameStore(s => s.gameState)
  if (!gameState) return null
  const { phase, timer } = gameState

  return (
    <div className="spy-screen">
      {/* Хедер */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', background: 'rgba(0,0,0,0.4)',
        borderBottom: '1px solid var(--spy-border)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>🕵️</span>
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: 0.5 }}>ШПИГУН</span>
        </div>
        {timer && phase !== 'role_reveal' && phase !== 'result' && (
          <Timer deadline={timer} />
        )}
        <div style={{ fontSize: 12, color: 'var(--spy-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {phase === 'role_reveal'  && 'Картка'}
          {phase === 'discussion'   && 'Обговорення'}
          {phase === 'voting'       && 'Голосування'}
          {phase === 'spy_guess'    && 'Вгадування'}
          {phase === 'result'       && 'Результат'}
        </div>
      </div>

      {/* Контент */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {phase === 'role_reveal' && <RoleRevealPhase />}
        {phase === 'discussion'  && <DiscussionPhase />}
        {phase === 'voting'      && <VotingPhase />}
        {phase === 'spy_guess'   && <SpyGuessPhase />}
        {phase === 'result'      && <ResultPhase />}
      </div>
    </div>
  )
}
