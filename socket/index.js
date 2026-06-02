// ============================================
// Socket.io обробники подій
// ============================================
const jwt = require('jsonwebtoken');
const db  = require('../db');
const { JWT_SECRET }       = require('../config');
const { rateLimit }        = require('../middleware/auth');
const makeGameActionHandler = require('./gameActions');

const _activeSessions = new Map();

function isStr(v, max = 100) { return typeof v === 'string' && v.trim().length > 0 && v.length <= max; }

module.exports = function registerSocketHandlers(io, roomStore, gameCtx) {
    const {
        // Monopoly
        createGameState, processAction, sanitize, addLog, nextPlayer,
        awardAuction, clearTurnTimer, clearTradeTimer, startTurnTimer, startTradeTimer,
        // Tysyacha
        createTysyachaState, processTysyachaAction, sanitizeTysyacha,
        clearTysyachaTimer, startTysyachaTimer, emitTysyachaUpdate,
        // Durak
        createDurakState, processDurakAction, sanitizeDurak, emitDurakUpdate, dStartTurnTimer,
        // Bunker
        createBunkerState, sanitizeBunker, emitBunkerUpdate, processBunkerAction,
        startBunkerPhase, startBunkerRound, clearBunkerTimer, resolveBunkerVoting,
        addBunkerLog, BUNKER_ATTR_LABELS, BOT_NAMES,
        // Mafia
        createMafiaState, sanitizeMafia, emitMafiaUpdate, processMafiaAction,
        startNightPhase, startVotingPhase, resolveVoting,
        MAFIA_ROLE_LABELS, MAFIA_BALANCE, getMafiaBotDecisions,
    } = gameCtx;

    const handleGameAction = makeGameActionHandler(io, roomStore, gameCtx);

    function generateCode() {
        const cities = ['KYIV', 'LVIV', 'ODESA', 'KHARKIV', 'DNIPRO', 'ZAPORIZHZHIA'];
        let code;
        do {
            code = cities[Math.floor(Math.random() * cities.length)] + '-' + (Math.floor(Math.random() * 9000) + 1000);
        } while (roomStore.has(code));
        return code;
    }

    function emitLobbyUpdate(room) {
        if (room.started) return;
        const payload = {
            players:  room.players.map(p => p.name),
            bots:     room.players.map(p => !!p.isBot),
            gameType: room.gameType,
            avatars:  room.players.map(p => ({ avatarId: p.avatarId || null, avatarColor: p.avatarColor || '#1a56db' })),
            ready:    room.ready ? [...room.ready] : [],
            settings: room.pendingSettings || null,
        };
        // Bug 4: send each player their updated index so client myIndex stays in sync after reshuffles
        room.players.forEach(p => {
            if (!p.socketId) return;
            const s = io.sockets.sockets.get(p.socketId);
            if (s) s.emit('lobbyUpdate', { ...payload, myIndex: p.index });
        });
    }

    io.on('connection', (socket) => {
        console.log('+ підключення:', socket.id);

        // Глобальний flood-захист: не більше 60 подій/с з одного сокета
        socket.use(([event], next) => {
            if (!rateLimit(`flood:${socket.id}`, 60, 1_000)) {
                console.warn(`[flood] ${socket.id} перевищив ліміт подій (event: ${event})`);
                return;
            }
            next();
        });

        socket.on('authenticate', async ({ token }) => {
            try {
                const payload = jwt.verify(token, JWT_SECRET);
                socket.username = payload.username;
                const prevId = _activeSessions.get(payload.username);
                if (prevId && prevId !== socket.id) {
                    const prevSocket = io.sockets.sockets.get(prevId);
                    if (prevSocket) {
                        prevSocket.emit('duplicateSession');
                        prevSocket.disconnect(true);
                    }
                }
                _activeSessions.set(payload.username, socket.id);
                const user = await db.getUser(payload.username);
                socket.avatarId    = user?.avatar_id    || null;
                socket.avatarColor = user?.avatar_color || '#1a56db';
                socket.isAdmin     = Number(user?.is_admin) === 1;
            } catch {}
        });

        socket.on('createRoom', ({ playerName, gameType = 'monopoly' }, cb) => {
            if (!isStr(playerName, 30)) return;
            const code  = generateCode();
            const gtype = ['tysyacha','mafia','durak','bunker','monopoly'].includes(gameType) ? gameType : 'monopoly';
            const room  = {
                code,
                players: [{ socketId: socket.id, name: playerName, index: 0, username: socket.username || null, avatarId: socket.avatarId || null, avatarColor: socket.avatarColor || '#1a56db' }],
                started: false, state: null, gameType: gtype,
                ready: new Set(), spectators: new Set(),
                createdAt: Date.now(), lastActivityAt: Date.now(),
            };
            roomStore.set(code, room);
            socket.join(code);
            socket.roomCode = code;
            socket.playerIndex = 0;
            console.log(`Кімната ${code} створена`);
            cb({ code, playerIndex: 0, gameType: gtype });
            emitLobbyUpdate(room);
        });

        socket.on('peekRoom', ({ code }, cb) => {
            if (!isStr(code, 20)) return cb({ error: 'not_found' });
            const room = roomStore.get(code.toUpperCase());
            if (!room) return cb({ error: 'not_found' });
            const maxPlayers = { tysyacha: 3, mafia: 15, durak: 6, bunker: 15, monopoly: 6 }[room.gameType] || 6;
            cb({ players: room.players.length, max: maxPlayers, gameType: room.gameType, started: room.started });
        });

        socket.on('joinRoom', ({ code, playerName }, cb) => {
            if (!isStr(code, 20) || !isStr(playerName, 30)) return cb({ error: 'Невірні дані' });
            const room = roomStore.get(code);
            if (!room)        return cb({ error: 'Кімнату не знайдено' });
            if (room.started) return cb({ error: 'Гра вже почалась' });
            const maxPlayers = { tysyacha: 3, mafia: 15, durak: 6, bunker: 15, monopoly: 6 }[room.gameType] || 6;
            if (room.players.length >= maxPlayers) return cb({ error: `Кімната повна (макс ${maxPlayers})` });
            const idx = room.players.length;
            room.players.push({ socketId: socket.id, name: playerName, index: idx, username: socket.username || null, avatarId: socket.avatarId || null, avatarColor: socket.avatarColor || '#1a56db' });
            socket.join(code);
            socket.roomCode = code;
            socket.playerIndex = idx;
            emitLobbyUpdate(room);
            cb({ code, playerIndex: idx, gameType: room.gameType });
        });

        socket.on('leaveRoom', () => {
            const room = roomStore.get(socket.roomCode);
            if (!room) return;

            if (socket.isSpectator) {
                room.spectators?.delete(socket.id);
                socket.leave(socket.roomCode);
                socket.roomCode = null;
                socket.isSpectator = false;
                return;
            }

            if (room.started && room.state?.gameType === 'bunker') {
                const remainingHumans = room.players.filter(p => !p.isBot && p.index !== socket.playerIndex);
                if (remainingHumans.length === 0) {
                    clearBunkerTimer(room);
                    io.to(socket.roomCode).emit('roomClosed', { reason: 'Усі гравці покинули гру' });
                    roomStore.delete(socket.roomCode);
                }
                socket.leave(socket.roomCode);
                socket.roomCode = null;
                socket.playerIndex = null;
                return;
            }

            if (room.started) return;

            if (socket.playerIndex === 0) {
                io.to(socket.roomCode).emit('roomClosed', { reason: 'Хост покинув кімнату' });
                room.players.forEach(p => {
                    const s = io.sockets.sockets.get(p.socketId);
                    if (s) { s.leave(socket.roomCode); s.roomCode = null; s.playerIndex = null; }
                });
                roomStore.delete(socket.roomCode);
            } else {
                const leavingIdx = socket.playerIndex;
                room.players = room.players.filter(p => p.index !== leavingIdx);
                room.players.forEach((p, i) => { p.index = i; });
                room.players.forEach(p => {
                    const s = io.sockets.sockets.get(p.socketId);
                    if (s) s.playerIndex = p.index;
                });
                const newReady = new Set();
                room.players.forEach(p => { if (room.ready.has(p.index + (p.index >= leavingIdx ? 1 : 0))) newReady.add(p.index); });
                room.ready = newReady;
                socket.leave(socket.roomCode);
                socket.roomCode = null;
                socket.playerIndex = null;
                emitLobbyUpdate(room);
            }
        });

        socket.on('abandonGame', () => {
            const code = socket.roomCode;
            const room = roomStore.get(code);
            if (!room) return;
            const name = room.players[socket.playerIndex]?.name || 'Гравець';
            io.to(code).emit('gameAbandoned', { reason: `${name} достроково завершив(ла) гру` });
            room.players.forEach(p => {
                const s = io.sockets.sockets.get(p.socketId);
                if (s) { s.leave(code); s.roomCode = null; s.playerIndex = null; }
            });
            roomStore.delete(code);
        });

        socket.on('surrenderMonopoly', () => {
            const code = socket.roomCode;
            const room = roomStore.get(code);
            if (!room || !room.started) return;
            const state = room.state;
            if (!state || state.gameType === 'tysyacha') return;
            const pidx   = socket.playerIndex;
            const player = state.players[pidx];
            if (!player || player.bankrupt) return;
            player.properties.forEach(pos => {
                state.cellState[pos].owner = null;
                state.cellState[pos].houses = 0;
                state.cellState[pos].mortgaged = false;
            });
            player.properties = [];
            player.money = 0;
            player.bankrupt = true;
            state.pendingAction = null;
            state.pendingData   = null;
            state.pendingRent   = null;
            addLog(state, `🏳️ ${player.name} здав(ла)ся. Власність повернута банку.`, 'error');
            if (state.currentPlayerIndex === pidx) {
                state.hasRolled = false;
                state.doublesCount = 0;
                nextPlayer(state);
            }
            socket.emit('surrendered');
            socket.leave(code);
            socket.roomCode = null;
            socket.playerIndex = null;
            clearTurnTimer(room);
            clearTradeTimer(room);
            const alive = state.players.filter(p => !p.bankrupt);
            if (alive.length === 1) {
                addLog(state, `🏆 ${alive[0].name} — переможець!`, 'success');
                db.saveGameStats(room, rp => alive[0].name === state.players[rp.index]?.name);
                db.saveGameHistory('monopoly', alive[0].name, state.round || 0,
                    room.players.filter(p => p.username).map(rp => ({
                        username: rp.username, name: rp.name,
                        won: alive[0].name === state.players[rp.index]?.name,
                    }))
                );
                db.deleteRoom(room.code);
                io.to(code).emit('gameOver', { winner: alive[0], state: sanitize(state) });
                roomStore.cleanup(code);
                return;
            }
            startTurnTimer(room);
            io.to(code).emit('stateUpdate', {
                state: sanitize(state), sideEffect: null,
                toast: { text: `🏳️ ${player.name} здав(ла)ся`, color: '#c62828' },
            });
        });

        socket.on('dayChatMsg', ({ text }) => {
            if (!rateLimit(`chat:${socket.id}`, 5, 8_000)) return;
            const room = roomStore.get(socket.roomCode);
            if (!room?.state || room.state.gameType !== 'mafia') return;
            if (room.state.phase !== 'day_discussion' && room.state.phase !== 'day_voting') return;
            const player = room.state.players[socket.playerIndex];
            if (!player?.isAlive || player.isSilenced) return;
            const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
            io.to(socket.roomCode).emit('dayChatMsg', {
                playerId: socket.playerIndex,
                name: esc(player.name),
                text: esc(String(text || '').slice(0, 200)),
                round: room.state.round,
            });
        });

        socket.on('deadChat', ({ text }) => {
            if (!rateLimit(`chat:${socket.id}`, 5, 8_000)) return;
            const room = roomStore.get(socket.roomCode);
            if (!room?.state || room.state.gameType !== 'mafia') return;
            const player = room.state.players[socket.playerIndex];
            if (!player || player.isAlive) return;
            const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
            const msg = { name: esc(player.name), text: esc(String(text || '').slice(0, 200)) };
            room.players.filter(rp => !room.state.players[rp.index]?.isAlive)
                .forEach(rp => io.to(rp.socketId).emit('deadChat', msg));
        });

        socket.on('mafiaChat', ({ text }) => {
            if (!rateLimit(`chat:${socket.id}`, 5, 8_000)) return;
            const room = roomStore.get(socket.roomCode);
            if (!room?.state || room.state.gameType !== 'mafia') return;
            if (room.state.phase !== 'night') return;
            const player = room.state.players[socket.playerIndex];
            if (!player?.isAlive || MAFIA_ROLE_LABELS[player.role]?.faction !== 'mafia') return;
            const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
            io.to(`${socket.roomCode}_mafia`).emit('mafiaChat', {
                playerId: socket.playerIndex,
                name: esc(player.name),
                text: esc(String(text || '').slice(0, 200)),
            });
        });

        socket.on('getRooms', (cb) => {
            const _maxP = { tysyacha: 3, mafia: 15, durak: 6, bunker: 15, monopoly: 6 };
            const available = roomStore.all()
                .filter(r => !r.started && r.players.length > 0 && r.players.length < (_maxP[r.gameType] || 6))
                .map(r => ({
                    code: r.code, playerCount: r.players.length,
                    hostName: r.players[0].name, gameType: r.gameType || 'monopoly',
                }));
            cb({ rooms: available });
        });

        socket.on('getActiveRooms', (cb) => {
            const active = roomStore.all()
                .filter(r => r.started && r.state && (r.gameType !== 'mafia' || socket.isAdmin))
                .map(r => ({
                    code: r.code, gameType: r.gameType,
                    playerCount: r.players.filter(p => !p.isBot).length,
                    playerNames: r.players.filter(p => !p.isBot).map(p => p.name),
                    avatars:     r.players.filter(p => !p.isBot).map(p => ({ avatarId: p.avatarId || null, avatarColor: p.avatarColor || '#1a56db' })),
                    canSpectate: true,
                }));
            cb({ rooms: active });
        });

        socket.on('kickPlayer', ({ kickIndex }) => {
            if (typeof kickIndex !== 'number') return;
            const room = roomStore.get(socket.roomCode);
            if (!room || room.started || socket.playerIndex !== 0) return;
            const kicked = room.players.find(p => p.index === kickIndex);
            if (!kicked) return;
            io.to(kicked.socketId).emit('kicked', { reason: 'Вас видалив хост' });
            const kickedSocket = io.sockets.sockets.get(kicked.socketId);
            if (kickedSocket) { kickedSocket.leave(socket.roomCode); kickedSocket.roomCode = null; kickedSocket.playerIndex = null; }
            room.players = room.players.filter(p => p.index !== kickIndex);
            room.players.forEach((p, i) => { p.index = i; });
            room.ready.delete(kickIndex);
            room.ready = new Set([...room.ready].map(i => i > kickIndex ? i - 1 : i));
            room.players.forEach(p => {
                const s = io.sockets.sockets.get(p.socketId);
                if (s) s.playerIndex = p.index;
            });
            emitLobbyUpdate(room);
        });

        socket.on('addBot', () => {
            const room = roomStore.get(socket.roomCode);
            if (!room || socket.playerIndex !== 0 || room.started) return;
            if (room.gameType !== 'bunker' && room.gameType !== 'mafia') return;
            if (room.players.length >= 15) return;
            const usedNames = new Set(room.players.map(p => p.name));
            const botName   = BOT_NAMES.find(n => !usedNames.has(n)) || `Бот-АІ-${room.players.length}`;
            const idx = room.players.length;
            room.players.push({ name: botName, index: idx, socketId: null, isBot: true });
            emitLobbyUpdate(room);
        });

        socket.on('removeBot', () => {
            const room = roomStore.get(socket.roomCode);
            if (!room || socket.playerIndex !== 0 || room.started) return;
            const last = room.players[room.players.length - 1];
            if (!last?.isBot) return;
            room.players.pop();
            emitLobbyUpdate(room);
        });

        socket.on('setReady', ({ ready }) => {
            const room = roomStore.get(socket.roomCode);
            if (!room || room.started) return;
            const idx = socket.playerIndex;
            if (idx === 0) return;
            if (ready) room.ready.add(idx);
            else room.ready.delete(idx);
            emitLobbyUpdate(room);
        });

        socket.on('updateSettings', (newSettings) => {
            const room = roomStore.get(socket.roomCode);
            if (!room || socket.playerIndex !== 0) return;
            room.settings = { ...(room.settings || {}), ...newSettings };
        });

        // Бункер: хост оновлює налаштування до старту — транслюємо всім
        socket.on('updateLobbySettings', ({ scenarioId, timerEnabled } = {}) => {
            const room = roomStore.get(socket.roomCode);
            if (!room || room.started || socket.playerIndex !== 0) return;
            room.pendingSettings = {
                scenarioId:   scenarioId   ?? null,
                timerEnabled: timerEnabled ?? true,
            };
            emitLobbyUpdate(room);
        });

        socket.on('startGame', ({ settings } = {}) => {
            const room = roomStore.get(socket.roomCode);
            if (!room || socket.playerIndex !== 0) return;

            if (room.gameType === 'mafia') {
                const n = room.players.length;
                if (!MAFIA_BALANCE[n]) return io.to(socket.id).emit('error', `Мафія: потрібно 5–15 гравців (зараз ${n})`);
                room.started = true;
                if (settings) room.settings = { ...(room.settings || {}), ...settings };
                room.state = createMafiaState(room.players, room.settings || {});
                const mafiaIds = room.state.mafiaIds;
                room.players.forEach(rp => {
                    if (!rp.socketId) return;
                    const s = io.sockets.sockets.get(rp.socketId);
                    if (s && mafiaIds.includes(rp.index)) s.join(`${room.code}_mafia`);
                    io.to(rp.socketId).emit('gameStarted', { state: sanitizeMafia(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'mafia' });
                });
                getMafiaBotDecisions(room);
                setTimeout(() => { if (room.state?.phase === 'role_reveal') startNightPhase(room); }, 25000);
            } else if (room.gameType === 'durak') {
                const n = room.players.length;
                if (n < 2 || n > 6) return io.to(socket.id).emit('error', 'Дурак: потрібно 2–6 гравців');
                room.started = true;
                if (settings) room.settings = { ...(room.settings || {}), ...settings };
                room.state = createDurakState(room.players, room.settings || {});
                dStartTurnTimer(room);
                room.players.forEach(rp => { io.to(rp.socketId).emit('gameStarted', { state: sanitizeDurak(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'durak' }); });
            } else if (room.gameType === 'tysyacha') {
                if (room.players.length < 2 || room.players.length > 3) return io.to(socket.id).emit('error', 'Тисяча: потрібно 2 або 3 гравці');
                room.started = true;
                room.state = createTysyachaState(room.players);
                room.players.forEach(rp => { io.to(rp.socketId).emit('gameStarted', { state: sanitizeTysyacha(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'tysyacha' }); });
                startTysyachaTimer(room);
            } else if (room.gameType === 'bunker') {
                const n = room.players.length;
                if (n < 4 || n > 15) return io.to(socket.id).emit('error', 'Бункер: потрібно 4–15 гравців');
                room.started = true;
                if (settings) room.settings = { ...(room.settings || {}), ...settings };
                room.state = createBunkerState(room.players, room.settings || {});
                room.players.forEach(rp => { io.to(rp.socketId).emit('gameStarted', { state: sanitizeBunker(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'bunker' }); });
                startBunkerPhase(room, 'game_start');
            } else {
                if (room.players.length < 2) return io.to(socket.id).emit('error', 'Потрібно мінімум 2 гравці');
                room.started = true;
                room.state = createGameState(room.players);
                addLog(room.state, `🎮 Гра почалась! Перший хід: ${room.state.players[0].name}`, 'success');
                startTurnTimer(room);
                io.to(socket.roomCode).emit('gameStarted', { state: sanitize(room.state), gameType: 'monopoly' });
            }
        });

        socket.on('restartGame', () => {
            const room = roomStore.get(socket.roomCode);
            if (!room) return;

            // Voting: host can restart immediately; others add a vote
            if (socket.playerIndex !== 0) {
                if (!room.restartVotes) room.restartVotes = new Set();
                room.restartVotes.add(socket.playerIndex);
                const needed = Math.ceil(room.players.length / 2);
                io.to(socket.roomCode).emit('restartVoteUpdate', {
                    votes: room.restartVotes.size,
                    total: room.players.length,
                    needed,
                });
                if (room.restartVotes.size < needed) return;
                room.restartVotes.clear();
            } else {
                if (room.restartVotes) room.restartVotes.clear();
            }

            // Скидаємо AFK-таймери з попередньої гри
            if (room.afkTimers) {
                Object.values(room.afkTimers).forEach(t => clearTimeout(t));
                room.afkTimers = {};
            }

            const gameType = room.state?.gameType || room.gameType;
            if (gameType === 'durak') {
                room.state = createDurakState(room.players, room.settings || {});
                room.started = true;
                dStartTurnTimer(room);
                room.players.forEach(rp => { io.to(rp.socketId).emit('gameStarted', { state: sanitizeDurak(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'durak' }); });
            } else if (gameType === 'tysyacha') {
                clearTysyachaTimer(room);
                room.state = createTysyachaState(room.players);
                room.started = true;
                room.players.forEach(rp => { io.to(rp.socketId).emit('gameStarted', { state: sanitizeTysyacha(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'tysyacha' }); });
                startTysyachaTimer(room);
            } else if (gameType === 'mafia') {
                clearTimeout(room.nightTimer); clearTimeout(room.dayTimer);
                clearTimeout(room.voteTimer);  clearTimeout(room.morningTimer);
                room.state = createMafiaState(room.players, room.settings || {});
                room.started = true;
                const mafiaIds = room.state.mafiaIds;
                room.players.forEach(rp => {
                    if (!rp.socketId) return;
                    const s = io.sockets.sockets.get(rp.socketId);
                    if (s && mafiaIds.includes(rp.index)) s.join(`${room.code}_mafia`);
                    io.to(rp.socketId).emit('gameStarted', { state: sanitizeMafia(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'mafia' });
                });
                setTimeout(() => { if (room.state?.phase === 'role_reveal') startNightPhase(room); }, 25000);
            } else if (gameType === 'bunker') {
                clearBunkerTimer(room);
                room.state = createBunkerState(room.players, room.settings || {});
                room.started = true;
                room.players.forEach(rp => { io.to(rp.socketId).emit('gameStarted', { state: sanitizeBunker(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'bunker' }); });
                startBunkerPhase(room, 'game_start');
            } else {
                room.state = createGameState(room.players);
                addLog(room.state, `🎮 Реванш! Перший хід: ${room.state.players[0].name}`, 'success');
                room.started = true;
                startTurnTimer(room);
                io.to(socket.roomCode).emit('gameStarted', { state: sanitize(room.state), gameType: 'monopoly' });
            }
        });

        socket.on('action', ({ type, data }) => {
            if (!isStr(type, 50)) return;
            if (socket.isSpectator || socket.playerIndex == null) return;
            if (!rateLimit(`action:${socket.id}`, 15, 1_000)) return;
            const room = roomStore.get(socket.roomCode);
            if (!room?.state) return;
            handleGameAction(room, type, data || {}, socket.playerIndex, socket.id);
        });

        socket.on('rejoin', ({ code, playerIndex, playerName }, cb) => {
            if (!isStr(code, 20) || typeof playerIndex !== 'number' || !isStr(playerName, 30))
                return cb({ error: 'Невірні дані' });
            const room = roomStore.get(code);
            if (!room) return cb({ error: 'Кімнату не знайдено (можливо сервер перезапускався)' });
            const rp = room.players.find(p => p.index === playerIndex && p.name === playerName);
            if (!rp) return cb({ error: 'Гравця не знайдено в кімнаті' });
            rp.socketId = socket.id;
            socket.join(code);
            socket.roomCode    = code;
            socket.playerIndex = playerIndex;
            if (room.afkTimers?.[playerIndex] !== undefined) {
                clearTimeout(room.afkTimers[playerIndex]);
                delete room.afkTimers[playerIndex];
            }
            if (room.state?.gameType === 'bunker') {
                const sp = room.state.players[playerIndex];
                if (sp) sp.isOnline = true;
            }
            if (room.started && room.state) {
                if (room.state.gameType === 'mafia') {
                    const mafiaIds = room.state.mafiaIds || [];
                    if (mafiaIds.includes(playerIndex)) socket.join(`${code}_mafia`);
                }
                const st = room.state.gameType === 'tysyacha' ? sanitizeTysyacha(room.state, playerIndex)
                         : room.state.gameType === 'mafia'    ? sanitizeMafia(room.state, playerIndex)
                         : room.state.gameType === 'durak'    ? sanitizeDurak(room.state, playerIndex)
                         : room.state.gameType === 'bunker'   ? sanitizeBunker(room.state, playerIndex)
                         : sanitize(room.state);
                cb({ success: true, started: true, state: st, gameType: room.gameType });
                io.to(code).emit('playerReconnected', { playerIndex });
                if (room.state.gameType === 'bunker') emitBunkerUpdate(room);
            } else {
                cb({ success: true, started: false, players: room.players.map(p => p.name), bots: room.players.map(p => p.isBot || false) });
                emitLobbyUpdate(room);
            }
        });

        socket.on('syncState', (cb) => {
            if (typeof cb !== 'function') return;
            const room = socket.roomCode ? roomStore.get(socket.roomCode) : null;
            if (!room?.started || !room.state) return cb({ error: 'no_state' });
            const pidx = socket.playerIndex;
            const st = room.state.gameType === 'tysyacha' ? sanitizeTysyacha(room.state, pidx)
                     : room.state.gameType === 'mafia'    ? sanitizeMafia(room.state, pidx)
                     : room.state.gameType === 'durak'    ? sanitizeDurak(room.state, pidx)
                     : room.state.gameType === 'bunker'   ? sanitizeBunker(room.state, pidx)
                     : sanitize(room.state);
            cb({ state: st });
        });

        socket.on('spectatorJoin', ({ code }, cb) => {
            if (!isStr(code, 20)) return cb({ error: 'not_found' });
            const room = roomStore.get(code.toUpperCase());
            if (!room) return cb({ error: 'not_found' });
            if (!room.started || !room.state) return cb({ error: 'Гра ще не почалась' });
            socket.join(code.toUpperCase());
            socket.roomCode    = code.toUpperCase();
            socket.playerIndex = null;
            socket.isSpectator = true;
            if (!room.spectators) room.spectators = new Set();
            room.spectators.add(socket.id);
            const st = room.gameType === 'mafia'    ? sanitizeMafia(room.state, -1)
                     : room.gameType === 'tysyacha' ? sanitizeTysyacha(room.state, -1)
                     : room.gameType === 'durak'    ? sanitizeDurak(room.state, -1)
                     : room.gameType === 'bunker'   ? sanitizeBunker(room.state, -1)
                     : sanitize(room.state);
            io.to(code.toUpperCase()).emit('spectatorJoined', { name: socket.username || 'Глядач' });
            cb({ success: true, state: st, gameType: room.gameType });
        });

        socket.on('emojiReaction', ({ emoji }) => {
            if (!socket.roomCode) return;
            if (!rateLimit(`emoji:${socket.id}`, 3, 4_000)) return;
            const ALLOWED = ['😂','👍','🔥','💀','❤️','👏','😱','🤔'];
            if (!ALLOWED.includes(emoji)) return;
            const room = roomStore.get(socket.roomCode);
            if (!room) return;
            const name = room.players[socket.playerIndex]?.name || (socket.isSpectator ? '👁' : '?');
            io.to(socket.roomCode).emit('emojiReaction', { emoji, name, playerIndex: socket.playerIndex ?? -1 });
        });

        socket.on('chatMessage', ({ text, icon, name, color }) => {
            if (!socket.roomCode) return;
            if (!rateLimit(`chat:${socket.id}`, 5, 8_000)) return;
            // Сервер-сайд перевірка заглушення (захист від обходу через DevTools)
            const _room = roomStore.get(socket.roomCode);
            if (_room?.state?.gameType === 'bunker') {
                const _p = _room.state.players[socket.playerIndex];
                if (_p?.isSilenced) return;
            }
            const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
            io.to(socket.roomCode).emit('chatMessage', {
                playerIndex: socket.playerIndex,
                icon:  esc(String(icon  || '').slice(0, 10)),
                name:  esc(String(name  || '').slice(0, 30)),
                color: /^#[0-9a-fA-F]{3,6}$/.test(color) ? color : '#888',
                text:  esc(String(text  || '').slice(0, 200)),
            });
        });

        socket.on('lobbyMsg', ({ text }) => {
            if (!socket.roomCode) return;
            if (!rateLimit(`lobbyChat:${socket.id}`, 5, 8_000)) return;
            const room = roomStore.get(socket.roomCode);
            if (!room || room.gameStarted) return;
            const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
            const player = room.players.find(p => p.socketId === socket.id);
            const name   = esc(String(player?.name || socket.playerName || 'Гравець').slice(0, 30));
            io.to(socket.roomCode).emit('lobbyMsg', { name, text: esc(String(text || '').slice(0, 200)) });
        });

        socket.on('disconnect', () => {
            console.log('- відключення:', socket.id);
            if (socket.username && _activeSessions.get(socket.username) === socket.id)
                _activeSessions.delete(socket.username);
            const room = roomStore.get(socket.roomCode);
            if (!room) return;
            if (socket.isSpectator) {
                room.spectators?.delete(socket.id);
                socket.leave(socket.roomCode);
                socket.roomCode = null;
                socket.isSpectator = false;
                return;
            }
            if (room.state?.auctionState) {
                const a = room.state.auctionState;
                a.active = a.active.filter(id => id !== socket.playerIndex);
                if (a.active.length === 0) {
                    addLog(room.state, '🔨 Аукціон скасовано — всі відключились', 'warn');
                    room.state.auctionState = null;
                } else if (a.active.length === 1) {
                    if (a.currentBidder === null) a.currentBidder = a.active[0];
                    awardAuction(room.state, a);
                }
                io.to(socket.roomCode).emit('stateUpdate', { state: sanitize(room.state), sideEffect: null });
            }
            if (room.state?.pendingTrade?.toIdx === socket.playerIndex) {
                clearTradeTimer(room);
                room.state.pendingTrade = null;
                room.state.tradeDeadline = null;
                startTurnTimer(room);
                io.to(socket.roomCode).emit('stateUpdate', {
                    state: sanitize(room.state), sideEffect: null,
                    toast: { text: '🚪 Отримувач угоди відключився — угоду скасовано', color: '#e65100' },
                });
            }
            io.to(socket.roomCode).emit('playerDisconnected', { playerIndex: socket.playerIndex });

            const _emptyCheckCode = socket.roomCode;
            // Для bunker-кімнат що ще не почались — більше часу,
            // бо хост може переходити на /bunker/ (page reload + reconnect)
            const _emptyDelay = room.started ? 300_000
                               : room.gameType === 'bunker' ? 12_000
                               : 0;
            setTimeout(() => {
                const r = roomStore.get(_emptyCheckCode);
                if (!r) return;
                if (r.started && r.state?.gameType === 'bunker') return;
                const connectedHumans = r.players.filter(p => {
                    if (p.isBot || !p.socketId) return false;
                    const s = io.sockets.sockets.get(p.socketId);
                    return s && s.roomCode === r.code;
                });
                if (connectedHumans.length === 0) {
                    if (r.started) {
                        clearTurnTimer(r); clearTradeTimer(r);
                        clearTimeout(r.nightTimer); clearTimeout(r.dayTimer);
                        clearTimeout(r.voteTimer);
                        db.deleteRoom(r.code);
                    }
                    roomStore.delete(_emptyCheckCode);
                    console.log(`🗑️  Кімната ${_emptyCheckCode} видалена (порожня)`);
                }
            }, _emptyDelay);

            // Bunker: reconnect grace + AFK auto-action
            const rp = room.players.find(p => p.index === socket.playerIndex);
            if (room.started && room.state?.gameType === 'bunker' && !rp?.isBot) {
                const pidx     = socket.playerIndex;
                const roomCode = socket.roomCode;
                const sp = room.state.players[pidx];
                if (sp) sp.isOnline = false;
                emitBunkerUpdate(room);
                room.afkTimers = room.afkTimers || {};
                clearTimeout(room.afkTimers[pidx]);
                room.afkTimers[pidx] = setTimeout(() => {
                    const r = roomStore.get(roomCode);
                    if (!r?.state) return;
                    const st  = r.state;
                    const rp2 = r.players.find(p => p.index === pidx);
                    if (rp2?.socketId && io.sockets.sockets.get(rp2.socketId)) return;
                    const player = st.players[pidx];
                    if (!player?.isAlive) return;
                    if (st.phase === 'round_reveal' && !player.hasRevealed) {
                        const attr = Object.keys(player.attributes).find(k => !player.attributes[k].isRevealed);
                        if (attr) {
                            player.attributes[attr].isRevealed = true;
                            addBunkerLog(st, `⏱️ ${player.name} розкриває ${BUNKER_ATTR_LABELS[attr]} (AFK)`);
                        }
                        // Завжди позначаємо готовим — навіть якщо всі атрибути вже були відкриті
                        player.hasRevealed = true;
                        const allRevealed = st.players.filter(pl => pl.isAlive).every(pl => pl.hasRevealed);
                        if (allRevealed) { clearBunkerTimer(r); startBunkerPhase(r, 'discussion'); }
                        else emitBunkerUpdate(r);
                    } else if (st.phase === 'game_start' && !player.hasRevealed) {
                        player.hasRevealed = true;
                        addBunkerLog(st, `✅ ${player.name} готовий (AFK)`);
                        const allReady = st.players.every(pl => pl.hasRevealed);
                        if (allReady) {
                            st.players.forEach(pl => { pl.hasRevealed = false; });
                            clearBunkerTimer(r);
                            startBunkerRound(r);
                        } else emitBunkerUpdate(r);
                    } else if (st.phase === 'voting' && st.votes[pidx] === undefined && !st.quarantined?.includes(pidx)) {
                        const candidates = st.players.filter(pl => pl.isAlive && pl.id !== pidx && (!st.tiebreaker || st.tiebreaker.includes(pl.id)));
                        if (candidates.length > 0) {
                            const target = candidates[Math.floor(Math.random() * candidates.length)];
                            st.votes[pidx] = target.id;
                            addBunkerLog(st, `⏱️ ${player.name} голосує (AFK)`);
                            const aliveIds = st.players.filter(pl => pl.isAlive && !st.quarantined?.includes(pl.id)).map(pl => pl.id);
                            const allVoted = aliveIds.every(id => st.votes[id] !== undefined);
                            if (allVoted) { clearBunkerTimer(r); resolveBunkerVoting(r); }
                            else emitBunkerUpdate(r);
                        }
                    }
                }, 30_000);

                setTimeout(() => {
                    const r = roomStore.get(roomCode);
                    if (!r) return;
                    const connectedHumans = r.players.filter(p => !p.isBot && p.socketId && io.sockets.sockets.get(p.socketId));
                    if (connectedHumans.length === 0) { clearBunkerTimer(r); roomStore.delete(roomCode); }
                }, 60_000);
            }
        });
    });

    return { generateCode };
};
