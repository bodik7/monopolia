// socket/handlers/disconnect.js

module.exports = function makeDisconnectHandler(io, roomStore, db, gameCtx) {
    const {
        addLog, awardAuction, sanitize,
        clearTurnTimer, clearTradeTimer, startTurnTimer,
        emitBunkerUpdate, addBunkerLog, clearBunkerTimer,
        startBunkerPhase, startBunkerRound, resolveBunkerVoting, BUNKER_ATTR_LABELS,
    } = gameCtx;

    return function handleDisconnect(socket, _activeSessions) {
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

        // Монополія: аукціон і торгівля при відключенні
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

        // Порожня кімната — видаляємо після паузи
        const _emptyCheckCode = socket.roomCode;
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

        // Бункер: AFK auto-action
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
    };
};
