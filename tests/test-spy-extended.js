// ============================================
// Spy — розширені тести (edge cases)
// Запуск: node tests/test-spy-extended.js
// ============================================
const { io } = require('socket.io-client');
const BASE   = 'http://localhost:3000';
// Spy createRoom дозволений без auth у NODE_ENV=test
function authAdmin(_s) { return Promise.resolve(); }

let passed = 0, failed = 0;

function connect(name) {
    return new Promise((res, rej) => {
        const s = io(BASE, { transports: ['websocket'], timeout: 4000 });
        s._name = name;
        s.once('connect', () => res(s));
        s.once('connect_error', e => rej(new Error(`${name}: ${e.message}`)));
        setTimeout(() => rej(new Error(`${name} timeout`)), 5000);
    });
}
function waitFor(s, event, ms = 5000) {
    return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timeout '${event}' on ${s._name}`)), ms);
        s.once(event, d => { clearTimeout(t); res(d); });
    });
}
function ack(s, event, data, ms = 4000) {
    return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`ack timeout '${event}'`)), ms);
        s.emit(event, data, r => { clearTimeout(t); res(r); });
    });
}
function check(label, cond, extra = '') {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else       { console.error(`  ❌ ${label}${extra ? ': '+extra : ''}`); failed++; }
}
async function waitPhase(updates, phase, ms = 5000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (updates.some(s => s.phase === phase)) return true;
        await new Promise(r => setTimeout(r, 80));
    }
    return false;
}
function collectUpdates(sockets) {
    const list = [];
    sockets.forEach(s => s.on('stateUpdate', d => list.push(d.state)));
    return list;
}
function dc(...socks) { socks.forEach(s => { try { s.disconnect(); } catch {} }); }

// ════════════════════════════════════════════
// Сценарій 1: Шпигун ПОМИЛЯЄТЬСЯ — мирні перемагають
// ════════════════════════════════════════════
async function testSpyGuessesWrong() {
    console.log('\n── Сценарій 1: шпигун помиляється ──');
    const [p0, p1, p2] = await Promise.all(['A','B','C'].map(connect));
    await authAdmin(p0);
    const r = await ack(p0, 'createRoom', { gameType: 'spy', playerName: 'A' });
    await ack(p1, 'joinRoom', { code: r.code, playerName: 'B' });
    await ack(p2, 'joinRoom', { code: r.code, playerName: 'C' });

    const gs = {};
    [p0,p1,p2].forEach((s,i) => s.once('gameStarted', d => { gs[i] = d; }));
    const upd = collectUpdates([p0,p1,p2]);
    p0.emit('startGame', {});
    await new Promise(r => setTimeout(r, 600));

    const spyIdx  = [0,1,2].find(i => gs[i]?.state?.iAmSpy);
    const spySock = [p0,p1,p2][spyIdx];

    // Всі позначають готовність → discussion
    [p0,p1,p2].forEach(s => s.emit('action', { type:'spy_ready', data:{} }));
    await waitPhase(upd, 'discussion');

    // accuse + vote spy out
    const accuser = spyIdx === 0 ? p1 : p0;
    accuser.emit('action', { type: 'spy_accuse', data: { targetId: spyIdx } });
    await waitPhase(upd, 'voting');
    [p0,p1,p2].forEach((s,i) => s.emit('action', { type:'spy_vote', data:{ vote: i===spyIdx?'against':'for' }}));
    await waitPhase(upd, 'spy_guess');

    // Шпигун вибирає НЕПРАВИЛЬНУ локацію
    const correctName = [gs[0],gs[1],gs[2]].find(s => !s?.state?.iAmSpy)?.state?.locationName;
    const allLocs = gs[0].state.allLocations;
    const wrongId = allLocs.findIndex(l => l.name !== correctName);
    spySock.emit('action', { type: 'spy_location_guess', data: { locationId: wrongId } });

    const gotResult = await waitPhase(upd, 'result', 3000);
    check('result настає', gotResult);
    const res = upd.find(s => s.phase === 'result');
    check('winner = town', res?.winner === 'town', `got: ${res?.winner}`);
    check('локація розкрита', typeof res?.locationName === 'string');
    dc(p0,p1,p2);
}

// ════════════════════════════════════════════
// Сценарій 2: Голосування на нічию (недостатньо голосів) — гра продовжується
// ════════════════════════════════════════════
async function testTiedVote() {
    console.log('\n── Сценарій 2: нічия у голосуванні ──');
    const [p0,p1,p2,p3] = await Promise.all(['D','E','F','G'].map(connect));
    await authAdmin(p0);
    const r = await ack(p0,'createRoom',{ gameType:'spy', playerName:'D' });
    await ack(p1,'joinRoom',{ code:r.code, playerName:'E' });
    await ack(p2,'joinRoom',{ code:r.code, playerName:'F' });
    await ack(p3,'joinRoom',{ code:r.code, playerName:'G' });

    const gs = {};
    [p0,p1,p2,p3].forEach((s,i) => s.once('gameStarted', d => { gs[i]=d; }));
    const upd = collectUpdates([p0,p1,p2,p3]);
    p0.emit('startGame', {});
    await new Promise(r => setTimeout(r,600));

    // Всі ready
    [p0,p1,p2,p3].forEach(s => s.emit('action',{ type:'spy_ready', data:{} }));
    await waitPhase(upd, 'discussion');

    // Звинувачуємо гравця 1
    p0.emit('action',{ type:'spy_accuse', data:{ targetId:1 }});
    await waitPhase(upd,'voting');

    // 2 за, 2 проти — нічия
    p0.emit('action',{ type:'spy_vote', data:{ vote:'for' }});
    p1.emit('action',{ type:'spy_vote', data:{ vote:'against' }});
    p2.emit('action',{ type:'spy_vote', data:{ vote:'for' }});
    p3.emit('action',{ type:'spy_vote', data:{ vote:'against' }});

    // Після нічиї — або discussion або result
    const goBack = await waitPhase(upd, 'discussion', 3000);
    const latestPhase = upd.slice().reverse().find(s => s !== undefined)?.phase;
    check('після нічиї гра продовжується', goBack || latestPhase !== 'result', `phase=${latestPhase}`);
    dc(p0,p1,p2,p3);
}

// ════════════════════════════════════════════
// Сценарій 3: Чат під час обговорення
// ════════════════════════════════════════════
async function testChatDuringDiscussion() {
    console.log('\n── Сценарій 3: чат під час discussion ──');
    const [p0,p1,p2] = await Promise.all(['H','I','J'].map(connect));
    await authAdmin(p0);
    const r = await ack(p0,'createRoom',{ gameType:'spy', playerName:'H' });
    await ack(p1,'joinRoom',{ code:r.code, playerName:'I' });
    await ack(p2,'joinRoom',{ code:r.code, playerName:'J' });

    [p0,p1,p2].forEach((s,i) => s.once('gameStarted', ()=>{}));
    const upd = collectUpdates([p0,p1,p2]);
    p0.emit('startGame',{});
    await new Promise(r => setTimeout(r,600));
    [p0,p1,p2].forEach(s => s.emit('action',{ type:'spy_ready', data:{} }));
    await waitPhase(upd,'discussion');

    // P1 надсилає чат
    const chatMsgs = [];
    [p0,p1,p2].forEach(s => s.on('chatMessage', m => chatMsgs.push(m)));
    p1.emit('chatMessage',{ text:'Де ти був учора?', name:'I', color:'#a855f7', icon:'👤' });
    await new Promise(r => setTimeout(r,400));

    check('chatMessage доставлено', chatMsgs.length >= 1, `got ${chatMsgs.length}`);
    check('текст повідомлення правильний', chatMsgs[0]?.text === 'Де ти був учора?');
    dc(p0,p1,p2);
}

// ════════════════════════════════════════════
// Сценарій 4: Rejoin під час spy_guess
// ════════════════════════════════════════════
async function testRejoinDuringSpy() {
    console.log('\n── Сценарій 4: rejoin під час гри ──');
    const [p0,p1,p2] = await Promise.all(['K','L','M'].map(connect));
    await authAdmin(p0);
    const r = await ack(p0,'createRoom',{ gameType:'spy', playerName:'K' });
    await ack(p1,'joinRoom',{ code:r.code, playerName:'L' });
    await ack(p2,'joinRoom',{ code:r.code, playerName:'M' });

    [p0,p1,p2].forEach((s,i) => s.once('gameStarted', ()=>{}));
    const upd = collectUpdates([p0,p1,p2]);
    p0.emit('startGame',{});
    await new Promise(r => setTimeout(r,600));
    [p0,p1,p2].forEach(s => s.emit('action',{ type:'spy_ready', data:{} }));
    await waitPhase(upd,'discussion');

    // P0 "відключається" і перепідключається
    p0.disconnect();
    const p0new = await connect('K-new');
    const rejRes = await ack(p0new,'rejoin',{ code:r.code, playerIndex:0, playerName:'K' });
    check('rejoin успішний', !!rejRes?.success, rejRes?.error);
    check('started=true після rejoin', rejRes?.started === true);

    if (rejRes?.state) {
        check('state.gameType=spy після rejoin', rejRes.state.gameType === 'spy');
        check('phase=discussion після rejoin', rejRes.state.phase === 'discussion');
        check('мирний бачить локацію після rejoin', !rejRes.state.iAmSpy ? typeof rejRes.state.locationName === 'string' : true);
    }
    dc(p0new,p1,p2);
}

// ════════════════════════════════════════════
// Сценарій 5: Дія від шпигуна у wrong фазі — ігнорується
// ════════════════════════════════════════════
async function testInvalidActionIgnored() {
    console.log('\n── Сценарій 5: некоректні дії ігноруються ──');
    const [p0,p1,p2] = await Promise.all(['N','O','P'].map(connect));
    await authAdmin(p0);
    const r = await ack(p0,'createRoom',{ gameType:'spy', playerName:'N' });
    await ack(p1,'joinRoom',{ code:r.code, playerName:'O' });
    await ack(p2,'joinRoom',{ code:r.code, playerName:'P' });

    const gs = {};
    [p0,p1,p2].forEach((s,i) => s.once('gameStarted', d => { gs[i]=d; }));
    const upd = collectUpdates([p0,p1,p2]);
    p0.emit('startGame',{});
    await new Promise(r => setTimeout(r,600));

    const spyIdx = [0,1,2].find(i => gs[i]?.state?.iAmSpy);
    const spySock = [p0,p1,p2][spyIdx];

    // 1. Шпигун намагається вгадати локацію у role_reveal — має ігноруватись
    spySock.emit('action',{ type:'spy_location_guess', data:{ locationId:0 }});
    await new Promise(r => setTimeout(r,300));
    check('🔍 guess у role_reveal → не завершує гру', !upd.some(s => s.phase==='result'));

    // 2. Звинувачення самого себе — має ігноруватись
    const accIdx = spyIdx === 0 ? 1 : 0;
    const accSock = [p0,p1,p2][accIdx];
    [p0,p1,p2].forEach(s => s.emit('action',{ type:'spy_ready', data:{} }));
    await waitPhase(upd,'discussion');
    accSock.emit('action',{ type:'spy_accuse', data:{ targetId: accIdx }}); // звинувачує себе
    await new Promise(r => setTimeout(r,300));
    check('🔍 self-accusation ігнорується', !upd.some(s => s.phase==='voting'));

    // 3. spy_vote поза фазою voting — ігнорується
    p0.emit('action',{ type:'spy_vote', data:{ vote:'for' }});
    await new Promise(r => setTimeout(r,300));
    check('🔍 vote поза voting-фазою ігнорується', !upd.some(s => s.phase==='result'));

    dc(p0,p1,p2);
}

// ════════════════════════════════════════════
// Сценарій 6: restartGame після завершення
// ════════════════════════════════════════════
async function testRestart() {
    console.log('\n── Сценарій 6: restartGame ──');
    const [p0,p1,p2] = await Promise.all(['Q','R','S'].map(connect));
    await authAdmin(p0);
    const r = await ack(p0,'createRoom',{ gameType:'spy', playerName:'Q' });
    await ack(p1,'joinRoom',{ code:r.code, playerName:'R' });
    await ack(p2,'joinRoom',{ code:r.code, playerName:'S' });

    const gs = {};
    [p0,p1,p2].forEach((s,i) => s.once('gameStarted', d => { gs[i]=d; }));
    const upd = collectUpdates([p0,p1,p2]);
    p0.emit('startGame',{});
    await new Promise(r => setTimeout(r,600));

    const spyIdx = [0,1,2].find(i => gs[i]?.state?.iAmSpy);
    const spySock = [p0,p1,p2][spyIdx];
    const accuser = spyIdx === 0 ? p1 : p0;
    [p0,p1,p2].forEach(s => s.emit('action',{ type:'spy_ready', data:{} }));
    await waitPhase(upd,'discussion');
    accuser.emit('action',{ type:'spy_accuse', data:{ targetId: spyIdx }});
    await waitPhase(upd,'voting');
    [p0,p1,p2].forEach((s,i) => s.emit('action',{ type:'spy_vote', data:{ vote: i===spyIdx?'against':'for' }}));
    await waitPhase(upd,'spy_guess');
    const townState = [gs[0],gs[1],gs[2]].find(g => !g?.state?.iAmSpy)?.state;
    const correctId = townState?.allLocations?.findIndex(l => l.name === townState?.locationName) ?? 0;
    spySock.emit('action',{ type:'spy_location_guess', data:{ locationId: correctId }});
    await waitPhase(upd,'result');

    // Запускаємо реванш
    const gs2 = {};
    [p0,p1,p2].forEach((s,i) => s.once('gameStarted', d => { gs2[i]=d; }));
    p0.emit('restartGame');
    await new Promise(r => setTimeout(r,1500));

    check('restartGame запускає нову гру', gs2[0] || gs2[1] || gs2[2]);
    const newGs = gs2[0] || gs2[1] || gs2[2];
    if (newGs) {
        check('нова гра: phase=role_reveal', newGs.state?.phase === 'role_reveal');
        check('нова гра: gameType=spy', newGs.state?.gameType === 'spy');
        // Нова локація може відрізнятись
        const oldLoc = townState?.locationName;
        const newLoc = [gs2[0],gs2[1],gs2[2]].find(g => !g?.state?.iAmSpy)?.state?.locationName;
        console.log(`  Локація: ${oldLoc} → ${newLoc}`);
    }
    dc(p0,p1,p2);
}

// ════════════════════════════════════════════
// Запуск
// ════════════════════════════════════════════
(async () => {
    try {
        await testSpyGuessesWrong();
        await testTiedVote();
        await testChatDuringDiscussion();
        await testRejoinDuringSpy();
        await testInvalidActionIgnored();
        await testRestart();
    } catch(e) {
        console.error('\n💥 Crash:', e.message);
        failed++;
    }
    console.log(`\n${'─'.repeat(44)}`);
    console.log(`Результат: ${passed} пройшло, ${failed} провалено`);
    process.exit(failed > 0 ? 1 : 0);
})();
