// socket/handlers/gameLifecycle.js — startGame + restartGame

module.exports = function makeGameLifecycleHandlers(io, roomStore, gameCtx) {
    const {
        createGameState, sanitize, addLog, startTurnTimer,
        createDurakState, sanitizeDurak, dStartTurnTimer,
        createTysyachaState, sanitizeTysyacha, clearTysyachaTimer, startTysyachaTimer,
        createMafiaState, sanitizeMafia, getMafiaBotDecisions, startNightPhase, MAFIA_BALANCE,
        createBunkerState, sanitizeBunker, clearBunkerTimer, startBunkerPhase,
    } = gameCtx;

    function launchGame(io, room, gameType) {
        const t = gameType;
        if (t === 'mafia') {
            const mafiaIds = room.state.mafiaIds;
            room.players.forEach(rp => {
                if (!rp.socketId) return;
                const s = io.sockets.sockets.get(rp.socketId);
                if (s && mafiaIds.includes(rp.index)) s.join(`${room.code}_mafia`);
                io.to(rp.socketId).emit('gameStarted', { state: sanitizeMafia(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'mafia' });
            });
        } else if (t === 'durak') {
            room.players.forEach(rp => { io.to(rp.socketId).emit('gameStarted', { state: sanitizeDurak(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'durak' }); });
        } else if (t === 'tysyacha') {
            room.players.forEach(rp => { io.to(rp.socketId).emit('gameStarted', { state: sanitizeTysyacha(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'tysyacha' }); });
        } else if (t === 'bunker') {
            room.players.forEach(rp => { io.to(rp.socketId).emit('gameStarted', { state: sanitizeBunker(room.state, rp.index), myPlayerIndex: rp.index, gameType: 'bunker' }); });
        } else {
            io.to(room.code).emit('gameStarted', { state: sanitize(room.state), gameType: 'monopoly' });
        }
    }

    function handleStartGame(socket, settings) {
        const room = roomStore.get(socket.roomCode);
        if (!room || socket.playerIndex !== 0) return;
        if (settings) room.settings = { ...(room.settings || {}), ...settings };
        room.started = true;

        if (room.gameType === 'mafia') {
            const n = room.players.length;
            if (!MAFIA_BALANCE[n]) {
                io.to(socket.id).emit('error', `Мафія: потрібно 5–15 гравців (зараз ${n})`);
                room.started = false; return;
            }
            room.state = createMafiaState(room.players, room.settings || {});
            launchGame(io, room, 'mafia');
            getMafiaBotDecisions(room);
            setTimeout(() => { if (room.state?.phase === 'role_reveal') startNightPhase(room); }, 25000);
        } else if (room.gameType === 'durak') {
            const n = room.players.length;
            if (n < 2 || n > 6) { io.to(socket.id).emit('error', 'Дурак: потрібно 2–6 гравців'); room.started = false; return; }
            room.state = createDurakState(room.players, room.settings || {});
            dStartTurnTimer(room);
            launchGame(io, room, 'durak');
        } else if (room.gameType === 'tysyacha') {
            if (room.players.length < 2 || room.players.length > 3) { io.to(socket.id).emit('error', 'Тисяча: потрібно 2 або 3 гравці'); room.started = false; return; }
            room.state = createTysyachaState(room.players);
            launchGame(io, room, 'tysyacha');
            startTysyachaTimer(room);
        } else if (room.gameType === 'bunker') {
            const n = room.players.length;
            if (n < 4 || n > 15) { io.to(socket.id).emit('error', 'Бункер: потрібно 4–15 гравців'); room.started = false; return; }
            room.state = createBunkerState(room.players, room.settings || {});
            launchGame(io, room, 'bunker');
            startBunkerPhase(room, 'game_start');
        } else {
            if (room.players.length < 2) { io.to(socket.id).emit('error', 'Потрібно мінімум 2 гравці'); room.started = false; return; }
            room.state = createGameState(room.players);
            addLog(room.state, `🎮 Гра почалась! Перший хід: ${room.state.players[0].name}`, 'success');
            startTurnTimer(room);
            launchGame(io, room, 'monopoly');
        }
    }

    function handleRestartGame(socket) {
        const room = roomStore.get(socket.roomCode);
        if (!room) return;

        if (socket.playerIndex !== 0) {
            if (!room.restartVotes) room.restartVotes = new Set();
            room.restartVotes.add(socket.playerIndex);
            const needed = Math.ceil(room.players.length / 2);
            io.to(socket.roomCode).emit('restartVoteUpdate', { votes: room.restartVotes.size, total: room.players.length, needed });
            if (room.restartVotes.size < needed) return;
            room.restartVotes.clear();
        } else {
            if (room.restartVotes) room.restartVotes.clear();
        }

        if (room.afkTimers) {
            Object.values(room.afkTimers).forEach(t => clearTimeout(t));
            room.afkTimers = {};
        }

        const gameType = room.state?.gameType || room.gameType;
        room.started = true;

        if (gameType === 'durak') {
            room.state = createDurakState(room.players, room.settings || {});
            dStartTurnTimer(room);
            launchGame(io, room, 'durak');
        } else if (gameType === 'tysyacha') {
            clearTysyachaTimer(room);
            room.state = createTysyachaState(room.players);
            launchGame(io, room, 'tysyacha');
            startTysyachaTimer(room);
        } else if (gameType === 'mafia') {
            clearTimeout(room.nightTimer); clearTimeout(room.dayTimer);
            clearTimeout(room.voteTimer);  clearTimeout(room.morningTimer);
            room.state = createMafiaState(room.players, room.settings || {});
            launchGame(io, room, 'mafia');
            setTimeout(() => { if (room.state?.phase === 'role_reveal') startNightPhase(room); }, 25000);
        } else if (gameType === 'bunker') {
            clearBunkerTimer(room);
            room.state = createBunkerState(room.players, room.settings || {});
            launchGame(io, room, 'bunker');
            startBunkerPhase(room, 'game_start');
        } else {
            room.state = createGameState(room.players);
            addLog(room.state, `🎮 Реванш! Перший хід: ${room.state.players[0].name}`, 'success');
            startTurnTimer(room);
            launchGame(io, room, 'monopoly');
        }
    }

    return { handleStartGame, handleRestartGame };
};
