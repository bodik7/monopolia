export type Phase =
  | 'role_reveal'
  | 'discussion'
  | 'voting'
  | 'spy_guess'
  | 'result'

export interface SpyPlayer {
  id: number
  name: string
  isBot: boolean
  avatarId: string | null
  avatarColor: string
  ready: boolean
  isAlive: boolean
  isSpy: boolean      // only revealed in 'result'
  role: string | null // only revealed in 'result'
}

export interface LocationHint {
  name: string
  emoji: string
}

export interface SpyState {
  gameType: 'spy'
  phase: Phase
  locationEmoji: string | null
  locationName: string | null
  allLocations: LocationHint[]
  myRole: string | null
  iAmSpy: boolean
  players: SpyPlayer[]
  votes: Record<number, 'for' | 'against'>
  accusedId: number | null
  winner: 'spy' | 'town' | null
  log: string[]
  timer: number | null
}

export interface ChatMsg {
  name: string
  text: string
  color: string
  icon?: string
}
