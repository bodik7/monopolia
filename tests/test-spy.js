// ============================================
// Spy game integration test — full flow
// Node: node tests/test-spy.js
// ============================================
const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';
// Spy createRoom дозволений без auth у NODE_ENV=test
function authenticateAdmin(_s) { return Promise.resolve(); }

let passed = 0, failed = 0;
const log = (...a) => console.log(...a);

function connect(name) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], timeout: 4000 });
    s._name = name;
    s.once('connect', () => resolve(s));
    s.once('connect_error', e => reject(new Error(`${name}: ${e.message}`)));
    setTimeout(() => reject(new Error(`${name} connect timeout`)), 5000);
  });
}

function waitFor(s, event, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting '${event}' on ${s._name}`)), ms);
    s.once(event, d => { clearTimeout(t); resolve(d); });
  });
}

function emit(s, event, data, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout '${event}' on ${s._name}`)), ms);
    s.emit(event, data, r => { clearTimeout(t); resolve(r); });
  });
}

function check(label, cond, msg = '') {
  if (cond) {
    log(`  ✅ ${label}`);
    passed++;
  } else {
    log(`  ❌ ${label}${msg ? ': ' + msg : ''}`);
    failed++;
  }
}

async function run() {
  log('\n── Spy: підключення ──');
  const [p0, p1, p2] = await Promise.all([connect('P0'), connect('P1'), connect('P2')]);
  await authenticateAdmin(p0); // createRoom для spy вимагає адміна

  log('\n── Spy: createRoom / joinRoom ──');

  const r0 = await emit(p0, 'createRoom', { gameType: 'spy', playerName: 'Аліса' });
  check('createRoom → success', !r0.error, r0.error);
  check('playerIndex = 0', r0.playerIndex === 0);
  const code = r0.code;
  log(`  Код кімнати: ${code}`);

  const r1 = await emit(p1, 'joinRoom', { code, playerName: 'Боб' });
  check('joinRoom p1 → success', !r1.error, r1.error);
  check('p1.playerIndex = 1', r1.playerIndex === 1);

  const r2 = await emit(p2, 'joinRoom', { code, playerName: 'Вася' });
  check('joinRoom p2 → success', !r2.error, r2.error);
  check('p2.playerIndex = 2', r2.playerIndex === 2);

  log('\n── Spy: startGame ──');

  const [gs0, gs1, gs2] = await Promise.all([
    waitFor(p0, 'gameStarted'),
    waitFor(p1, 'gameStarted'),
    waitFor(p2, 'gameStarted'),
    new Promise(r => { p0.emit('startGame', {}); r(); }),
  ]);

  check('gameStarted для всіх 3', gs0 && gs1 && gs2);
  check('myPlayerIndex=0 у p0', gs0.myPlayerIndex === 0);
  check('myPlayerIndex=1 у p1', gs1.myPlayerIndex === 1);
  check('myPlayerIndex=2 у p2', gs2.myPlayerIndex === 2);
  check('phase = role_reveal', gs0.state?.phase === 'role_reveal');
  check('gameType = spy', gs0.state?.gameType === 'spy');

  const s0 = gs0.state, s1 = gs1.state, s2 = gs2.state;

  // Перевірка санітизації — шпигун не бачить локацію
  const spyState  = [s0, s1, s2].find(s => s.iAmSpy);
  const townState = [s0, s1, s2].find(s => !s.iAmSpy);
  check('є шпигун серед гравців', !!spyState, 'жоден не iAmSpy');
  check('шпигун не бачить locationName', spyState?.locationName === null);
  check('мирний бачить locationName', typeof townState?.locationName === 'string');
  check('мирний бачить myRole', typeof townState?.myRole === 'string');
  check('шпигун myRole = null', spyState?.myRole === null);
  check('isSpy приховано в players', !s0.players?.some(p => p.isSpy === true));
  check('allLocations містить 20 локацій', s0.allLocations?.length === 20);

  log('\n── Spy: role_reveal — spy_ready ──');

  const updates = [];
  p0.on('stateUpdate', d => updates.push(d.state));
  p1.on('stateUpdate', d => updates.push(d.state));
  p2.on('stateUpdate', d => updates.push(d.state));

  // Всі три гравці позначають готовність
  p0.emit('action', { type: 'spy_ready', data: {} });
  p1.emit('action', { type: 'spy_ready', data: {} });
  await new Promise(r => setTimeout(r, 300));
  p2.emit('action', { type: 'spy_ready', data: {} });

  // Чекаємо переходу в discussion
  await new Promise(resolve => {
    const check = () => {
      if (updates.some(s => s.phase === 'discussion')) return resolve(null);
      setTimeout(check, 100);
    };
    setTimeout(check, 100);
    setTimeout(resolve, 4000); // fallback
  });

  const discussionState = updates.find(s => s.phase === 'discussion');
  check('перехід у discussion після готовності всіх', !!discussionState);
  if (discussionState) {
    check('таймер встановлений', discussionState.timer !== null);
  }

  log('\n── Spy: discussion — accusation ──');

  // Знаходимо хто шпигун і звинувачуємо саме його
  const spyIdx = [s0, s1, s2].findIndex(s => s.iAmSpy);
  const targetId = spyIdx; // звинувачуємо реального шпигуна
  const accuser  = [p0, p1, p2][spyIdx === 0 ? 1 : 0]; // хтось крім шпигуна
  log(`  Шпигун: гравець #${spyIdx}, звинувачувач: ${spyIdx === 0 ? 'P1' : 'P0'}`);
  accuser.emit('action', { type: 'spy_accuse', data: { targetId } });

  await new Promise(resolve => {
    const poll = () => {
      if (updates.some(s => s.phase === 'voting')) return resolve(null);
      setTimeout(poll, 100);
    };
    setTimeout(poll, 100);
    setTimeout(resolve, 4000);
  });

  const votingState = updates.find(s => s.phase === 'voting');
  check('перехід у voting після звинувачення', !!votingState);
  if (votingState) {
    check('accusedId встановлено', votingState.accusedId === targetId);
    check('votes об\'єкт порожній на початку', Object.keys(votingState.votes || {}).length === 0);
  }

  log('\n── Spy: voting ──');

  // Усі non-spy голосують "за", шпигун — "проти"
  const socks = [p0, p1, p2];
  socks.forEach((s, i) => {
    s.emit('action', { type: 'spy_vote', data: { vote: i === spyIdx ? 'against' : 'for' } });
  });

  // Чекаємо переходу — або spy_guess або discussion або result
  await new Promise(resolve => {
    const poll = () => {
      const next = updates.find(s => s.phase === 'spy_guess' || s.phase === 'result' || (s.phase === 'discussion' && s.accusedId === null));
      if (next) return resolve(null);
      setTimeout(poll, 150);
    };
    setTimeout(poll, 150);
    setTimeout(resolve, 5000);
  });

  const afterVote = updates.filter(s => s.phase !== 'voting' && s.phase !== 'role_reveal' && s.phase !== 'discussion').pop()
    || updates[updates.length - 1];

  check('голосування завершилось', ['spy_guess', 'result', 'discussion'].includes(afterVote?.phase));
  log(`  Фаза після голосування: ${afterVote?.phase}`);

  // Якщо spy_guess — шпигун вгадує локацію
  if (afterVote?.phase === 'spy_guess') {
    log('\n── Spy: spy_guess ──');
    // Знаходимо правильну локацію з перспективи шпигуна
    const spyPlayerIdx = [0,1,2].find(i => [s0,s1,s2][i]?.iAmSpy);
    const spySock = [p0,p1,p2][spyPlayerIdx ?? 1];
    const correctLocName = townState?.locationName;
    const allLocs = s0.allLocations;
    const correctLocId = allLocs?.findIndex(l => l.name === correctLocName);

    log(`  Правильна локація: ${correctLocName} (id=${correctLocId})`);
    spySock.emit('action', { type: 'spy_location_guess', data: { locationId: correctLocId } });

    await new Promise(resolve => {
      const poll = () => {
        if (updates.some(s => s.phase === 'result')) return resolve(null);
        setTimeout(poll, 150);
      };
      setTimeout(poll, 150);
      setTimeout(resolve, 4000);
    });
  }

  const resultState = updates.find(s => s.phase === 'result');
  check('гра завершилась (phase=result)', !!resultState);
  if (resultState) {
    check('winner встановлено', resultState.winner === 'spy' || resultState.winner === 'town');
    check('locationName розкрита у result', typeof resultState.locationName === 'string');
    check('isSpy розкрито у players', resultState.players?.some(p => p.isSpy === true));
    check('log містить записи', resultState.log?.length > 0);
    log(`  Переможець: ${resultState.winner}, Локація: ${resultState.locationName}`);
  }

  log('\n── Spy: probe — дублікат vote ──');
  // Спроба проголосувати ще раз у фазі result — має ігноруватись
  const dupUpdates = [];
  p0.on('stateUpdate', d => dupUpdates.push(d.state));
  p0.emit('action', { type: 'spy_vote', data: { vote: 'for' } });
  await new Promise(r => setTimeout(r, 400));
  check('🔍 vote у result-фазі ігнорується', !dupUpdates.some(s => s.phase === 'voting'));

  log('\n── Spy: probe — 2 гравці (замало) ──');
  const [q0, q1] = await Promise.all([connect('Q0'), connect('Q1')]);
  await authenticateAdmin(q0);
  const qr = await emit(q0, 'createRoom', { gameType: 'spy', playerName: 'X' });
  await emit(q1, 'joinRoom', { code: qr.code, playerName: 'Y' });
  const errProm = waitFor(q0, 'error', 2000).catch(() => null);
  q0.emit('startGame', {});
  const errMsg = await errProm;
  check('🔍 startGame з 2 гравцями → error', !!errMsg);
  log(`  Помилка: "${errMsg}"`);
  [q0, q1].forEach(s => s.disconnect());

  [p0, p1, p2].forEach(s => s.disconnect());

  log(`\n${'─'.repeat(44)}`);
  log(`Результат: ${passed} пройшло, ${failed} провалено`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('💥', e.message);
  process.exit(1);
});
