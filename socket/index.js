// ============================================
// Socket.io обробники подій
// ============================================
const jwt = require('jsonwebtoken');
const db  = require('../db');
const { JWT_SECRET }       = require('../config');
const { rateLimit }        = require('../middleware/auth');
const makeGameActionHandler   = require('./gameActions');
const makeGameLifecycleHandlers = require('./handlers/gameLifecycle');
const makeDisconnectHandler     = require('./handlers/disconnect');
const makeReconnectHandlers     = require('./handlers/reconnect');

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

    const { handleStartGame, handleRestartGame } = makeGameLifecycleHandlers(io, roomStore, gameCtx);
    const handleDisconnect   = makeDisconnectHandler(io, roomStore, db, gameCtx);
    const { handleRejoin, handleSyncState, handleSpectatorJoin } = makeReconnectHandlers(io, roomStore, gameCtx);

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

        socket.on('startGame',   ({ settings } = {}) => handleStartGame(socket, settings));
        socket.on('restartGame', ()                   => handleRestartGame(socket));

        socket.on('action', ({ type, data }) => {
            if (!isStr(type, 50)) return;
            if (socket.isSpectator || socket.playerIndex == null) return;
            if (!rateLimit(`action:${socket.id}`, 15, 1_000)) return;
            const room = roomStore.get(socket.roomCode);
            if (!room?.state) return;
            handleGameAction(room, type, data || {}, socket.playerIndex, socket.id);
        });

        socket.on('rejoin',       (data, cb) => handleRejoin(socket, data, cb, emitLobbyUpdate));
        socket.on('syncState',    (cb)       => handleSyncState(socket, cb));
        socket.on('spectatorJoin',(data, cb) => handleSpectatorJoin(socket, data, cb));

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

        socket.on('disconnect', () => handleDisconnect(socket, _activeSessions));
    });

    return { generateCode };
};
