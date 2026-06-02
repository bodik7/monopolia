// ============================================
// ІГРОВИЙ КЛУБ — server.js (entry point)
// Node.js + Express + Socket.io + SQLite
// ============================================

// Глобальні обробники помилок — не дають серверу впасти
process.on('uncaughtException', (err) => {
    console.error('💥 uncaughtException:', err.stack || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 unhandledRejection:', reason?.stack || reason);
});

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');
const db      = require('./db');
const { PORT } = require('./config');

// Завантажуємо .env якщо є
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
            const [k, ...v] = line.trim().split('=');
            if (k && !k.startsWith('#') && !process.env[k]) process.env[k] = v.join('=');
        });
    }
} catch {}

const SW_VERSION = Date.now().toString(36);
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());

// Service Worker з динамічною версією кешу
app.get('/sw.js', (req, res) => {
    const content = fs.readFileSync(path.join(__dirname, 'public/sw.js'), 'utf8')
        .replace("'__SW_VERSION__'", `'igclub-${SW_VERSION}'`);
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-store');
    res.send(content);
});

// Статичні файли
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
        else res.setHeader('Cache-Control', 'public, max-age=86400');
    },
}));

// Бункер React SPA
const bunkerBuild = path.join(__dirname, 'public/bunker');
if (fs.existsSync(bunkerBuild)) {
    app.use('/bunker', express.static(bunkerBuild, {
        setHeaders(res, filePath) {
            res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-store' : 'public, max-age=86400');
        },
    }));
    app.get('/bunker/*', (req, res) => res.sendFile(path.join(bunkerBuild, 'index.html')));
} else {
    app.get('/bunker*', (req, res) => res.redirect('http://localhost:5173' + req.path.replace('/bunker', '') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));
}

// Шпигун React SPA
const spyBuild = path.join(__dirname, 'public/spy');
if (fs.existsSync(spyBuild)) {
    app.use('/spy', express.static(spyBuild, {
        setHeaders(res, filePath) {
            res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-store' : 'public, max-age=86400');
        },
    }));
    app.get('/spy/*', (req, res) => res.sendFile(path.join(spyBuild, 'index.html')));
} else {
    app.get('/spy*', (req, res) => res.redirect('http://localhost:5174' + req.path.replace('/spy', '') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));
}

// ── Кімнати (in-memory) ──────────────────────
const rooms = {};
const roomStore = {
    get:    code => rooms[code],
    set:    (code, room) => { rooms[code] = room; },
    delete: code => { delete rooms[code]; },
    all:    () => Object.values(rooms),
    has:    code => code in rooms,
    keys:   () => Object.keys(rooms),
    // Єдина реалізація cleanup — використовується і тут, і в socket/index.js
    cleanup(code) {
        const r = rooms[code];
        if (!r) return;
        r.players.forEach(rp => {
            if (!rp.socketId) return;
            const s = io.sockets.sockets.get(rp.socketId);
            if (s) { s.leave(code); s.roomCode = null; s.playerIndex = null; }
        });
        delete rooms[code];
    },
};

// ── Спільні дані (єдине джерело правди) ────
const { BOARD, TOKEN_COLORS, TOKEN_ICONS } = require('./public/shared/monopoly-board.js');
const { CHANCE_CARDS, EXCURSION_CARDS }    = require('./public/games/monopoly/messages.js');
const {
    BUNKER_PROFESSIONS, BUNKER_HEALTH, BUNKER_HOBBIES,
    BUNKER_TRAITS, BUNKER_BAGGAGE, BUNKER_FACTS, BUNKER_ACTION_CARDS, ACTION_CARD_PHASES,
} = require('./public/games/bunker/attributes.js');
const { BUNKER_SCENARIOS } = require('./public/games/bunker/scenarios.js');

// ── Ігрові модулі ─────────────────────────────
const monopolyMod = require('./games/monopoly.js');
const tysyachaMod = require('./games/tysyacha.js');
const durakMod    = require('./games/durak.js');
const bunkerMod   = require('./games/bunker.js');
const mafiaMod    = require('./games/mafia.js');
const spyMod      = require('./games/spy.js');

// ── HTTP маршрути ────────────────────────────
app.use('/api', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin')(io, roomStore));
app.use('/api',       require('./routes/api')(roomStore));

const { clearTurnTimer, clearTradeTimer } = monopolyMod;
const { clearBunkerTimer } = bunkerMod;

setInterval(() => {
    const now = Date.now();
    const IDLE_MS = 10 * 60 * 1000;
    roomStore.keys().forEach(code => {
        const room = roomStore.get(code);
        if (now - (room.lastActivityAt || room.createdAt) > IDLE_MS) {
            clearTurnTimer(room);
            clearTradeTimer(room);
            roomStore.cleanup(code);
            console.log(`🗑️ Кімнату ${code} видалено (неактивна 10+ хв)`);
        }
    });
}, 2 * 60 * 1000);

// ── Ініціалізація модулів ────────────────────
monopolyMod.init(io);
tysyachaMod.init(io);
durakMod.init(io);
bunkerMod.init(io, db);
spyMod.init(io, db);
mafiaMod.init(io, db, roomStore, (room) => {
    const { MAFIA_ROLE_LABELS } = mafiaMod;
    const mWinner = room.state?.winner;
    db.saveGameStats(room, rp => {
        const p = room.state?.players[rp.index];
        return p ? MAFIA_ROLE_LABELS[p.role]?.faction === mWinner : false;
    });
    db.saveGameHistory('mafia', mWinner, room.state?.round || 0,
        room.players.filter(p => p.username).map(rp => {
            const p = room.state?.players[rp.index];
            return { username: rp.username, name: rp.name, role: p?.role || null,
                     won: p ? MAFIA_ROLE_LABELS[p.role]?.faction === mWinner : false };
        })
    );
    db.deleteRoom(room.code);
    roomStore.cleanup(room.code);
});

// ── Socket.io ────────────────────────────────
const {
    createGameState, processAction, sanitize, addLog, nextPlayer,
    awardAuction, startTurnTimer, startTradeTimer,
} = monopolyMod;
const { createTysyachaState, processTysyachaAction, sanitizeTysyacha, clearTysyachaTimer, startTysyachaTimer, emitTysyachaUpdate } = tysyachaMod;
const { createDurakState, processDurakAction, sanitizeDurak, emitDurakUpdate, dStartTurnTimer } = durakMod;
const { createBunkerState, sanitizeBunker, emitBunkerUpdate, processBunkerAction, startBunkerPhase, startBunkerRound, resolveBunkerVoting, addBunkerLog, BUNKER_ATTR_LABELS, BOT_NAMES } = bunkerMod;
const { createMafiaState, sanitizeMafia, emitMafiaUpdate, processMafiaAction, startNightPhase, resolveVoting, MAFIA_ROLE_LABELS, MAFIA_BALANCE, getMafiaBotDecisions } = mafiaMod;
const { createSpyState, sanitizeSpy, processSpyAction, startSpyPhase, clearSpyTimer, scheduleBotActions: scheduleBotActionsspy } = spyMod;

require('./socket/index')(io, roomStore, {
    createGameState, processAction, sanitize, addLog, nextPlayer,
    awardAuction, clearTurnTimer, clearTradeTimer, startTurnTimer, startTradeTimer,
    createTysyachaState, processTysyachaAction, sanitizeTysyacha, clearTysyachaTimer, startTysyachaTimer, emitTysyachaUpdate,
    createDurakState, processDurakAction, sanitizeDurak, emitDurakUpdate, dStartTurnTimer,
    createBunkerState, sanitizeBunker, emitBunkerUpdate, processBunkerAction, startBunkerPhase, startBunkerRound, clearBunkerTimer, resolveBunkerVoting, addBunkerLog, BUNKER_ATTR_LABELS, BOT_NAMES,
    createMafiaState, sanitizeMafia, emitMafiaUpdate, processMafiaAction, startNightPhase, resolveVoting, MAFIA_ROLE_LABELS, MAFIA_BALANCE, getMafiaBotDecisions,
    createSpyState, sanitizeSpy, processSpyAction, startSpyPhase, clearSpyTimer, scheduleBotActionsspy,
});

// ── Відновлення кімнат після перезапуску ────
async function restoreRoomsFromDB() {
    await db.cleanOldRooms();
    const saved = await db.getAllRooms();
    let restored = 0;
    for (const { code, gameType, state } of saved) {
        if (roomStore.has(code)) continue;
        if (state.__waiting) {
            // Зала очікування — відновлюємо з гравцями (socketId будуть оновлені при rejoin)
            roomStore.set(code, {
                code, gameType,
                players: state.players || [],
                ready:   new Set(state.ready || []),
                started: false, state: null,
                createdAt: Date.now(), lastActivityAt: Date.now(),
            });
        } else {
            // Активна гра — state зберігається, players порожні (оновляться при rejoin)
            roomStore.set(code, { code, players: [], started: true, state, gameType, createdAt: Date.now(), lastActivityAt: Date.now() });
        }
        restored++;
    }
    if (restored > 0) console.log(`♻️  Відновлено ${restored} кімнат з БД`);
}

let _autoSaving = false;
async function autoSaveRooms() {
    if (_autoSaving) return;
    _autoSaving = true;
    try {
        for (const room of roomStore.all()) {
            if (room.started && room.state) {
                await db.saveRoom(room.code, room.gameType || room.state.gameType || 'monopoly', room.state);
            } else if (!room.started && room.players.length >= 2) {
                await db.saveRoom(room.code, room.gameType || 'monopoly', {
                    __waiting: true,
                    players: room.players,
                    ready:   room.ready ? [...room.ready] : [],
                });
            }
        }
    } finally {
        _autoSaving = false;
    }
}

// ── Запуск ───────────────────────────────────
server.listen(PORT, async () => {
    console.log(`🇺🇦 Ігровий Клуб запущено: http://localhost:${PORT}`);
    await db.init();
    await restoreRoomsFromDB();
    setInterval(autoSaveRooms, 30_000);
    const dailyClean = async () => { await db.cleanOldStats(); await db.cleanGhostUsers(); };
    dailyClean();
    setInterval(dailyClean, 24 * 60 * 60_000);
    if (process.env.RENDER_EXTERNAL_URL) {
        setInterval(() => { http.get(process.env.RENDER_EXTERNAL_URL).on('error', () => {}); }, 14 * 60 * 1000);
    }
});
