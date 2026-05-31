const { shuffle, addLog } = require('./utils.js');

let _io;
let _db;
let _rooms;
let _onGameOver;

function init(io, db, rooms, onGameOver) {
    _io = io;
    _db = db;
    _rooms = rooms;
    _onGameOver = onGameOver || (() => {});
}

// Баланс скоригований: комісар+помічник бачать одне одного і діляться
// результатами перевірок — тому для малих ігор мафії додано +1
const MAFIA_BALANCE = {
    5:  { citizen:2, sheriff:1, deputy:0, doctor:0, roleblocker:0, mafia:1, don:1, maniac:0 }, // 3v2, без помічника
    6:  { citizen:3, sheriff:1, deputy:0, doctor:0, roleblocker:0, mafia:1, don:1, maniac:0 }, // 4v2, без помічника
    7:  { citizen:3, sheriff:1, deputy:0, doctor:1, roleblocker:0, mafia:1, don:1, maniac:0 }, // 5v2, без помічника
    8:  { citizen:2, sheriff:1, deputy:1, doctor:1, roleblocker:0, mafia:2, don:1, maniac:0 }, // 5v3
    9:  { citizen:2, sheriff:1, deputy:1, doctor:1, roleblocker:1, mafia:2, don:1, maniac:0 }, // 6v3
    10: { citizen:2, sheriff:1, deputy:1, doctor:1, roleblocker:1, mafia:2, don:1, maniac:1 }, // 6v3+maniac
    11: { citizen:3, sheriff:1, deputy:1, doctor:1, roleblocker:1, mafia:2, don:1, maniac:1 }, // 7v3+maniac
    12: { citizen:3, sheriff:1, deputy:1, doctor:1, roleblocker:1, mafia:3, don:1, maniac:1 }, // 7v4+maniac
    13: { citizen:4, sheriff:1, deputy:1, doctor:1, roleblocker:1, mafia:3, don:1, maniac:1 }, // 8v4+maniac
    14: { citizen:4, sheriff:1, deputy:1, doctor:1, roleblocker:1, mafia:4, don:1, maniac:1 }, // 8v5+maniac
    15: { citizen:5, sheriff:1, deputy:1, doctor:1, roleblocker:1, mafia:4, don:1, maniac:1 }, // 9v5+maniac
};

const MAFIA_ROLE_LABELS = {
    citizen:    { ua: 'Мирний житель', icon: '👤', faction: 'town'   },
    sheriff:    { ua: 'Комісар',       icon: '🔍', faction: 'town'   },
    deputy:     { ua: 'Помічник',      icon: '🛡️', faction: 'town'   },
    doctor:     { ua: 'Лікар',         icon: '💊', faction: 'town'   },
    roleblocker:{ ua: 'Повія',         icon: '🚫', faction: 'town'   },
    mafia:      { ua: 'Мафія',         icon: '🔫', faction: 'mafia'  },
    don:        { ua: 'Дон',           icon: '👑', faction: 'mafia'  },
    maniac:     { ua: 'Маньяк',        icon: '🔪', faction: 'maniac' },
};

function createMafiaState(roomPlayers, settings = {}) {
    const n = roomPlayers.length;
    const balance = MAFIA_BALANCE[n] || MAFIA_BALANCE[5];

    const rolePool = [];
    Object.entries(balance).forEach(([role, count]) => {
        for (let i = 0; i < count; i++) rolePool.push(role);
    });
    const shuffled = shuffle([...rolePool]);

    const players = roomPlayers.map((rp, i) => ({
        id:         i,
        socketId:   rp.socketId,
        name:       rp.name,
        isBot:      rp.isBot || false,
        role:       shuffled[i],
        isAlive:    true,
        isSilenced: false,
        skippedVotes: 0,
        avatarId:   rp.avatarId   || null,
        avatarColor: rp.avatarColor || '#1a56db',
    }));

    const mafiaIds = players.filter(p => p.role === 'mafia' || p.role === 'don').map(p => p.id);

    return {
        gameType:   'mafia',
        phase:      'role_reveal',
        round:      1,
        players,
        mafiaIds,
        nightActions:    {},
        votes:           {},
        lastDeaths:      [],
        lastSaved:       false,  // чи лікар врятував когось цієї ночі (без імені)
        sheriffFindings: [],   // { id, role } — видно тільки комісару+помічнику
        donFindings:     [],   // { id, isSheriff } — видно тільки дону
        winner:     null,
        log:        [],
        doctorLastTarget: null,   // Bug fix: заборона лікувати одного двічі поспіль
        nightDuration:  settings.nightDuration  || 90,
        dayDuration:    settings.dayDuration    || 120,
        voteDuration:   settings.voteDuration   || 60,
        revealDeadline: Date.now() + 25000,
    };
}

function sanitizeMafia(state, forIdx) {
    const isSpectator = forIdx === -1;
    const me = isSpectator ? null : state.players[forIdx];
    const myRole = me?.role;
    const myFaction = MAFIA_ROLE_LABELS[myRole]?.faction;
    // Dead players see all roles; spectators do NOT (they only watch chat/flow)
    const seeAll = (!isSpectator && me && !me.isAlive) || state.phase === 'gameover';

    return {
        gameType:   'mafia',
        phase:      state.phase,
        round:      state.round,
        winner:     state.winner,
        lastDeaths: state.lastDeaths,
        lastSaved:  state.lastSaved || false,
        log:        state.log.slice(0, 30),
        players: state.players.map(p => ({
            id:         p.id,
            name:       p.name,
            isAlive:    p.isAlive,
            isSilenced: p.isSilenced,
            avatarId:   p.avatarId   || null,
            avatarColor: p.avatarColor || '#1a56db',
            role: (seeAll ||
                   p.id === forIdx ||
                   (myFaction === 'mafia' && MAFIA_ROLE_LABELS[p.role]?.faction === 'mafia') ||
                   (myRole === 'sheriff' && p.role === 'deputy') ||
                   (myRole === 'deputy'  && p.role === 'sheriff'))
                ? p.role : null,
        })),
        myId:        forIdx,
        myRole:      isSpectator ? null : myRole,
        myFaction:   isSpectator ? null : myFaction,
        myRoleLabel: isSpectator ? null : (MAFIA_ROLE_LABELS[myRole] || null),
        isSpectator,
        mafiaIds:        (myFaction === 'mafia' || seeAll) ? state.mafiaIds : null,
        sheriffFindings: (myRole === 'sheriff' || myRole === 'deputy' || seeAll) ? state.sheriffFindings : null,
        donFindings:     (myRole === 'don' || seeAll) ? state.donFindings : null,
        myVote:    isSpectator ? null : (state.votes?.[forIdx] ?? null),
        allVotes:  state.phase === 'day_voting' ? { ...state.votes } : {},
        voteCount: state.phase === 'day_voting'
            ? state.players.filter(p => p.isAlive && !p.isSilenced && state.votes[p.id] !== undefined).length
            : 0,
        eligibleVoters: state.players.filter(p => p.isAlive && !p.isSilenced).length,
        readyCount: state._ready ? state._ready.size : 0,
        revealDeadline: state.revealDeadline || null,
        nightDeadline:  state.nightDeadline  || null,
        dayDeadline:    state.dayDeadline    || null,
        voteDeadline:   state.voteDeadline   || null,
    };
}

function emitMafiaUpdate(room, sideEffect) {
    room.players.forEach(rp => {
        if (!rp.socketId) return;
        _io.to(rp.socketId).emit('stateUpdate', {
            state: sanitizeMafia(room.state, rp.index),
            sideEffect: sideEffect || null,
        });
    });
    // Emit to spectators (read-only view with all roles revealed)
    if (room.spectators?.size) {
        const spectatorState = sanitizeMafia(room.state, -1);
        room.spectators.forEach(sid => {
            _io.to(sid).emit('stateUpdate', { state: spectatorState, sideEffect: null });
        });
    }
}

function emitMafiaGameOver(room) {
    room.players.forEach(rp => {
        if (!rp.socketId) return;
        _io.to(rp.socketId).emit('gameOver', { state: sanitizeMafia(room.state, rp.index), gameType: 'mafia' });
    });
    if (room.spectators?.size) {
        const spectatorState = sanitizeMafia(room.state, -1);
        room.spectators.forEach(sid => {
            _io.to(sid).emit('gameOver', { state: spectatorState, gameType: 'mafia' });
        });
    }
}

function checkMafiaWin(state) {
    const alive        = state.players.filter(p => p.isAlive);
    const aliveMafia   = alive.filter(p => MAFIA_ROLE_LABELS[p.role]?.faction === 'mafia').length;
    const aliveTown    = alive.filter(p => MAFIA_ROLE_LABELS[p.role]?.faction === 'town').length;
    const aliveManiac  = alive.filter(p => p.role === 'maniac').length;

    if (aliveManiac > 0 && aliveMafia === 0 && aliveTown === 0) {
        state.winner = 'maniac';
        state.phase  = 'gameover';
        state.log.unshift('🔪 Маньяк переміг! Він єдиний хто вижив.');
        return true;
    }
    if (aliveMafia === 0 && aliveManiac === 0) {
        state.winner = 'town';
        state.phase  = 'gameover';
        state.log.unshift('🏆 Місто перемогло! Всіх злочинців знешкоджено.');
        return true;
    }
    if (aliveManiac === 0 && aliveMafia >= aliveTown) {
        state.winner = 'mafia';
        state.phase  = 'gameover';
        state.log.unshift('🔫 Мафія перемогла! Мирних залишилось менше.');
        return true;
    }
    return false;
}

function startNightPhase(room) {
    const state = room.state;
    state.phase = 'night';
    state.nightActions = {
        mafiaVotes:       {},
        sheriffCheck:     null,
        donCheck:         null,
        doctorHeal:       null,
        roleblockerBlock: null,
        maniacKill:       null,
    };
    state.players.forEach(p => { p.isSilenced = false; });
    state.nightDeadline = Date.now() + state.nightDuration * 1000;
    addLog(state, `🌙 Ніч ${state.round} — місто засинає...`);
    emitMafiaUpdate(room, { event: 'nightStart', deadline: state.nightDeadline });
    clearTimeout(room.nightTimer);
    room.nightTimer = setTimeout(() => resolveNight(room), state.nightDuration * 1000);
    getMafiaBotDecisions(room);
}

function resolveNight(room) {
    clearTimeout(room.nightTimer);
    const state = room.state;
    if (state.phase !== 'night') return;
    state.phase = 'resolving';
    const acts  = state.nightActions;
    const ps    = state.players;

    const nightBlocked = new Set();
    if (acts.roleblockerBlock) {
        const tid = acts.roleblockerBlock.targetId;
        nightBlocked.add(tid);
        ps[tid].isSilenced = true;
    }

    const protected_ = new Set();
    if (acts.doctorHeal && !nightBlocked.has(acts.doctorHeal.actorId)) {
        protected_.add(acts.doctorHeal.targetId);
        // Запам'ятовуємо ціль лікаря — наступного разу не можна лікувати того ж самого
        state.doctorLastTarget = acts.doctorHeal.targetId;
    } else {
        state.doctorLastTarget = null;  // якщо не лікував — ліміт скидається
    }

    let sheriffResult = null;
    if (acts.sheriffCheck && !nightBlocked.has(acts.sheriffCheck.actorId)) {
        const t = ps[acts.sheriffCheck.targetId];
        sheriffResult = {
            targetId:   acts.sheriffCheck.targetId,
            targetName: t.name,
            isBad: MAFIA_ROLE_LABELS[t.role]?.faction === 'mafia',
        };
        const alreadyChecked = state.sheriffFindings.some(f => f.id === sheriffResult.targetId);
        if (!alreadyChecked) state.sheriffFindings.push({ id: sheriffResult.targetId, role: t.role });
    }

    let donResult = null;
    if (acts.donCheck && !nightBlocked.has(acts.donCheck.actorId)) {
        const t = ps[acts.donCheck.targetId];
        donResult = {
            targetId:   acts.donCheck.targetId,
            targetName: t.name,
            isSheriff:  t.role === 'sheriff' || t.role === 'deputy',
        };
        const alreadyChecked = state.donFindings.some(f => f.id === donResult.targetId);
        if (!alreadyChecked) state.donFindings.push({ id: donResult.targetId, isSheriff: donResult.isSheriff });
    }

    let mafiaTarget = null;
    const don = ps.find(p => p.role === 'don' && p.isAlive);
    if (don && acts.mafiaVotes[don.id] !== undefined && !nightBlocked.has(don.id)) {
        mafiaTarget = acts.mafiaVotes[don.id];
    } else {
        const voteCounts = {};
        Object.entries(acts.mafiaVotes).forEach(([vid, tid]) => {
            if (!nightBlocked.has(+vid)) voteCounts[tid] = (voteCounts[tid] || 0) + 1;
        });
        const maxV = Math.max(...Object.values(voteCounts), 0);
        if (maxV > 0) mafiaTarget = +Object.keys(voteCounts).find(k => voteCounts[k] === maxV);
    }

    let maniacTarget = null;
    if (acts.maniacKill && !nightBlocked.has(acts.maniacKill.actorId)) {
        maniacTarget = acts.maniacKill.targetId;
    }

    state.lastDeaths = [];
    state.lastSaved = mafiaTarget !== null && mafiaTarget !== undefined && protected_.has(mafiaTarget);
    if (mafiaTarget !== null && mafiaTarget !== undefined && !protected_.has(mafiaTarget)) {
        ps[mafiaTarget].isAlive = false;
        state.lastDeaths.push(mafiaTarget);
    }
    if (maniacTarget !== null && maniacTarget !== undefined &&
        !protected_.has(maniacTarget) && ps[maniacTarget].isAlive) {
        ps[maniacTarget].isAlive = false;
        state.lastDeaths.push(maniacTarget);
    }

    let newSheriffIdx = null;
    if (state.lastDeaths.some(id => ps[id].role === 'sheriff')) {
        const dep = ps.find(p => p.role === 'deputy' && p.isAlive);
        if (dep) {
            dep.role = 'sheriff';
            newSheriffIdx = dep.id;
            addLog(state, `👮 Помічник займає місце Комісара`);
        }
    }

    startMorningPhase(room, sheriffResult, newSheriffIdx, donResult);
}

function startMorningPhase(room, sheriffResult, newSheriffIdx = null, donResult = null) {
    const state = room.state;
    state.phase = 'morning';

    if (state.lastDeaths.length === 0) {
        addLog(state, '🌅 Місто прокинулось — ніхто не загинув.');
    } else {
        state.lastDeaths.forEach(id => {
            const p = state.players[id];
            addLog(state, `💀 Вночі загинув(ла) ${p.name} (${MAFIA_ROLE_LABELS[p.role]?.ua || p.role})`);
        });
    }

    if (checkMafiaWin(state)) {
        emitMafiaGameOver(room);
        _onGameOver(room);
        return;
    }

    room.players.forEach(rp => {
        if (!rp.socketId) return;
        const p = state.players[rp.index];
        let sideEffect = null;
        if (sheriffResult && (p.role === 'sheriff' || p.role === 'deputy'))
            sideEffect = { event: 'sheriffResult', ...sheriffResult };
        if (donResult && p.role === 'don')
            sideEffect = { event: 'donResult', ...donResult };
        if (newSheriffIdx !== null && rp.index === newSheriffIdx)
            sideEffect = { ...(sideEffect || {}), event: sideEffect?.event || 'newSheriff', newSheriff: true };
        _io.to(rp.socketId).emit('stateUpdate', {
            state: sanitizeMafia(state, rp.index),
            sideEffect,
        });
    });

    setTimeout(() => startDayPhase(room), 2000);
}

function startDayPhase(room) {
    const state = room.state;
    state.phase = 'day_discussion';
    state.votes  = {};
    state.dayDeadline = Date.now() + state.dayDuration * 1000;
    addLog(state, `☀️ День ${state.round} — місто обговорює підозрюваних...`);
    emitMafiaUpdate(room, { event: 'dayStart', deadline: state.dayDeadline });
    clearTimeout(room.dayTimer);
    room.dayTimer = setTimeout(() => startVotingPhase(room), state.dayDuration * 1000);
}

function startVotingPhase(room) {
    clearTimeout(room.dayTimer);
    const state = room.state;
    state.phase = 'day_voting';
    state.votes  = {};
    const VOTE_MS = (state.voteDuration || 60) * 1000;
    state.voteDeadline = Date.now() + VOTE_MS;
    addLog(state, `🗳️ Час голосувати! Оберіть підозрюваного або пропустіть.`);
    emitMafiaUpdate(room, { event: 'votingStart', deadline: state.voteDeadline });
    clearTimeout(room.voteTimer);
    room.voteTimer = setTimeout(() => resolveVoting(room), VOTE_MS);
    getMafiaBotDecisions(room);
}

function resolveVoting(room) {
    clearTimeout(room.voteTimer);
    const state = room.state;
    if (state.phase !== 'day_voting') return;
    state.phase = 'resolving';

    const voteCounts = {};
    let skipCount = 0;
    Object.entries(state.votes).forEach(([vid, tid]) => {
        const voter = state.players[+vid];
        if (!voter?.isAlive || voter.isSilenced) return;
        if (tid === 'skip') { skipCount++; return; }
        voteCounts[tid] = (voteCounts[tid] || 0) + 1;
    });

    const maxV       = Math.max(...Object.values(voteCounts), 0);
    const topTargets = Object.keys(voteCounts).filter(k => voteCounts[k] === maxV);

    state.lastDeaths = [];

    if (maxV === 0 || topTargets.length > 1) {
        addLog(state, `⚖️ Нічия — місто нікого не вигнало.`);
    } else {
        const eliminated = +topTargets[0];
        state.players[eliminated].isAlive = false;
        state.lastDeaths.push(eliminated);
        const p = state.players[eliminated];
        addLog(state, `🗳️ ${p.name} вигнаний(а) з міста (${MAFIA_ROLE_LABELS[p.role]?.ua || p.role})`);
    }

    if (checkMafiaWin(state)) {
        emitMafiaGameOver(room);
        _onGameOver(room);
        return;
    }

    state.round++;
    emitMafiaUpdate(room, { event: 'votingResolved' });
    setTimeout(() => startNightPhase(room), 5000);
}

function processMafiaAction(state, type, data, pidx) {
    const player = state.players[pidx];
    if (!player?.isAlive) return;

    switch (type) {
        case 'mafiaReady': {
            if (state.phase !== 'role_reveal') break;
            if (!state._ready) state._ready = new Set();
            state._ready.add(pidx);
            if (state._ready.size >= state.players.length) state._shouldStartNight = true;
            break;
        }

        case 'mafiaVote': {
            if (state.phase !== 'night') break;
            if (player.role !== 'mafia' && player.role !== 'don') break;
            const { targetId: mvt } = data;
            if (!state.players[mvt]?.isAlive || mvt === pidx) break;
            state.nightActions.mafiaVotes[pidx] = mvt;
            break;
        }

        case 'sheriffCheck': {
            if (state.phase !== 'night') break;
            if (player.role !== 'sheriff' && player.role !== 'deputy') break;
            const { targetId: sct } = data;
            if (!state.players[sct]?.isAlive || sct === pidx) break;
            state.nightActions.sheriffCheck = { actorId: pidx, targetId: sct };
            break;
        }

        case 'donCheck': {
            if (state.phase !== 'night' || player.role !== 'don') break;
            const { targetId: dct } = data;
            if (!state.players[dct]?.isAlive || dct === pidx) break;
            state.nightActions.donCheck = { actorId: pidx, targetId: dct };
            break;
        }

        case 'doctorHeal': {
            if (state.phase !== 'night' || player.role !== 'doctor') break;
            const { targetId: dht } = data;
            if (!state.players[dht]?.isAlive) break;
            // Заборона лікувати одного гравця двічі поспіль (як зазначено в правилах ролі)
            if (state.doctorLastTarget === dht) break;
            state.nightActions.doctorHeal = { actorId: pidx, targetId: dht };
            break;
        }

        case 'roleblockerBlock': {
            if (state.phase !== 'night' || player.role !== 'roleblocker') break;
            const { targetId: rbt } = data;
            if (!state.players[rbt]?.isAlive || rbt === pidx) break;
            state.nightActions.roleblockerBlock = { actorId: pidx, targetId: rbt };
            break;
        }

        case 'maniacKill': {
            if (state.phase !== 'night' || player.role !== 'maniac') break;
            const { targetId: mkt } = data;
            if (!state.players[mkt]?.isAlive || mkt === pidx) break;
            state.nightActions.maniacKill = { actorId: pidx, targetId: mkt };
            break;
        }

        case 'dayVote': {
            if (state.phase !== 'day_voting') break;
            if (!player.isAlive || player.isSilenced) break;
            const { targetId: dvt } = data;
            if (dvt === null) { delete state.votes[pidx]; break; }
            if (dvt !== 'skip' && (!state.players[dvt]?.isAlive || dvt === pidx)) break;
            state.votes[pidx] = dvt;
            const eligible = state.players.filter(p => p.isAlive && !p.isSilenced);
            const voted    = eligible.filter(p => state.votes[p.id] !== undefined);
            if (voted.length >= eligible.length) state._resolveVoting = true;
            break;
        }

        case 'cancelNightAction': {
            if (state.phase !== 'night') break;
            const { actionType } = data;
            const cancelMap = {
                mafiaVote:       () => { delete state.nightActions.mafiaVotes?.[pidx]; },
                sheriffCheck:    () => { if (state.nightActions.sheriffCheck?.actorId === pidx)    delete state.nightActions.sheriffCheck; },
                donCheck:        () => { if (state.nightActions.donCheck?.actorId === pidx)        delete state.nightActions.donCheck; },
                doctorHeal:      () => { if (state.nightActions.doctorHeal?.actorId === pidx)      delete state.nightActions.doctorHeal; },
                roleblockerBlock:() => { if (state.nightActions.roleblockerBlock?.actorId === pidx) delete state.nightActions.roleblockerBlock; },
                maniacKill:      () => { if (state.nightActions.maniacKill?.actorId === pidx)      delete state.nightActions.maniacKill; },
            };
            cancelMap[actionType]?.();
            break;
        }
    }
}

function getMafiaBotDecisions(room) {
    const bots = room.players.filter(p => p.isBot);
    if (!bots.length) return;

    bots.forEach(bp => {
        const delay = 800 + Math.random() * 1800;
        setTimeout(() => {
            const r = _rooms.get(room.code);
            if (!r?.state) return;
            const st = r.state;
            const p  = st.players[bp.index];
            if (!p?.isAlive) return;

            const rnd  = arr => arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
            const alive = st.players.filter(pl => pl.isAlive);
            const others = alive.filter(pl => pl.id !== bp.index);
            const town   = others.filter(pl => MAFIA_ROLE_LABELS[pl.role]?.faction === 'town');
            const nonMaf = others.filter(pl => MAFIA_ROLE_LABELS[pl.role]?.faction !== 'mafia');

            if (st.phase === 'role_reveal') {
                processMafiaAction(st, 'mafiaReady', {}, bp.index);
                if (st._shouldStartNight) {
                    delete st._shouldStartNight;
                    startNightPhase(r);
                } else {
                    emitMafiaUpdate(r, null);
                }
                return;
            }

            if (st.phase === 'night') {
                if (p.role === 'don') {
                    const t = rnd(town.length ? town : nonMaf);
                    if (t) processMafiaAction(st, 'mafiaVote', { targetId: t.id }, bp.index);
                    // Дон також перевіряє випадкового гравця
                    const tCheck = rnd(others);
                    if (tCheck) processMafiaAction(st, 'donCheck', { targetId: tCheck.id }, bp.index);
                } else if (p.role === 'mafia') {
                    const t = rnd(town.length ? town : nonMaf);
                    if (t) processMafiaAction(st, 'mafiaVote', { targetId: t.id }, bp.index);
                } else if (p.role === 'sheriff' || p.role === 'deputy') {
                    const t = rnd(others);
                    if (t) processMafiaAction(st, 'sheriffCheck', { targetId: t.id }, bp.index);
                } else if (p.role === 'doctor') {
                    const t = Math.random() < 0.3 ? p : rnd(others);
                    if (t) processMafiaAction(st, 'doctorHeal', { targetId: t.id }, bp.index);
                } else if (p.role === 'roleblocker') {
                    const t = rnd(others);
                    if (t) processMafiaAction(st, 'roleblockerBlock', { targetId: t.id }, bp.index);
                } else if (p.role === 'maniac') {
                    const t = rnd(others);
                    if (t) processMafiaAction(st, 'maniacKill', { targetId: t.id }, bp.index);
                }
                emitMafiaUpdate(r, null);
                return;
            }

            if (st.phase === 'day_voting' && st.votes[bp.index] === undefined) {
                const faction = MAFIA_ROLE_LABELS[p.role]?.faction;
                let t;
                if (faction === 'mafia') {
                    t = rnd(town.length ? town : nonMaf);
                } else {
                    t = Math.random() < 0.12 ? { id: 'skip' } : rnd(others);
                }
                if (t) {
                    processMafiaAction(st, 'dayVote', { targetId: t.id }, bp.index);
                    if (st._resolveVoting) {
                        delete st._resolveVoting;
                        resolveVoting(r);
                        return;
                    }
                }
                emitMafiaUpdate(r, null);
            }
        }, delay);
    });
}

module.exports = {
    init,
    createMafiaState,
    sanitizeMafia,
    emitMafiaUpdate,
    processMafiaAction,
    startNightPhase,
    startVotingPhase,
    resolveVoting,
    MAFIA_ROLE_LABELS,
    MAFIA_BALANCE,
    getMafiaBotDecisions,
};
