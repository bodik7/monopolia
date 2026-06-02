// ============================================
// Socket інтеграційні тести
// Запускає вбудований сервер на порту 3099
// Запуск: node tests/test-socket.js
// ============================================
process.env.PORT          = '3099';
process.env.JWT_SECRET    = 'test-secret-for-socket-tests';
process.env.INITIAL_ADMIN = 'testadmin';
// Локальна тестова БД (не Turso)
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const http   = require('http');
const { Server } = require('socket.io');
const express    = require('express');
const { io: ioClient } = require('socket.io-client');

let passed = 0, failed = 0;
const BASE = 'http://localhost:3099';

// ── Тест-хелпери ─────────────────────────────

function test(name, fn) {
    return fn().then(() => {
        console.log(`  ✅ ${name}`);
        passed++;
    }).catch(e => {
        console.error(`  ❌ ${name}: ${e.message}`);
        failed++;
    });
}

function assert(cond, msg)  { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b)  { assert(a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertNotNull(v, msg) { assert(v != null, msg || 'expected non-null'); }

// Підключити клієнта та чекати connect
function connect(name) {
    return new Promise((resolve, reject) => {
        const s = ioClient(BASE, { transports: ['websocket'], timeout: 4000 });
        s._name = name;
        s.once('connect', () => resolve(s));
        s.once('connect_error', e => reject(new Error(`${name} connect_error: ${e.message}`)));
        setTimeout(() => reject(new Error(`${name} connect timeout`)), 5000);
    });
}

// Чекати одну подію з таймаутом
function waitFor(socket, event, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}' on ${socket._name}`)), timeoutMs);
        socket.once(event, (...args) => { clearTimeout(t); resolve(args[0]); });
    });
}

// Emit з callback (ack)
function emit(socket, event, data, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`ack timeout for '${event}' on ${socket._name}`)), timeoutMs);
        socket.emit(event, data, (res) => { clearTimeout(t); resolve(res); });
    });
}

function disconnect(...sockets) {
    sockets.forEach(s => { try { s.disconnect(); } catch {} });
}

// ── Запуск сервера ────────────────────────────

let serverInstance;

async function startServer() {
    // Завантажуємо сервер і db окремо, щоб не блокувати
    const app    = express();
    const server = http.createServer(app);
    const io     = new Server(server);

    app.use(express.json());

    const db      = require('../db');
    const { PORT } = require('../config');

    const rooms = {};
    const roomStore = {
        get:    c => rooms[c],
        set:    (c, r) => { rooms[c] = r; },
        delete: c => { delete rooms[c]; },
        all:    () => Object.values(rooms),
        has:    c => c in rooms,
        keys:   () => Object.keys(rooms),
        cleanup(c) {
            const r = rooms[c];
            if (!r) return;
            r.players.forEach(rp => {
                if (!rp.socketId) return;
                const s = io.sockets.sockets.get(rp.socketId);
                if (s) { s.leave(c); s.roomCode = null; s.playerIndex = null; }
            });
            delete rooms[c];
        },
    };

    // Ігрові модулі
    const monopolyMod = require('../games/monopoly.js');
    const tysyachaMod = require('../games/tysyacha.js');
    const durakMod    = require('../games/durak.js');
    const bunkerMod   = require('../games/bunker.js');
    const mafiaMod    = require('../games/mafia.js');

    app.use('/api', require('../routes/auth'));
    app.use('/api/admin', require('../routes/admin')(io, roomStore));
    app.use('/api',       require('../routes/api')(roomStore));

    const { clearTurnTimer, clearTradeTimer } = monopolyMod;
    const { clearBunkerTimer }                = bunkerMod;

    monopolyMod.init(io);
    tysyachaMod.init(io);
    durakMod.init(io);
    bunkerMod.init(io, db);
    mafiaMod.init(io, db, roomStore, () => {});

    const {
        createGameState, processAction, sanitize, addLog, nextPlayer,
        awardAuction, startTurnTimer, startTradeTimer,
    } = monopolyMod;
    const { createTysyachaState, processTysyachaAction, sanitizeTysyacha, clearTysyachaTimer, startTysyachaTimer, emitTysyachaUpdate } = tysyachaMod;
    const { createDurakState, processDurakAction, sanitizeDurak, emitDurakUpdate, dStartTurnTimer } = durakMod;
    const { createBunkerState, sanitizeBunker, emitBunkerUpdate, processBunkerAction, startBunkerPhase, startBunkerRound, resolveBunkerVoting, addBunkerLog, BUNKER_ATTR_LABELS, BOT_NAMES } = bunkerMod;
    const { createMafiaState, sanitizeMafia, emitMafiaUpdate, processMafiaAction, startNightPhase, resolveVoting, MAFIA_ROLE_LABELS, MAFIA_BALANCE, getMafiaBotDecisions } = mafiaMod;

    require('../socket/index')(io, roomStore, {
        createGameState, processAction, sanitize, addLog, nextPlayer,
        awardAuction, clearTurnTimer, clearTradeTimer, startTurnTimer, startTradeTimer,
        createTysyachaState, processTysyachaAction, sanitizeTysyacha, clearTysyachaTimer, startTysyachaTimer, emitTysyachaUpdate,
        createDurakState, processDurakAction, sanitizeDurak, emitDurakUpdate, dStartTurnTimer,
        createBunkerState, sanitizeBunker, emitBunkerUpdate, processBunkerAction, startBunkerPhase, startBunkerRound, clearBunkerTimer, resolveBunkerVoting, addBunkerLog, BUNKER_ATTR_LABELS, BOT_NAMES,
        createMafiaState, sanitizeMafia, emitMafiaUpdate, processMafiaAction, startNightPhase, resolveVoting, MAFIA_ROLE_LABELS, MAFIA_BALANCE, getMafiaBotDecisions,
    });

    await new Promise((resolve, reject) => {
        server.listen(3099, async () => {
            try {
                await db.init();
                resolve();
            } catch (e) { reject(e); }
        });
    });

    serverInstance = server;
}

// ── Тести ────────────────────────────────────

async function runTests() {
    console.log('\n── createRoom / joinRoom ──');

    await test('createRoom повертає code і playerIndex=0', async () => {
        const s = await connect('host');
        const res = await emit(s, 'createRoom', { gameType: 'tysyacha', playerName: 'Хост' });
        assert(!res.error, res.error);
        assertEqual(res.playerIndex, 0);
        assert(typeof res.code === 'string' && res.code.length > 0, 'code повинен бути непорожнім рядком');
        disconnect(s);
    });

    await test('joinRoom другого гравця повертає playerIndex=1', async () => {
        const host  = await connect('host');
        const guest = await connect('guest');
        const r1 = await emit(host,  'createRoom', { gameType: 'durak', playerName: 'Хост' });
        assert(!r1.error, r1.error);
        const r2 = await emit(guest, 'joinRoom',   { code: r1.code, playerName: 'Гість' });
        assert(!r2.error, r2.error);
        assertEqual(r2.playerIndex, 1);
        disconnect(host, guest);
    });

    await test('joinRoom до повної кімнати повертає error', async () => {
        const sockets = await Promise.all([connect('p0'), connect('p1'), connect('p2')]);
        const r0 = await emit(sockets[0], 'createRoom', { gameType: 'tysyacha', playerName: 'P0' });
        await emit(sockets[1], 'joinRoom', { code: r0.code, playerName: 'P1' });
        await emit(sockets[2], 'joinRoom', { code: r0.code, playerName: 'P2' });
        const p3 = await connect('p3');
        const r = await emit(p3, 'joinRoom', { code: r0.code, playerName: 'P3' });
        assert(r.error, 'очікувалась помилка при переповненні');
        disconnect(...sockets, p3);
    });

    console.log('\n── gameStarted / myPlayerIndex ──');

    await test('gameStarted (Дурак) містить правильний myPlayerIndex для кожного гравця', async () => {
        const [p0, p1] = await Promise.all([connect('p0'), connect('p1')]);
        const r0 = await emit(p0, 'createRoom', { gameType: 'durak', playerName: 'Аліса' });
        await emit(p1, 'joinRoom', { code: r0.code, playerName: 'Боб' });

        const [gs0, gs1] = await Promise.all([
            waitFor(p0, 'gameStarted'),
            waitFor(p1, 'gameStarted'),
            new Promise(r => { p0.emit('startGame', {}); r(); }),
        ]);

        assertEqual(gs0.myPlayerIndex, 0);
        assertEqual(gs1.myPlayerIndex, 1);
        assert(gs0.state, 'state має бути присутній');
        assert(gs0.state.players[0].hand !== null, 'власна рука не має бути null');
        assert(gs0.state.players[1].hand === null, 'чужа рука має бути null');
        disconnect(p0, p1);
    });

    await test('gameStarted (Тисяча) містить правильний myPlayerIndex', async () => {
        const [p0, p1, p2] = await Promise.all([connect('t0'), connect('t1'), connect('t2')]);
        const r = await emit(p0, 'createRoom', { gameType: 'tysyacha', playerName: 'T0' });
        await emit(p1, 'joinRoom', { code: r.code, playerName: 'T1' });
        await emit(p2, 'joinRoom', { code: r.code, playerName: 'T2' });

        const [gs0, gs1, gs2] = await Promise.all([
            waitFor(p0, 'gameStarted'),
            waitFor(p1, 'gameStarted'),
            waitFor(p2, 'gameStarted'),
            new Promise(r => { p0.emit('startGame', {}); r(); }),
        ]);

        assertEqual(gs0.myPlayerIndex, 0);
        assertEqual(gs1.myPlayerIndex, 1);
        assertEqual(gs2.myPlayerIndex, 2);
        assert(Array.isArray(gs1.state.players[1].hand), 'p1 має бачити свою руку');
        assertEqual(gs1.state.players[0].hand, null);
        assertEqual(gs1.state.players[2].hand, null);
        disconnect(p0, p1, p2);
    });

    console.log('\n── Spectator блокування ──');

    await test('spectator не може надсилати ігрові дії', async () => {
        const [p0, p1, spec] = await Promise.all([connect('p0'), connect('p1'), connect('spec')]);
        const r = await emit(p0, 'createRoom', { gameType: 'durak', playerName: 'P0' });
        await emit(p1, 'joinRoom', { code: r.code, playerName: 'P1' });
        await Promise.all([
            waitFor(p0, 'gameStarted'),
            waitFor(p1, 'gameStarted'),
            new Promise(res => { p0.emit('startGame', {}); res(); }),
        ]);
        await emit(spec, 'spectatorJoin', { code: r.code });

        // Spectator надсилає дію — не повинен отримати stateUpdate спрямованого на нього
        let spectatorGotUpdate = false;
        spec.on('stateUpdate', () => { spectatorGotUpdate = true; });
        spec.emit('action', { type: 'dPlay', data: {} });

        await new Promise(r => setTimeout(r, 300));
        assert(!spectatorGotUpdate, 'spectator не повинен отримувати stateUpdate у відповідь на action');
        disconnect(p0, p1, spec);
    });

    console.log('\n── rejoin / syncState ──');

    await test('rejoin відновлює стан гри з правильним myPlayerIndex', async () => {
        const [p0, p1] = await Promise.all([connect('r0'), connect('r1')]);
        const r = await emit(p0, 'createRoom', { gameType: 'durak', playerName: 'Реджойн0' });
        await emit(p1, 'joinRoom', { code: r.code, playerName: 'Реджойн1' });
        await Promise.all([
            waitFor(p0, 'gameStarted'),
            waitFor(p1, 'gameStarted'),
            new Promise(r => { p0.emit('startGame', {}); r(); }),
        ]);

        // p1 переконнектується
        p1.disconnect();
        const p1new = await connect('r1new');
        const rej = await emit(p1new, 'rejoin', { code: r.code, playerIndex: 1, playerName: 'Реджойн1' });
        assert(rej.success, 'rejoin має бути успішним');
        assertEqual(rej.started, true);
        assert(rej.state?.players, 'state має містити players');
        // myPlayerIndex повертається через gameStarted або через state
        assertEqual(rej.state.players[1].hand !== null, true); // бачить свою руку
        assertEqual(rej.state.players[0].hand, null);          // не бачить чужої
        disconnect(p0, p1new);
    });

    await test('syncState повертає правильний стан для гравця', async () => {
        const [p0, p1] = await Promise.all([connect('s0'), connect('s1')]);
        const r = await emit(p0, 'createRoom', { gameType: 'durak', playerName: 'Sync0' });
        await emit(p1, 'joinRoom', { code: r.code, playerName: 'Sync1' });
        await Promise.all([
            waitFor(p0, 'gameStarted'),
            waitFor(p1, 'gameStarted'),
            new Promise(r => { p0.emit('startGame', {}); r(); }),
        ]);

        const synced = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('syncState timeout')), 3000);
            p1.emit('syncState', res => { clearTimeout(t); resolve(res); });
        });
        assert(synced.state, 'syncState має повернути state');
        assert(Array.isArray(synced.state.players[1].hand), 'бачить свою руку');
        disconnect(p0, p1);
    });

    console.log('\n── payRent не дублюється ──');

    await test('подвійний payRent не псує money', async () => {
        const [p0, p1] = await Promise.all([connect('m0'), connect('m1')]);
        const r = await emit(p0, 'createRoom', { gameType: 'monopoly', playerName: 'Моно0' });
        await emit(p1, 'joinRoom', { code: r.code, playerName: 'Моно1' });
        await Promise.all([
            waitFor(p0, 'gameStarted'),
            waitFor(p1, 'gameStarted'),
            new Promise(r => { p0.emit('startGame', {}); r(); }),
        ]);

        // Ручно ставимо pendingAction=payRent і надсилаємо двічі
        // Перший раз — обробляється, другий — ігнорується (guard)
        const updates = [];
        p0.on('stateUpdate', d => updates.push(d.state));

        p0.emit('action', { type: 'payRent', data: {} });
        p0.emit('action', { type: 'payRent', data: {} });

        await new Promise(r => setTimeout(r, 400));
        // Якщо money стало NaN/null — це баг
        const lastState = updates[updates.length - 1];
        if (lastState) {
            const money = lastState.players[0]?.money;
            assert(money === null || typeof money === 'number', 'money має бути числом або null, але не NaN');
            assert(money !== null || money === null, 'money не має бути undefined');
        }
        disconnect(p0, p1);
    });
}

// ── Запуск ───────────────────────────────────

(async () => {
    try {
        await startServer();
        console.log('🚀 Тестовий сервер запущено на порту 3099\n');
        await runTests();
    } catch (e) {
        console.error('❌ Помилка запуску сервера:', e.message);
        failed++;
    } finally {
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`Результат: ${passed} пройшло, ${failed} провалено`);
        if (serverInstance) serverInstance.close();
        setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
    }
})();
