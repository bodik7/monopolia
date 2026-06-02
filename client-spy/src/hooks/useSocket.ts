import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useGameStore } from '../store/gameStore'
import type { SpyState } from '../types/spy'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
    })
  }
  return socket
}

const SESSION_KEY = 'monopolia_session'

function doRejoin(s: Socket) {
  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) {
    const store = useGameStore.getState()
    if (store.screen === 'reconnecting') store.setScreen('lobby')
    return
  }
  try {
    const { code, playerIndex, playerName } = JSON.parse(raw)
    if (!code) { localStorage.removeItem(SESSION_KEY); useGameStore.getState().setScreen('lobby'); return }
    s.emit('rejoin', { code, playerIndex, playerName }, (res: {
      success?: boolean; error?: string; started?: boolean
      state?: SpyState; players?: string[]; bots?: boolean[]
    }) => {
      if (res.error || !res.success) {
        localStorage.removeItem(SESSION_KEY)
        useGameStore.getState().setScreen('lobby')
        return
      }
      const store = useGameStore.getState()
      store.setMyName(playerName)
      if (res.started && res.state) {
        store.setRoom(code, playerIndex, [])
        store.handleGameStarted(res.state)
      } else if (!res.started && res.players) {
        store.setRoom(code, playerIndex, res.players, res.bots)
      }
    })
  } catch {
    localStorage.removeItem(SESSION_KEY)
    useGameStore.getState().setScreen('lobby')
  }
}

export function useSocket() {
  const initialized = useRef(false)
  const { setConnectionStatus, handleStateUpdate, handleGameStarted, handleGameOver } = useGameStore()

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    const s = getSocket()

    s.on('connect', () => {
      setConnectionStatus('connected')
      const raw = localStorage.getItem('spy_auth')
      if (raw) { try { const { token } = JSON.parse(raw); s.emit('authenticate', { token }) } catch {} }
      doRejoin(s)
    })

    s.on('disconnect', () => setConnectionStatus('disconnected'))

    s.on('lobbyUpdate', ({ players, bots, myIndex: newIdx }: { players: string[]; bots?: boolean[]; myIndex?: number }) => {
      useGameStore.getState().setRoomPlayers(players, bots)
      if (newIdx !== undefined) {
        const st = useGameStore.getState()
        if (newIdx !== st.myIndex) useGameStore.setState({ myIndex: newIdx, isHost: newIdx === 0 })
      }
    })

    s.on('stateUpdate',  ({ state }: { state: SpyState }) => handleStateUpdate(state))
    s.on('gameStarted',  ({ state, myPlayerIndex }: { state: SpyState; myPlayerIndex?: number }) => {
      if (myPlayerIndex !== undefined) {
        const st = useGameStore.getState()
        useGameStore.setState({ myIndex: myPlayerIndex, isHost: myPlayerIndex === 0 })
        st.setRoom(st.roomCode, myPlayerIndex, st.roomPlayers)
      }
      handleGameStarted(state)
    })
    s.on('gameOver',   ({ state }: { state: SpyState }) => handleGameOver(state))
    s.on('roomClosed', () => { if (!useGameStore.getState().leavingToHub) useGameStore.getState().reset() })
    s.on('kicked',     () => useGameStore.getState().reset())
    s.on('error',      (msg: string) => useGameStore.getState().setError(typeof msg === 'string' ? msg : 'Помилка сервера'))
    s.on('chatMessage', (m: { name: string; text: string; color: string; icon?: string }) => {
      useGameStore.getState().addChatMessage(m)
    })

    const onVisible = () => { if (document.visibilityState === 'visible' && !s.connected) s.connect() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [setConnectionStatus, handleStateUpdate, handleGameStarted, handleGameOver])

  return getSocket()
}
