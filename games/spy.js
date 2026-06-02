// ============================================
// ШПИГУН — server-side game logic
// ============================================
const { shuffle } = require('./utils.js');
const { SPY_LOCATIONS } = require('../public/games/spy/locations.js');

let _io;
let _db;

function init(io, db) { _io = io; _db = db; }

const PHASE_MS = {
    role_reveal: 30_000,
    discussion:  5 * 60_000,
    voting:      25_000,
    spy_guess:   20_000,
};

// ── Створення стану ────────────────────────
function createSpyState(roomPlayers, settings = {}) {
    const n = roomPlayers.length;
    const spyCount = n >= 10 ? 2 : 1;

    // Вибір локації
    const locId = settings.locationId != null
        ? settings.locationId
        : Math.floor(Math.random() * SPY_LOCATIONS.length);
    const location = SPY_LOCATIONS[locId];

    // Призначення ролей
    const roles = shuffle([...location.roles]);
    const spyIndices = shuffle(roomPlayers.map((_, i) => i)).slice(0, spyCount);

    const players = roomPlayers.map((rp, i) => ({
        id:       i,
        name:     rp.name,
        isBot:    rp.isBot || false,
        isSpy:    spyIndices.includes(i),
        role:     spyIndices.includes(i) ? null : (roles[i % roles.length] || roles[0]),
        ready:    false,
        isAlive:  true,
        avatarId:    rp.avatarId    || null,
        avatarColor: rp.avatarColor || '#1a56db',
    }));

    return {
        gameType:    'spy',
        phase:       'role_reveal',
        location:    location.name,
        locationId:  locId,
        locationEmoji: location.emoji,
        allLocations: SPY_LOCATIONS.map(l => ({ name: l.name, emoji: l.emoji })),
        players,
        votes:       {},      // { voterId: targetId }
        accusedId:   null,    // player voted out
        winner:      null,    // 'spy' | 'town'
        revealedSpy: false,
        log:         [],
        timer:       null,
    };
}

// ── Санітизація (шпигун не бачить локацію, мирні не знають хто шпигун) ──
function sanitizeSpy(state, forIdx) {
    const me = state.players[forIdx];
    return {
        gameType:      'spy',
        phase:         state.phase,
        locationEmoji: state.phase === 'result' || state.revealedSpy
            ? state.locationEmoji : null,
        locationName:  state.phase === 'result' || state.revealedSpy
            ? state.location : null,
        allLocations:  state.allLocations,
        // Власна роль і чи є шпигун — тільки свої дані
        myRole:        me?.role   ?? null,
        iAmSpy:        me?.isSpy  ?? false,
        players: state.players.map(p => ({
            id:          p.id,
            name:        p.name,
            isBot:       p.isBot,
            avatarId:    p.avatarId,
            avatarColor: p.avatarColor,
            ready:       p.ready,
            isAlive:     p.isAlive,
            // Розкриваємо шпигунів тільки в кінці
            isSpy:       state.phase === 'result' ? p.isSpy : false,
            role:        state.phase === 'result' ? p.role  : null,
        })),
        votes:     state.phase === 'voting' ? state.votes : {},
        accusedId: state.accusedId,
        winner:    state.winner,
        log:       state.log,
        timer:     state.timer,
    };
}

// ── Emitter ────────────────────────────────
function emitSpyUpdate(room) {
    room.players.forEach(rp => {
        if (!rp.socketId || rp.isBot) return;
        _io.to(rp.socketId).emit('stateUpdate', {
            state: sanitizeSpy(room.state, rp.index),
        });
    });
}

// ── Таймер ─────────────────────────────────
function clearSpyTimer(room) {
    if (room.spyTimer) { clearTimeout(room.spyTimer); room.spyTimer = null; }
}

function startSpyPhase(room, phase) {
    clearSpyTimer(room);
    const s = room.state;
    s.phase = phase;
    s.timer = Date.now() + (PHASE_MS[phase] || 60_000);
    emitSpyUpdate(room);
    room.spyTimer = setTimeout(() => onSpyTimeout(room, phase), PHASE_MS[phase] || 60_000);
}

function onSpyTimeout(room, phase) {
    if (!room.state || room.state.phase !== phase) return;
    const s = room.state;
    if (phase === 'role_reveal') {
        // Всіх хто не встиг — авто-готові
        s.players.forEach(p => { p.ready = true; });
        addSpyLog(s, '⏱️ Час вийшов — починається обговорення');
        startSpyPhase(room, 'discussion');
    } else if (phase === 'discussion') {
        addSpyLog(s, '⏱️ Час обговорення вийшов!');
        // Шпигуни перемагають якщо не були викриті
        const spies = s.players.filter(p => p.isSpy && p.isAlive);
        if (spies.length > 0) {
            endGame(room, 'spy', `Час вийшов! Шпигун(и) не виявлені`);
        } else {
            endGame(room, 'town', 'Усіх шпигунів вже було виявлено');
        }
    } else if (phase === 'voting') {
        resolveVoting(room);
    } else if (phase === 'spy_guess') {
        // Шпигун не встиг — мирні перемагають
        addSpyLog(s, '⏱️ Шпигун не встиг назвати локацію');
        endGame(room, 'town', 'Шпигун не назвав локацію вчасно');
    }
}

// ── Лог ────────────────────────────────────
function addSpyLog(state, text) {
    state.log.unshift(text);
    if (state.log.length > 40) state.log.length = 40;
}

// ── Голосування ────────────────────────────
function resolveVoting(room) {
    clearSpyTimer(room);
    const s = room.state;
    const { accusedId, votes } = s;
    if (accusedId === null) {
        addSpyLog(s, '🗳️ Голосування завершено — нічия, гра продовжується');
        startSpyPhase(room, 'discussion');
        return;
    }

    const alivePlayers = s.players.filter(p => p.isAlive);
    let forVotes = 0, againstVotes = 0;
    alivePlayers.forEach(p => {
        const v = votes[p.id];
        if (v === 'for')     forVotes++;
        if (v === 'against') againstVotes++;
    });

    const accused = s.players[accusedId];
    if (!accused) { startSpyPhase(room, 'discussion'); return; }

    if (forVotes > againstVotes) {
        accused.isAlive = false;
        addSpyLog(s, `🗳️ ${accused.name} виведений(а) більшістю голосів (${forVotes}:${againstVotes})`);

        if (accused.isSpy) {
            // Шпигун спійманий — дати шанс вгадати локацію
            s.accusedId = accusedId;
            addSpyLog(s, `🕵️ ${accused.name} — це ШПИГУН! Дається 20 сек на вгадування локації`);
            startSpyPhase(room, 'spy_guess');
        } else {
            addSpyLog(s, `😇 ${accused.name} — мирний. Шпигун на волі!`);
            // Перевіряємо чи залишились живі шпигуни
            const aliveSpies = s.players.filter(p => p.isSpy && p.isAlive);
            if (aliveSpies.length === 0) {
                endGame(room, 'town', 'Усіх шпигунів виявлено');
            } else {
                s.votes = {};
                s.accusedId = null;
                startSpyPhase(room, 'discussion');
            }
        }
    } else {
        addSpyLog(s, `🗳️ Обвинувачення провалене (${forVotes}:${againstVotes}) — гра продовжується`);
        accused.isAlive = true; // відновити якщо було позначено
        s.votes = {};
        s.accusedId = null;
        startSpyPhase(room, 'discussion');
    }
}

// ── Кінець гри ─────────────────────────────
function endGame(room, winner, reason) {
    clearSpyTimer(room);
    const s = room.state;
    s.phase = 'result';
    s.winner = winner;
    s.revealedSpy = true;
    s.timer = null;
    addSpyLog(s, `🏁 Гра завершена: ${reason}`);

    _db.saveGameStats(room, rp => {
        const p = s.players[rp.index];
        if (!p) return false;
        return winner === 'spy' ? p.isSpy : !p.isSpy;
    });
    _db.saveGameHistory('spy', winner, 1,
        room.players.filter(p => p.username).map(rp => {
            const p = s.players[rp.index];
            const won = p ? (winner === 'spy' ? p.isSpy : !p.isSpy) : false;
            return { username: rp.username, name: rp.name, role: p?.role || null, won };
        })
    );
    _db.deleteRoom(room.code);
    emitSpyUpdate(room);
}

// ── Обробка дій ────────────────────────────
function processSpyAction(room, type, data, pidx) {
    const s = room.state;
    const p = s.players[pidx];
    if (!p || !p.isAlive) return;

    switch (type) {

        case 'spy_ready': {
            if (s.phase !== 'role_reveal') break;
            p.ready = true;
            addSpyLog(s, `✅ ${p.name} переглянув картку`);
            const allReady = s.players.every(pl => pl.ready || pl.isBot);
            if (allReady) {
                addSpyLog(s, '🗣️ Всі готові — починається обговорення!');
                startSpyPhase(room, 'discussion');
                return;
            }
            emitSpyUpdate(room);
            break;
        }

        case 'spy_accuse': {
            if (s.phase !== 'discussion') break;
            const targetId = Number(data.targetId);
            const target = s.players[targetId];
            if (!target || !target.isAlive || targetId === pidx) break;
            s.accusedId = targetId;
            s.votes = {};
            addSpyLog(s, `⚖️ ${p.name} звинувачує ${target.name}!`);
            startSpyPhase(room, 'voting');
            return;
        }

        case 'spy_vote': {
            if (s.phase !== 'voting') break;
            if (s.votes[pidx] !== undefined) break;
            const v = data.vote; // 'for' | 'against'
            if (v !== 'for' && v !== 'against') break;
            s.votes[pidx] = v;

            const alivePlayers = s.players.filter(pl => pl.isAlive);
            const allVoted = alivePlayers.every(pl => s.votes[pl.id] !== undefined);
            if (allVoted) {
                resolveVoting(room);
                return;
            }
            emitSpyUpdate(room);
            break;
        }

        case 'spy_location_guess': {
            if (s.phase !== 'spy_guess' && s.phase !== 'discussion') break;
            if (!p.isSpy) break;
            const guessId = Number(data.locationId);
            const guessName = SPY_LOCATIONS[guessId]?.name;
            if (!guessName) break;
            if (guessName === s.location) {
                addSpyLog(s, `🎯 ${p.name} правильно назвав локацію: ${guessName}! Шпигун перемагає!`);
                endGame(room, 'spy', `Шпигун вгадав локацію — ${guessName}`);
            } else {
                addSpyLog(s, `❌ ${p.name} помилився: ${guessName} (правильно: ${s.location})`);
                endGame(room, 'town', `Шпигун помилився з локацією`);
            }
            return;
        }
    }
}

// ── Боти ───────────────────────────────────
function scheduleBotActions(room, phase) {
    const bots = room.players.filter(p => p.isBot);
    if (!bots.length) return;
    if (phase === 'role_reveal') {
        bots.forEach((bp, i) => {
            setTimeout(() => {
                if (room.state?.phase !== 'role_reveal') return;
                processSpyAction(room, 'spy_ready', {}, bp.index);
            }, 1500 + i * 800);
        });
    }
    if (phase === 'voting') {
        bots.forEach((bp, i) => {
            setTimeout(() => {
                if (room.state?.phase !== 'voting') return;
                if (room.state.votes[bp.index] !== undefined) return;
                // Боти голосують "за" обвинувачення з 60% ймовірністю
                const v = Math.random() < 0.6 ? 'for' : 'against';
                processSpyAction(room, 'spy_vote', { vote: v }, bp.index);
            }, 2000 + i * 1200);
        });
    }
}

module.exports = {
    init,
    createSpyState,
    sanitizeSpy,
    emitSpyUpdate,
    processSpyAction,
    startSpyPhase,
    clearSpyTimer,
    addSpyLog,
    scheduleBotActions,
};
