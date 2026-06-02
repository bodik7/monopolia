// ============================================
// socket/gameActions.js
// Обробка події 'action' для кожного типу гри
// ============================================
const db = require('../db');

module.exports = function makeGameActionHandler(io, roomStore, gameCtx) {
    const {
        processDurakAction, sanitizeDurak, emitDurakUpdate,
        processTysyachaAction, sanitizeTysyacha, clearTysyachaTimer, startTysyachaTimer, emitTysyachaUpdate,
        processMafiaAction, sanitizeMafia, emitMafiaUpdate, startNightPhase, resolveVoting, MAFIA_ROLE_LABELS,
        processBunkerAction,
        processSpyAction,
        processAction, sanitize, addLog, nextPlayer,
        clearTurnTimer, clearTradeTimer, startTurnTimer, startTradeTimer,
    } = gameCtx;

    return function handleGameAction(room, type, data, playerIndex, socketId) {
        const state = room.state;

        if (state.gameType === 'spy') {
            room.lastActivityAt = Date.now();
            processSpyAction(room, type, data, playerIndex);
            return;
        }

        if (state.gameType === 'bunker') {
            processBunkerAction(room, type, data, playerIndex);
            return;
        }

        if (state.gameType === 'durak') {
            room.lastActivityAt = Date.now();
            const result = processDurakAction(state, type, data, playerIndex);
            if (result?.event === 'dGameOver') {
                db.saveGameStats(room, rp => state.loser !== rp.index);
                db.saveGameHistory('durak', null, state.round || 0,
                    room.players.filter(p => p.username).map(rp => ({
                        username: rp.username, name: rp.name, won: state.loser !== rp.index,
                    }))
                );
                db.deleteRoom(room.code);
                room.players.forEach(rp => {
                    io.to(rp.socketId).emit('gameOver', { state: sanitizeDurak(state, rp.index), gameType: 'durak' });
                });
                roomStore.cleanup(room.code);
            } else {
                emitDurakUpdate(room, result);
            }
            return;
        }

        if (state.gameType === 'mafia') {
            room.lastActivityAt = Date.now();
            processMafiaAction(state, type, data, playerIndex);
            if (state._shouldStartNight) { delete state._shouldStartNight; startNightPhase(room); return; }
            if (state._resolveVoting)    { delete state._resolveVoting;    resolveVoting(room);    return; }
            if (state.phase === 'gameover') {
                db.saveGameStats(room, rp => {
                    const p = state.players[rp.index];
                    return p ? MAFIA_ROLE_LABELS[p.role]?.faction === state.winner : false;
                });
                db.deleteRoom(room.code);
                room.players.forEach(rp => {
                    if (!rp.socketId) return;
                    io.to(rp.socketId).emit('gameOver', { state: sanitizeMafia(state, rp.index), gameType: 'mafia' });
                });
                if (room.spectators?.size) {
                    const specState = sanitizeMafia(state, -1);
                    room.spectators.forEach(sid => io.to(sid).emit('gameOver', { state: specState, gameType: 'mafia' }));
                }
                roomStore.cleanup(room.code);
            } else {
                emitMafiaUpdate(room, null);
            }
            return;
        }

        if (state.gameType === 'tysyacha') {
            room.lastActivityAt = Date.now();
            clearTysyachaTimer(room);
            const result = processTysyachaAction(state, type, data, playerIndex);
            if (result?.event === 'tGameOver') {
                db.saveGameStats(room, rp => state.winner === rp.index);
                db.saveGameHistory('tysyacha', state.players[state.winner]?.name || null, state.round || 0,
                    room.players.filter(p => p.username).map(rp => ({
                        username: rp.username, name: rp.name, won: state.winner === rp.index,
                    }))
                );
                db.deleteRoom(room.code);
                room.players.forEach(rp => {
                    io.to(rp.socketId).emit('gameOver', {
                        winner: state.players[state.winner], state: sanitizeTysyacha(state, rp.index), gameType: 'tysyacha',
                    });
                });
                roomStore.cleanup(room.code);
            } else {
                emitTysyachaUpdate(room, result, null);
                startTysyachaTimer(room);
            }
            return;
        }

        // Монополія
        const isAuctionAction = ['auctionBid', 'auctionPass'].includes(type);
        const isTradeResponse = ['acceptTrade', 'rejectTrade'].includes(type);
        if (!isAuctionAction && !isTradeResponse && state.currentPlayerIndex !== playerIndex) return;
        if (isAuctionAction && state.auctionState) {
            const a = state.auctionState;
            const bidderId = a.active[a.turnIdx % a.active.length];
            if (bidderId !== playerIndex) return;
        }
        if (isTradeResponse) { (data = data || {}).callerIdx = playerIndex; }
        room.lastActivityAt = Date.now();
        const prevIdx    = state.currentPlayerIndex;
        const sideEffect = processAction(state, type, data, room);
        const toast      = state._toast || null;
        delete state._toast;
        if (type === 'offerTrade' && state.pendingTrade) {
            startTradeTimer(room);
        } else if (isTradeResponse && !state.pendingTrade) {
            clearTradeTimer(room);
            startTurnTimer(room);
        } else if (state.currentPlayerIndex !== prevIdx) {
            startTurnTimer(room);
        }
        const alive = state.players.filter(p => !p.bankrupt);
        if (alive.length === 1) {
            clearTurnTimer(room); clearTradeTimer(room);
            addLog(state, `🏆 ${alive[0].name} — переможець!`, 'success');
            db.saveGameStats(room, rp => alive[0].name === state.players[rp.index]?.name);
            db.saveGameHistory('monopoly', alive[0].name, state.round || 0,
                room.players.filter(p => p.username).map(rp => ({
                    username: rp.username, name: rp.name,
                    won: alive[0].name === state.players[rp.index]?.name,
                }))
            );
            db.deleteRoom(room.code);
            io.to(room.code).emit('gameOver', { winner: alive[0], state: sanitize(state) });
            roomStore.cleanup(room.code);
            return;
        }
        io.to(room.code).emit('stateUpdate', { state: sanitize(state), sideEffect, toast });
    };
};
