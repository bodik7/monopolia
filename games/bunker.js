const { shuffle } = require('./utils.js');
const {
    BUNKER_PROFESSIONS, BUNKER_HEALTH, BUNKER_HOBBIES,
    BUNKER_TRAITS, BUNKER_BAGGAGE, BUNKER_FACTS, BUNKER_ACTION_CARDS,
    ACTION_CARD_PHASES,
} = require('../public/games/bunker/attributes.js');
const { BUNKER_SCENARIOS } = require('../public/games/bunker/scenarios.js');

let _io;
let _db;

function init(io, db) {
    _io = io;
    _db = db;
}

const BUNKER_ATTR_LABELS = {
    profession: 'Професію', biology: 'Біологію', health: 'Здоров\'я',
    hobby: 'Хобі', trait: 'Рису характеру', baggage: 'Багаж', fact: 'Факт',
};
const BUNKER_PHASE_MS = {
    game_start:   60_000,
    round_reveal: 30_000,
    discussion:  120_000,
    voting:       60_000,
};

const BOT_NAMES = ['Мирослав-АІ', 'Оксана-АІ', 'Тарас-АІ', 'Ганна-АІ', 'Богдан-АІ', 'Лариса-АІ'];

function createBunkerState(roomPlayers, settings = {}) {
    const bunkerCapacity = Math.floor(roomPlayers.length / 2);

    let profs   = shuffle(BUNKER_PROFESSIONS);
    let healths = shuffle(BUNKER_HEALTH);
    let hobbies = shuffle(BUNKER_HOBBIES);
    let traits  = shuffle(BUNKER_TRAITS);
    let bags    = shuffle(BUNKER_BAGGAGE);
    let facts   = shuffle(BUNKER_FACTS);
    let actions = shuffle(BUNKER_ACTION_CARDS);

    const players = roomPlayers.map((rp) => {
        const isMale = Math.random() > 0.5;
        const gender = isMale ? 'Чоловік' : 'Жінка';
        const age    = Math.floor(Math.random() * (77 - 18 + 1)) + 18;
        const repro  = Math.random() > 0.2
            ? (isMale ? 'плідний' : 'плідна')
            : (isMale ? 'безплідний' : 'безплідна');
        return {
            id:       rp.index ?? roomPlayers.indexOf(rp),
            name:     rp.name,
            isBot:    rp.isBot || false,
            avatarId:    rp.avatarId    || null,
            avatarColor: rp.avatarColor || '#1a56db',
            isAlive:  true,
            isSilenced:     false,
            immunityRounds: 0,
            hasRevealed:    false,
            isOnline:       true,
            attributes: {
                profession: { value: profs.pop(),   isRevealed: false },
                biology:    { value: `${gender}, ${age} років, ${repro}`, isRevealed: false },
                health:     { value: healths.pop(), isRevealed: false },
                hobby:      { value: hobbies.pop(), isRevealed: false },
                trait:      { value: traits.pop(),  isRevealed: false },
                baggage:    { value: bags.pop(),    isRevealed: false },
                fact:       { value: facts.pop(),   isRevealed: false },
            },
            actionCards: [{ ...actions.pop(), used: false }],
            localMarkers: {},
        };
    });

    const scenarioId   = settings.scenarioId != null ? settings.scenarioId : Math.floor(Math.random() * BUNKER_SCENARIOS.length);
    const scenario     = BUNKER_SCENARIOS[scenarioId] || BUNKER_SCENARIOS[0];
    const timerEnabled = settings.timerEnabled !== false;

    return {
        gameType:       'bunker',
        phase:          'game_start',
        round:          0,
        bunkerCapacity,
        scenario,
        timerEnabled,
        players,
        votes:          {},
        timeDeadline:   null,
        log:            [],
        winner:         null,
        epilogue:       null,
        isSecretVoting: false,
        kumData:        null,
        quarantined:    [],
        tiebreaker:     null,
    };
}

function sanitizeBunker(state, forIdx) {
    return {
        gameType:       'bunker',
        phase:          state.phase,
        round:          state.round,
        bunkerCapacity: state.bunkerCapacity,
        scenario:       state.scenario,
        timerEnabled:   state.timerEnabled,
        timeDeadline:   state.timeDeadline,
        myId:           forIdx,
        players: state.players.map((p, i) => ({
            id:         p.id,
            name:       p.name,
            isBot:      p.isBot || false,
            isAlive:    p.isAlive,
            isOnline:   p.isOnline !== false,
            avatarId:   p.avatarId    || null,
            avatarColor: p.avatarColor || '#1a56db',
            isSilenced: p.isSilenced,
            immunityRounds: p.immunityRounds,
            hasRevealed:    p.hasRevealed,
            attributes: i === forIdx
                ? p.attributes
                : Object.fromEntries(
                    Object.entries(p.attributes).map(([k, v]) => [
                        k, v.isRevealed ? v : { value: '???', isRevealed: false }
                    ])
                ),
            actionCards: i === forIdx
                ? p.actionCards
                : p.actionCards.map(c => ({ id: c.id, name: c.name, used: c.used })),
        })),
        votes: (state.phase === 'voting' || state.phase === 'voting_result') && !state.isSecretVoting
            ? state.votes
            : state.phase === 'voting_result' && state.isSecretVoting
            ? state.votes
            : {},
        isSecretVoting: state.isSecretVoting || false,
        tiebreaker:     state.tiebreaker || null,
        quarantined:    state.quarantined || [],
        log:      state.log.slice(0, 40),
        winner:   state.winner,
        epilogue: state.epilogue || null,
    };
}

function emitBunkerUpdate(room) {
    room.players.forEach(rp => {
        if (!rp.socketId || rp.isBot) return;
        _io.to(rp.socketId).emit('stateUpdate', {
            state: sanitizeBunker(room.state, rp.index),
        });
    });
}

function generateLocalEpilogue(state) {
    const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
    const clean = val  => (val || '').split('(')[0].trim().toLowerCase();

    const survivors  = state.players.filter(p =>  p.isAlive);
    const eliminated = state.players.filter(p => !p.isAlive);
    const sc = state.scenario;

    // Пріоритет атрибутів: смішніші вище
    const PRIO = ['hobby', 'health', 'trait', 'baggage', 'profession', 'biology', 'fact'];
    const getAttr = (p, k) => p.attributes[k]?.isRevealed ? p.attributes[k].value : null;

    const highlight = (p) => {
        for (const k of PRIO) {
            const v = getAttr(p, k);
            if (v) return { name: p.name, key: k, val: v, short: clean(v) };
        }
        return { name: p.name, key: 'biology', val: '???', short: 'загадкова особистість' };
    };

    const hl = survivors.map(highlight);
    const h1 = hl[0] || { name: 'невідомий', short: 'невідомо', key: 'biology', val: '?' };
    const h2 = hl[1] || h1;

    const el  = eliminated[0];
    const el2 = eliminated[1];
    const elName  = el  ? el.name  : null;
    const elProf  = el  ? clean(getAttr(el, 'profession') || el.name) : null;
    const el2Name = el2 ? el2.name : null;

    const elPhrase = elName
        ? pick([
            `${elName} (${elProf}) залишився назовні — і, судячи з усього, не дуже скучив.`,
            `${elName} все ще десь там надворі. Принаймні, у бункері так думають.`,
            `Про ${elName} (${elProf}) вирішили більше не говорити вголос.`,
            `${elName} погрожував помстою — але що він може зробити? Він надворі.`,
        ])
        : pick([
            `Так і живуть. Усі разом. Без жодного варіанту вийти.`,
            `Усі вижили. Це, мабуть, найстрашніше.`,
        ]);

    const BUILDERS = [

        // 🎙️ BBC документалка
        () => {
            const open = pick([
                `Натуралісти зафіксували рідкісну адаптацію: популяція бункера «${sc.title}» стабільно розмножується — морально.`,
                `Через рік після закриття дверей бункера «${sc.title}» вчені нарешті отримали перші дані.`,
                `У природних умовах постапокаліпсису особина виду «виживший у бункері» поводиться несподівано.`,
            ]);
            const mid = pick([
                `${h1.name} — типовий представник виду — не полишив звички до ${h1.short}, що, за іронією долі, підвищує загальний моральний дух.`,
                `Особливо цікавить науковців ${h1.name}: попри закриті стіни, той/-та продовжує практикувати ${h1.short} з маніакальною наполегливістю.`,
                `${h2.name} демонструє захисну поведінку — ${h2.short} — яку спостерігачі спочатку сприйняли за симптом.`,
            ]);
            return `${open} ${mid} ${elPhrase}`;
        },

        // ⭐ TripAdvisor
        () => {
            const stars = pick(['★★☆☆☆', '★★★☆☆', '★☆☆☆☆', '★★★★☆']);
            const pro = pick([
                `є дах, ${h1.name} знає що робити`,
                `відносно сухо, ${h1.short} непогано скрашує вечори`,
                `виживання гарантоване (майже)`,
            ]);
            const con = pick([
                `${h2.name} займається ${h2.short} щоночі`,
                `харчування одноманітне, ${h2.name} скаржиться постійно`,
                `${h1.name} і ${h2.name} не можуть поділити запаси`,
            ]);
            const mgr = elName
                ? `Відповідь менеджменту: «Дякуємо! ${elName} (${elProf}) — це не наша помилка, це ваш вибір.»`
                : `Відповідь менеджменту: «Ми постійно покращуємо умови апокаліпсису. Чекайте оновлень.»`;
            return `${stars} Бункер «${sc.title}» — чесний відгук після року. Плюси: ${pro}. Мінуси: ${con}. ${mgr}`;
        },

        // 📰 Жовтий таблоїд
        () => {
            const head = pick([
                `СЕНСАЦІЯ: ${h1.name.toUpperCase()} (${h1.short.toUpperCase()}) ШОКУВАВ/-ЛА ВСІХ БУНКЕРНИКІВ!!!`,
                `СКАНДАЛ У БУНКЕРІ «${sc.title.toUpperCase()}»: ${h1.name.toUpperCase()} ВІДМОВЛЯЄТЬСЯ ДІЛИТИСЯ!!!`,
                `ТАЄМНИЦЯ РОЗКРИТА: ЩО НАСПРАВДІ РОБИТЬ ${h1.name.toUpperCase()} УНОЧІ В БУНКЕРІ!!!`,
            ]);
            const body = pick([
                `${h2.name} СТВЕРДЖУЄ: «${h2.short.toUpperCase()}» — ЦЕ КОНКУРЕНТНА ПЕРЕВАГА, А НЕ ПРОБЛЕМА!!!`,
                `ОЧЕВИДЦІ КАЖУТЬ: ${h2.name} ВСЕ ЩЕ ЗАЙМАЄТЬСЯ ${h2.short.toUpperCase()} — У БУНКЕРІ!!!`,
            ]);
            const el_line = elName
                ? `ВИГНАНИЙ ${elName.toUpperCase()} (${elProf?.toUpperCase()}) ЗАЯВИВ: «ЦЕ НЕ КІНЕЦЬ!!!» — ПІДПИСУЙТЕСЬ НА НАШ КАНАЛ!!!`
                : `БІЛЬШЕ ПОДРОБИЦЬ ПІСЛЯ РЕКЛАМИ ГРЕЧКИ!!!`;
            return `${head} ${body} ${el_line}`;
        },

        // 🧸 Темна казка
        () => {
            const open = pick([
                `Жили собі ${survivors.map(p => p.name).join(', ')} у підземному бункері під час ${sc.subtitle}.`,
                `В одному підземному царстві, коли надворі лютував ${sc.subtitle.toLowerCase()}, оселилося ${survivors.length} сміливих душ.`,
            ]);
            const mid = pick([
                `${h1.name} — найхоробріший/-а — щодня дивував/-ла всіх своїм ${h1.short}. ${h2.name} відповідав/-ла ${h2.short}.`,
                `${h1.name} (${h1.short}) спочатку здавався/-лась корисним/-ою. Потім — не дуже. А потім — знов корисним/-ою.`,
            ]);
            const moral = elName
                ? pick([
                    `А мораль: вигнати ${elName} (${elProf}) — легко. Жити з вибором — складніше.`,
                    `Мораль: ${elName} — надворі. Решта — у бункері. Хто щасливіший — невідомо.`,
                ])
                : pick([
                    `І жили вони довго та щасливо — у темряві, тісноті, але разом. Мораль: іноді «разом» — це вже вирок.`,
                    `Мораль: якщо вижив — заслужив. Якщо ні — теж, мабуть, заслужив.`,
                ]);
            return `${open} ${mid} ${moral}`;
        },

        // 📊 HR-звіт
        () => {
            const pct = pick([43, 67, 71, 88, 52, 95, 38]);
            const kpi = pick([
                `${h1.name} (компетенція: ${h1.short}) — оцінено «перевищує очікування для кінця світу» (3.7/5).`,
                `${h1.name} (посада: де-факто лідер) — показник виживання: ${pct}%. Зона для покращення: паніка.`,
            ]);
            const review = pick([
                `${h2.name} отримав/-ла зауваження щодо ${h2.short} — «недостатньо пов'язане з цілями бункера».`,
                `Компетенція ${h2.name} «${h2.short}» зафіксована як нерелевантна. Але хто ми такі, щоб судити.`,
            ]);
            const dismiss = elName
                ? `${elName} (${elProf}) — звільнено за скороченням. Пункт 7.3: «Невідповідність вимогам апокаліпсису».`
                : `Некомплект: 0 осіб. Продуктивність: задовільна для кінця цивілізації.`;
            return `Звіт HR-відділу. Бункер «${sc.title}». KPI виконано на ${pct}%. ${kpi} ${review} ${dismiss} Наступна атестація — якщо доживемо.`;
        },

        // ✉️ Лист додому
        () => {
            const greet = pick([`Привіт, мамо!`, `Дорогий щоденнику.`, `Звіт для онуків — якщо будуть:`]);
            const main = pick([
                `Уяви: ${h1.name} — той/-та, що займається ${h1.short} — виявився/-лась найкориснішим/-ою. Хто б міг подумати. ${h2.name} теж тримається.`,
                `Тут є ${h1.name} з ${h1.short}. В бункері ця навичка раптом стала найважливішою. ${h2.name} не погоджується, але мовчить.`,
            ]);
            const end = elName
                ? pick([
                    `${elName} не потрапив/-ла. Сподіваюсь, впорається. Хоча навряд.`,
                    `Передай привіт ${elName} — якщо побачиш. Хоча краще не треба.`,
                ])
                : `Загалом — живемо. Це, мабуть, головне. Цілую.`;
            return `${greet} ${main} ${end}`;
        },

        // 📚 Суха Вікіпедія
        () => {
            const open = pick([
                `Бункер «${sc.title}» (неофіційна назва) — задокументований кейс виживання ${survivors.length} осіб за умов ${sc.subtitle.toLowerCase()}.`,
                `Інцидент «${sc.title}»: колективне виживання тривалістю ${state.round || '?'} раундів при місткості бункера ${state.bunkerCapacity || '?'} осіб.`,
            ]);
            const note = pick([
                `Примітка: ${h1.name} (фах: ${h1.short}) документально підтверджено як «найбільш суперечливий вибір групи».`,
                `Особливий випадок: ${h1.name} (${h1.short}) продовжував/-ла звичну діяльність попри апокаліпсис — феномен, відомий як «бункерна нормалізація».`,
            ]);
            const ref = elName
                ? `Докладніше про ${elName} (${elProf}) — у розділі «Вигнані: причини та наслідки» (сторінка не існує).`
                : `Для самоперевірки: оцініть, чи оптимально розподілено ролі. (Правильна відповідь: ні.)`;
            return `${open} ${note} ${ref}`;
        },
    ];

    return pick(BUILDERS)();
}

function addBunkerLog(state, text) {
    state.log.unshift(text);
    if (state.log.length > 40) state.log.length = 40;
}

function clearBunkerTimer(room) {
    if (room.bunkerTimer) { clearTimeout(room.bunkerTimer); room.bunkerTimer = null; }
}

// TODO: Gemini bot decisions — розкоментувати коли буде робочий ключ
async function getBotDecisions(/* room, phase */) { return null; }
/*
async function getBotDecisions(room, phase) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === 'YOUR_KEY_HERE') return null;
    const s = room.state;
    const bots = s.players.filter(p => p.isBot && p.isAlive);
    if (!bots.length) return null;

    const playersDesc = s.players
        .filter(p => p.isAlive)
        .map(p => {
            const attrs = Object.entries(p.attributes)
                .map(([k, v]) => `${BUNKER_ATTR_LABELS[k]||k}: ${v.isRevealed ? v.value : '?'}`)
                .join(', ');
            return `${p.name}${p.isBot?' 🤖':''} (id=${p.id}): ${attrs}`;
        }).join('\n');

    let prompt = '';

    if (phase === 'round_reveal') {
        const botsNeedingReveal = bots.filter(p => !p.hasRevealed);
        if (!botsNeedingReveal.length) return null;
        const botsDesc = botsNeedingReveal.map(p => {
            const unrevealed = Object.keys(p.attributes).filter(k => !p.attributes[k].isRevealed);
            return `id=${p.id}, name="${p.name}", нерозкриті: [${unrevealed.join(', ')}]`;
        }).join('\n');

        prompt = `Ти керуєш ботами у грі "Бункер" (українська). Відповідай тільки українською.

Сценарій: "${s.scenario.title}" — ${s.scenario.disaster}
Бункер: ${s.scenario.bunker}. Мета: ${s.scenario.goal}
Місць у бункері: ${s.bunkerCapacity} з ${s.players.filter(p=>p.isAlive).length}. Раунд ${s.round}.

Атрибути гравців (? = приховано):
${playersDesc}

Боти що ходять зараз:
${botsDesc}

Для кожного бота вкажи:
- attr: що розкрити (один з нерозкритих — обери той що найкраще підкреслює корисність бота)
- message: 1-2 речення від першої особи — чому ти потрібен у бункері

Відповідь ТІЛЬКИ JSON (без markdown, без пояснень):
{"decisions":[{"index":ID,"attr":"ATTR","message":"TEXT"}]}`;

    } else if (phase === 'voting') {
        const botsToVote = bots.filter(p => s.votes[p.id] === undefined);
        if (!botsToVote.length) return null;
        const aliveList = s.players.filter(p => p.isAlive)
            .map(p => `id=${p.id} "${p.name}"${p.isBot?' (бот)':''}`).join(', ');

        prompt = `Ти керуєш ботами у грі "Бункер" (українська).

Сценарій: "${s.scenario.title}" — ${s.scenario.disaster}
Місць у бункері: ${s.bunkerCapacity} з ${s.players.filter(p=>p.isAlive).length}

Атрибути гравців:
${playersDesc}

Живі гравці: ${aliveList}
Боти що голосують: ${botsToVote.map(p=>`id=${p.id} "${p.name}"`).join(', ')}

Кожен бот голосує ПРОТИ одного гравця (найменш корисний для виживання в цьому сценарії). Не голосуй проти себе. Використовуй числовий id.

Відповідь ТІЛЬКИ JSON:
{"votes":[{"index":BOT_ID,"target":TARGET_ID}]}`;
    }

    if (!prompt) return null;
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-latest:generateContent?key=${key}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.85, maxOutputTokens: 600 },
                }),
                signal: AbortSignal.timeout(8_000),
            }
        );
        const json = await res.json();
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        return JSON.parse(match[0]);
    } catch (e) {
        console.error('[Bot] getBotDecisions error:', e.message);
        return null;
    }
}
*/

function scheduleBotActions(room, phase) {
    const bots = room.players.filter(p => p.isBot);
    if (!bots.length) return;

    if (phase === 'game_start') {
        setTimeout(() => {
            if (room.state?.phase !== 'game_start') return;
            bots.forEach(bp => {
                const p = room.state.players[bp.index];
                if (p && !p.hasRevealed) processBunkerAction(room, 'b_ready', {}, bp.index);
            });
        }, 1500);
        return;
    }

    if (phase === 'round_reveal') {
        setTimeout(async () => {
            if (room.state?.phase !== 'round_reveal') return;
            const data = await getBotDecisions(room, 'round_reveal');
            const botsToAct = bots.filter(bp => {
                const p = room.state?.players[bp.index];
                return p?.isAlive && !p.hasRevealed;
            });

            if (!data?.decisions?.length) {
                const FALLBACK_BOT_MSGS = [
                    'Я буду корисним для виживання в бункері!',
                    'Мої навички незамінні в кризовій ситуації.',
                    'Без мене команда не виживе.',
                    'Я готовий до будь-яких умов.',
                    'Мій досвід стане у нагоді всім.',
                    'Розраховуйте на мене в найскладніші моменти.',
                    'Я зроблю все можливе для виживання команди.',
                ];
                botsToAct.forEach((bp, i) => {
                    setTimeout(() => {
                        if (room.state?.phase !== 'round_reveal') return;
                        const p = room.state.players[bp.index];
                        if (!p?.isAlive || p.hasRevealed) return;
                        const attr = Object.keys(p.attributes).find(k => !p.attributes[k].isRevealed);
                        if (attr) {
                            processBunkerAction(room, 'b_revealAttr', { attr }, bp.index);
                            const msg = FALLBACK_BOT_MSGS[Math.floor(Math.random() * FALLBACK_BOT_MSGS.length)];
                            _io.to(room.code).emit('chatMessage', {
                                playerIndex: bp.index,
                                name: p.name,
                                color: '#88aaff',
                                icon: '🤖',
                                text: msg,
                            });
                        }
                    }, (i + 1) * 2500);
                });
                return;
            }

            data.decisions.forEach((d, i) => {
                setTimeout(() => {
                    if (room.state?.phase !== 'round_reveal') return;
                    const p = room.state.players[d.index];
                    if (!p?.isAlive || p.hasRevealed) return;
                    const attr = (p.attributes[d.attr] && !p.attributes[d.attr].isRevealed ? d.attr
                        : Object.keys(p.attributes).find(k => !p.attributes[k].isRevealed));
                    if (!attr) return;
                    processBunkerAction(room, 'b_revealAttr', { attr }, d.index);
                    if (d.message) {
                        _io.to(room.code).emit('chatMessage', {
                            playerIndex: d.index,
                            name: p.name,
                            color: '#88aaff',
                            icon: '🤖',
                            text: d.message,
                        });
                    }
                }, (i + 1) * 3000);
            });
        }, 5000);
        return;
    }

    if (phase === 'voting') {
        setTimeout(async () => {
            if (room.state?.phase !== 'voting') return;
            const data = await getBotDecisions(room, 'voting');
            const botsToVote = bots.filter(bp => {
                const p = room.state?.players[bp.index];
                return p?.isAlive && room.state?.votes[bp.index] === undefined;
            });

            if (!data?.votes?.length) {
                botsToVote.forEach((bp, i) => {
                    setTimeout(() => {
                        if (room.state?.phase !== 'voting') return;
                        const tb = room.state.tiebreaker;
                        const candidates = room.state.players.filter(p =>
                            p.isAlive && p.id !== bp.index && (!tb || tb.includes(p.id))
                        );
                        const target = candidates[Math.floor(Math.random() * candidates.length)]?.id;
                        if (target !== undefined) processBunkerAction(room, 'b_vote', { target }, bp.index);
                    }, (i + 1) * 2000);
                });
                return;
            }

            data.votes.forEach((v, i) => {
                setTimeout(() => {
                    if (room.state?.phase !== 'voting') return;
                    const p = room.state.players[v.index];
                    if (!p?.isAlive || room.state.votes[v.index] !== undefined) return;
                    processBunkerAction(room, 'b_vote', { target: v.target }, v.index);
                }, (i + 1) * 2500);
            });
        }, 4000);
        return;
    }
}

function startBunkerPhase(room, phase) {
    clearBunkerTimer(room);
    const s = room.state;
    s.phase = phase;
    if (s.timerEnabled) {
        const ms = BUNKER_PHASE_MS[phase] || 30_000;
        s.timeDeadline   = Date.now() + ms;
        room.bunkerTimer = setTimeout(() => onBunkerTimeout(room, phase), ms);
    } else {
        s.timeDeadline = null;
    }
    emitBunkerUpdate(room);
    scheduleBotActions(room, phase);
}

function onBunkerTimeout(room, phase) {
    if (!room.state || room.state.phase !== phase) return;
    const s = room.state;
    switch (phase) {
        case 'game_start':
            startBunkerRound(room);
            break;
        case 'round_reveal': {
            s.players.filter(p => p.isAlive && !p.hasRevealed).forEach(p => {
                const attr = Object.keys(p.attributes).find(k => !p.attributes[k].isRevealed);
                if (attr && p.attributes[attr]) {
                    p.attributes[attr].isRevealed = true;
                    addBunkerLog(s, `⏰ ${p.name} — авто-розкриття`);
                }
                // Якщо всі атрибути вже розкриті — просто позначаємо як «розкрився»
                p.hasRevealed = true;
            });
            startBunkerPhase(room, 'discussion');
            break;
        }
        case 'discussion':
            startBunkerPhase(room, 'voting');
            break;
        case 'voting':
            resolveBunkerVoting(room);
            break;
    }
}

function startBunkerRound(room) {
    const s = room.state;
    s.round++;
    s.votes          = {};
    s.isSecretVoting = false;
    s.kumData        = null;
    s.quarantined    = [];
    s.tiebreaker     = null;
    s.players.forEach(p => {
        p.hasRevealed = false;
        p.refutActive = false;
        if (p.isSilenced) p.isSilenced = false;
    });
    addBunkerLog(s, `📋 Раунд ${s.round} — розкриття карток`);
    startBunkerPhase(room, 'round_reveal');
}

function eliminatePlayers(room, toEliminate) {
    const s = room.state;
    toEliminate.forEach(p => {
        p.isAlive = false;
        Object.keys(p.attributes).forEach(k => { p.attributes[k].isRevealed = true; });
    });
    if (toEliminate.length === 1) {
        addBunkerLog(s, `🚫 ${toEliminate[0].name} покидає бункер`);
    } else {
        addBunkerLog(s, `🚫 Вигнані обидва: ${toEliminate.map(p => p.name).join(', ')}`);
    }

    const remaining = s.players.filter(p => p.isAlive);
    if (remaining.length <= s.bunkerCapacity) {
        s.phase        = 'end_game';
        s.winner       = remaining.map(p => p.id);
        s.timeDeadline = null;
        s.tiebreaker   = null;
        remaining.forEach(p => {
            Object.keys(p.attributes).forEach(k => { p.attributes[k].isRevealed = true; });
        });
        addBunkerLog(s, `🏆 Бункер зачиняється! Виживають: ${remaining.map(p => p.name).join(', ')}`);
        _db.saveGameStats(room, rp => s.winner.includes(rp.index));
        _db.saveGameHistory('bunker', null, s.round || 0,
            room.players.filter(p => p.username).map(rp => ({
                username: rp.username, name: rp.name, won: s.winner.includes(rp.index),
            }))
        );
        _db.deleteRoom(room.code);
        s.epilogue = generateLocalEpilogue(s);
        emitBunkerUpdate(room);
    } else {
        s.tiebreaker = null;
        startBunkerRound(room);
    }
}

function resolveBunkerVoting(room) {
    clearBunkerTimer(room);
    const s = room.state;
    s.phase = 'voting_result';
    s.timeDeadline = null;

    const counts = {};
    Object.values(s.votes).forEach(t => { counts[t] = (counts[t] || 0) + 1; });

    if (s.kumData) {
        const { voter, against } = s.kumData;
        if (s.votes[voter] === against) {
            counts[against] = (counts[against] || 0) + 2;
            addBunkerLog(s, `🤝 Кумівство спрацювало: +2 голоси проти ${s.players[against]?.name}`);
        }
        s.kumData = null;
    }

    const alive    = s.players.filter(p => p.isAlive);
    const maxVotes = alive.reduce((m, p) => Math.max(m, counts[p.id] || 0), 0);
    const tied     = alive.filter(p => (counts[p.id] || 0) === maxVotes && maxVotes > 0);

    addBunkerLog(s, `🗳️ Голосування завершено`);
    emitBunkerUpdate(room);

    setTimeout(() => {
        if (!room.state || room.state.phase !== 'voting_result') return;

        if (tied.length === 0) {
            addBunkerLog(s, '🤷 Ніхто не проголосував — раунд пропущено');
            s.tiebreaker = null;
            startBunkerRound(room);
            return;
        }

        if (tied.length === 1) {
            let toEliminate = tied[0];
            // act_refut: повністю скасовує вигнання, новий раунд без жертв
            if (toEliminate.refutActive) {
                toEliminate.refutActive = false;
                addBunkerLog(s, `🛡️ ${toEliminate.name} спростував вигнання — гра продовжується!`);
                s.tiebreaker = null;
                startBunkerRound(room);
                return;
            }
            // Звичайний імунітет (act_luz, act_donat): захищає, але вигнання передається наступному
            if (toEliminate.immunityRounds > 0) {
                toEliminate.immunityRounds--;
                addBunkerLog(s, `🛡️ ${toEliminate.name} має імунітет — захищений!`);
                const next = alive
                    .filter(p => p.id !== toEliminate.id)
                    .sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0))[0];
                if (next) {
                    toEliminate = next;
                    addBunkerLog(s, `👉 Замість нього вигнано ${toEliminate.name}`);
                }
            }
            eliminatePlayers(room, [toEliminate]);
            return;
        }

        if (s.tiebreaker) {
            addBunkerLog(s, `⚖️ Повторна нічия — виганяються всі: ${tied.map(p => p.name).join(', ')}`);
            eliminatePlayers(room, tied);
        } else {
            addBunkerLog(s, `⚖️ Нічия між ${tied.map(p => p.name).join(', ')} — повторне голосування!`);
            s.tiebreaker = tied.map(p => p.id);
            s.votes      = {};
            startBunkerPhase(room, 'voting');
        }
    }, 4000);
}

function processBunkerAction(room, type, data, pidx) {
    const s   = room.state;
    const p   = s.players[pidx];
    if (!p) return;
    const requiresAlive = !['b_endDiscussion', 'b_endVoting'].includes(type);
    if (requiresAlive && !p.isAlive) return;

    switch (type) {
        case 'b_ready': {
            if (s.phase !== 'game_start') break;
            p.hasRevealed = true;
            addBunkerLog(s, `✅ ${p.name} готовий`);
            const allReady = s.players.every(pl => pl.hasRevealed);
            if (allReady) {
                s.players.forEach(pl => { pl.hasRevealed = false; });
                clearBunkerTimer(room);
                startBunkerRound(room);
                return;
            }
            emitBunkerUpdate(room);
            break;
        }

        case 'b_revealAttr': {
            if (s.phase !== 'round_reveal') break;
            if (p.hasRevealed) break;
            const { attr } = data;

            const allAlreadyRevealed = Object.values(p.attributes).every(a => a.isRevealed);
            if (allAlreadyRevealed) {
                // Всі атрибути вже розкриті — просто позначаємо готовим
                p.hasRevealed = true;
                addBunkerLog(s, `✅ ${p.name} — всі атрибути вже відкриті`);
            } else {
                if (!attr || !p.attributes[attr]) break;
                if (p.attributes[attr].isRevealed) break;
                p.attributes[attr].isRevealed = true;
                p.hasRevealed = true;
                addBunkerLog(s, `🔓 ${p.name} розкрив(ла) ${BUNKER_ATTR_LABELS[attr]}`);
            }

            const allRevealed = s.players.filter(pl => pl.isAlive).every(pl => pl.hasRevealed);
            if (allRevealed) {
                clearBunkerTimer(room);
                startBunkerPhase(room, 'discussion');
                return;
            }
            emitBunkerUpdate(room);
            break;
        }

        case 'b_endDiscussion': {
            if (s.phase !== 'discussion') break;
            if (pidx !== 0) break;
            addBunkerLog(s, `⚡ ${p.name} завершив обговорення`);
            startBunkerPhase(room, 'voting');
            return;
        }

        case 'b_endVoting': {
            if (s.phase !== 'voting') break;
            if (pidx !== 0) break;
            addBunkerLog(s, `⚡ ${p.name} завершив голосування`);
            resolveBunkerVoting(room);
            return;
        }

        case 'b_vote': {
            if (s.phase !== 'voting') break;
            if (s.votes[p.id] !== undefined) break;
            if (s.quarantined?.includes(p.id)) break;
            const { target } = data;
            if (typeof target !== 'number') break;
            const targetP = s.players[target];
            if (!targetP?.isAlive || target === p.id) break;
            if (s.tiebreaker && !s.tiebreaker.includes(target)) break;

            s.votes[p.id] = target;
            addBunkerLog(s, `🗳️ ${p.name} проголосував(ла)`);

            const aliveIds  = s.players.filter(pl => pl.isAlive && !s.quarantined?.includes(pl.id)).map(pl => pl.id);
            const allVoted  = aliveIds.every(id => s.votes[id] !== undefined);
            if (allVoted) {
                clearBunkerTimer(room);
                resolveBunkerVoting(room);
                return;
            }
            emitBunkerUpdate(room);
            break;
        }

        case 'b_useCard': {
            const { cardId, target } = data;
            const card = p.actionCards.find(c => c.id === cardId && !c.used);
            if (!card) break;
            // Серверна валідація фази — картку можна зіграти лише у дозволеній фазі
            const allowedPhases = ACTION_CARD_PHASES[cardId];
            if (allowedPhases && !allowedPhases.includes(s.phase)) break;
            card.used = true;
            applyBunkerCard(room, card, pidx, target);
            break;
        }
    }
}

function applyBunkerCard(room, card, pidx, target) {
    const s = room.state;
    const p = s.players[pidx];

    switch (card.id) {
        case 'act_luz':
            p.immunityRounds = Math.max(p.immunityRounds, 1);
            addBunkerLog(s, `🎵 ${p.name} зіграв «Ой, у лузі...» — імунітет!`);
            break;
        case 'act_lustr': {
            const t = s.players[target];
            if (!t) break;
            // Спочатку health/trait, якщо обидва вже відкриті — будь-який прихований атрибут
            const hidden = ['health', 'trait'].find(k => !t.attributes[k].isRevealed)
                        || Object.keys(t.attributes).find(k => !t.attributes[k].isRevealed);
            if (hidden) {
                t.attributes[hidden].isRevealed = true;
                addBunkerLog(s, `🔍 ${p.name} — Люстрація: розкрито ${BUNKER_ATTR_LABELS[hidden]} гравця ${t.name}`);
            } else {
                addBunkerLog(s, `🔍 ${p.name} — Люстрація: у ${t.name} вже все відкрито`);
            }
            break;
        }
        case 'act_bribe': {
            const t = s.players[target];
            if (!t) break;
            const myBag = p.attributes.baggage.value;
            p.attributes.baggage.value = t.attributes.baggage.value;
            t.attributes.baggage.value = myBag;
            addBunkerLog(s, `💰 ${p.name} — Хабар: обмін багажем з ${t.name}`);
            break;
        }
        case 'act_ban': {
            const t = s.players[target];
            if (!t) break;
            t.isSilenced = true;
            addBunkerLog(s, `🔇 ${p.name} — Тіньовий бан: ${t.name} не може писати в наступному раунді`);
            break;
        }
        case 'act_martial':
            if (s.phase === 'voting') {
                s.votes = {};
                addBunkerLog(s, `⚔️ ${p.name} — Воєнний стан: голосування скасовано!`);
                clearBunkerTimer(room);
                startBunkerRound(room);
                return;
            }
            break;
        case 'act_donat':
            p.immunityRounds = 2;
            p.attributes.baggage.value = 'Порожні руки (донат на ЗСУ)';
            addBunkerLog(s, `🫡 ${p.name} — Донат на ЗСУ: імунітет 2 раунди`);
            break;
        case 'act_breath': {
            const newHealth = BUNKER_HEALTH[Math.floor(Math.random() * BUNKER_HEALTH.length)];
            p.attributes.health.value = newHealth;
            addBunkerLog(s, `💨 ${p.name} — Друге дихання: нове здоров'я!`);
            break;
        }
        case 'act_prof': {
            const newProf = BUNKER_PROFESSIONS[Math.floor(Math.random() * BUNKER_PROFESSIONS.length)];
            p.attributes.profession.value = newProf;
            addBunkerLog(s, `📋 ${p.name} — Перекваліфікація: нова професія!`);
            break;
        }
        case 'act_bavovna': {
            const t = s.players[target];
            if (!t?.isAlive) break;
            t.attributes.baggage.value = '💥 Спалений брухт — нічого немає';
            t.attributes.baggage.isRevealed = true;
            addBunkerLog(s, `💥 ${p.name} — Бавовна: багаж ${t.name} знищено!`);
            break;
        }
        case 'act_human': {
            const t = s.players[target] || p;
            const extra = BUNKER_BAGGAGE[Math.floor(Math.random() * BUNKER_BAGGAGE.length)];
            const extraName = extra.split('(')[0].trim();
            t.attributes.baggage.value += ` + ${extraName}`;
            addBunkerLog(s, `📦 ${p.name} — Гуманітарка: ${t.name} отримав додатковий предмет!`);
            break;
        }
        case 'act_kum': {
            const t = s.players[target];
            if (!t?.isAlive) break;
            s.kumData = { voter: pidx, against: target };
            addBunkerLog(s, `🤝 ${p.name} — Кумівство: голос проти ${t.name} рахуватиметься втричі!`);
            break;
        }
        case 'act_quar': {
            const t = s.players[target];
            if (!t?.isAlive) break;
            if (!s.quarantined.includes(target)) s.quarantined.push(target);
            addBunkerLog(s, `🏥 ${p.name} — Карантин: ${t.name} не зможе голосувати!`);
            break;
        }
        case 'act_reform': {
            s.players.filter(pl => pl.isAlive).forEach(pl => {
                pl.attributes.health.value = BUNKER_HEALTH[Math.floor(Math.random() * BUNKER_HEALTH.length)];
                pl.attributes.health.isRevealed = true;
            });
            addBunkerLog(s, `💊 ${p.name} — Медична реформа: всі отримали нове здоров'я!`);
            break;
        }
        case 'act_blackout':
            s.isSecretVoting = true;
            addBunkerLog(s, `🌑 ${p.name} — Блекаут: голосування буде таємним!`);
            break;
        case 'act_deport': {
            const t = s.players[target];
            if (!t?.isAlive) break;
            const myTrait = p.attributes.trait.value;
            const myRev   = p.attributes.trait.isRevealed;
            p.attributes.trait.value      = t.attributes.trait.value;
            p.attributes.trait.isRevealed = t.attributes.trait.isRevealed;
            t.attributes.trait.value      = myTrait;
            t.attributes.trait.isRevealed = myRev;
            addBunkerLog(s, `🔄 ${p.name} — Депортація: обмін рисами з ${t.name}!`);
            break;
        }
        case 'act_nat': {
            const alive  = s.players.filter(pl => pl.isAlive);
            const bags   = shuffle(alive.map(pl => pl.attributes.baggage.value));
            alive.forEach((pl, i) => {
                pl.attributes.baggage.value = bags[i];
                pl.attributes.baggage.isRevealed = true;
            });
            addBunkerLog(s, `🏛️ ${p.name} — Націоналізація: весь багаж перерозподілено!`);
            break;
        }
        case 'act_refut':
            // act_refut повністю скасовує вигнання (новий раунд без усунення)
            // НЕ immunityRounds — щоб не передавати вигнання наступному гравцю
            addBunkerLog(s, `🛡️ ${p.name} грає «Спростування»`);
            p.refutActive = true;
            p.isAlive = true;
            break;
        default:
            addBunkerLog(s, `🃏 ${p.name} зіграв «${card.name}»`);
    }
    emitBunkerUpdate(room);
}

module.exports = {
    init,
    createBunkerState,
    sanitizeBunker,
    emitBunkerUpdate,
    processBunkerAction,
    startBunkerPhase,
    startBunkerRound,
    clearBunkerTimer,
    resolveBunkerVoting,
    addBunkerLog,
    BUNKER_ATTR_LABELS,
    BOT_NAMES,
};
