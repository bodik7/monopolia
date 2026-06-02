// socket/handlers/reconnect.js — rejoin, syncState, spectatorJoin

module.exports = function makeReconnectHandlers(io, roomStore, gameCtx) {
    const {
        sanitize, sanitizeDurak, sanitizeTysyacha, sanitizeMafia, sanitizeBunker,
        emitBunkerUpdate,
    } = gameCtx;

    function sanitizeFor(room, pidx) {
        const gt = room.state.gameType || room.gameType;
        if (gt === 'tysyacha') return sanitizeTysyacha(room.state, pidx);
        if (gt === 'mafia')    return sanitizeMafia(room.state, pidx);
        if (gt === 'durak')    return sanitizeDurak(room.state, pidx);
        if (gt === 'bunker')   return sanitizeBunker(room.state, pidx);
        return sanitize(room.state);
    }

    function isStr(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max; }

    function handleRejoin(socket, { code, playerIndex, playerName }, cb, emitLobbyUpdate) {
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
            cb({ success: true, started: true, state: sanitizeFor(room, playerIndex), gameType: room.gameType });
            io.to(code).emit('playerReconnected', { playerIndex });
            if (room.state.gameType === 'bunker') emitBunkerUpdate(room);
        } else {
            cb({ success: true, started: false, players: room.players.map(p => p.name), bots: room.players.map(p => p.isBot || false) });
            emitLobbyUpdate(room);
        }
    }

    function handleSyncState(socket, cb) {
        if (typeof cb !== 'function') return;
        const room = socket.roomCode ? roomStore.get(socket.roomCode) : null;
        if (!room?.started || !room.state) return cb({ error: 'no_state' });
        cb({ state: sanitizeFor(room, socket.playerIndex) });
    }

    function handleSpectatorJoin(socket, { code }, cb) {
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

        io.to(code.toUpperCase()).emit('spectatorJoined', { name: socket.username || 'Глядач' });
        cb({ success: true, state: sanitizeFor(room, -1), gameType: room.gameType });
    }

    return { handleRejoin, handleSyncState, handleSpectatorJoin };
};
