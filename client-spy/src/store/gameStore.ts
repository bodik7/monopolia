import { create } from 'zustand'
import type { SpyState, ChatMsg } from '../types/spy'

type Screen = 'lobby' | 'waiting' | 'game' | 'reconnecting'
type ConnStatus = 'connected' | 'disconnected'

interface GameStore {
  screen: Screen
  connStatus: ConnStatus
  roomCode: string
  myIndex: number
  myName: string
  isHost: boolean
  roomPlayers: string[]
  roomBots: boolean[]
  gameState: SpyState | null
  chat: ChatMsg[]
  error: string | null
  leavingToHub: boolean

  setScreen: (s: Screen) => void
  setConnectionStatus: (s: ConnStatus) => void
  setRoom: (code: string, idx: number, players: string[], bots?: boolean[]) => void
  setRoomPlayers: (players: string[], bots?: boolean[]) => void
  setMyName: (name: string) => void
  setError: (e: string | null) => void
  addChatMessage: (msg: ChatMsg) => void

  handleGameStarted: (state: SpyState) => void
  handleStateUpdate: (state: SpyState) => void
  handleGameOver:    (state: SpyState) => void
  reset: () => void
}

export const useGameStore = create<GameStore>((set, get) => ({
  screen:      'lobby',
  connStatus:  'disconnected',
  roomCode:    '',
  myIndex:     -1,
  myName:      '',
  isHost:      false,
  roomPlayers: [],
  roomBots:    [],
  gameState:   null,
  chat:        [],
  error:       null,
  leavingToHub: false,

  setScreen:           s  => set({ screen: s }),
  setConnectionStatus: s  => set({ connStatus: s }),
  setMyName:           n  => set({ myName: n }),
  setError:            e  => set({ error: e }),

  setRoom: (code, idx, players, bots = []) => set({
    roomCode: code,
    myIndex:  idx,
    isHost:   idx === 0,
    roomPlayers: players,
    roomBots: bots,
    screen: 'waiting',
  }),

  setRoomPlayers: (players, bots = []) => set({ roomPlayers: players, roomBots: bots }),

  addChatMessage: msg => set(s => ({ chat: [...s.chat.slice(-99), msg] })),

  handleGameStarted: state => {
    set({ gameState: state, screen: 'game', chat: [] })
  },

  handleStateUpdate: state => {
    set({ gameState: state })
    if (state.phase === 'result' && get().screen === 'game') {
      // stay on game screen — result is shown within game
    }
  },

  handleGameOver: state => {
    set({ gameState: state, screen: 'game' })
  },

  reset: () => set({
    screen: 'lobby',
    roomCode: '',
    myIndex: -1,
    isHost: false,
    roomPlayers: [],
    roomBots: [],
    gameState: null,
    chat: [],
    error: null,
    leavingToHub: false,
  }),
}))
