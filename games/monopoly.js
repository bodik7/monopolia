// ============================================
// МОНОПОЛІЯ — серверна логіка
// ============================================
const { BOARD, TOKEN_COLORS, TOKEN_ICONS } = require('../public/shared/monopoly-board.js');
const { CHANCE_CARDS, EXCURSION_CARDS }    = require('../public/games/monopoly/messages.js');
const { shuffle, addLog } = require('./utils.js');

let _io;
function init(io) { _io = io; }

// ── Ініціалізація стану ────────────────────────
function createGameState(roomPlayers) {
    const players = roomPlayers.map((rp, i) => ({
        id: i, socketId: rp.socketId, name: rp.name,
        color: TOKEN_COLORS[i], icon: TOKEN_ICONS[i],
        money: 1500, position: 0, properties: [],
        inJail: false, jailTurns: 0, hasJailCard: false,
        bankrupt: false, loan: 0, loanInterest: 0, loanTurnsLeft: 0,
        stats: { rentPaid: 0, rentReceived: 0, housesBuilt: 0, hotelsBuilt: 0, taxesPaid: 0, cardsTotal: 0 },
        avatarId: rp.avatarId || null,
        avatarColor: rp.avatarColor || '#1a56db',
    }));
    const cellState = {};
    BOARD.forEach(c => {
        if (c.type === 'property' || c.type === 'railway' || c.type === 'utility')
            cellState[c.pos] = { owner: null, houses: 0, mortgaged: false };
    });
    return {
        players, cellState,
        currentPlayerIndex: 0, lastDiceRoll: [0, 0],
        doublesCount: 0, hasRolled: false,
        chanceDeck: shuffle(CHANCE_CARDS.map((_, i) => i)),
        excursionDeck: shuffle(EXCURSION_CARDS.map((_, i) => i)),
        auctionState: null, pendingTrade: null, log: [],
        pendingAction: null, pendingData: null,
        turnDeadline: null, tradeDeadline: null,
    };
}

function sanitize(state) {
    return {
        players: state.players, cellState: state.cellState,
        currentPlayerIndex: state.currentPlayerIndex, lastDiceRoll: state.lastDiceRoll,
        hasRolled: state.hasRolled, doublesCount: state.doublesCount,
        auctionState: state.auctionState, pendingTrade: state.pendingTrade,
        log: state.log, pendingAction: state.pendingAction, pendingData: state.pendingData,
        turnDeadline: state.turnDeadline, tradeDeadline: state.tradeDeadline,
    };
}

// ── Внутрішня логіка ───────────────────────────
function checkDebtCleared(state, player) {
    if (state.pendingAction === 'coverDebt' && player.money >= 0) {
        state.pendingAction = null; state.pendingData = null;
        addLog(state, `✅ ${player.name} покрив(ла) борг — можна продовжувати`, 'success');
    }
}

function checkForcedDebt(state, player) {
    if (player.money >= 0) return false;
    const netWorth = calcNetWorth(state, player);
    if (netWorth <= 0) {
        addLog(state, `💀 ${player.name} не може покрити борг і оголошує банкрутство!`, 'error');
        player.properties.forEach(pos => {
            state.cellState[pos].owner = null; state.cellState[pos].houses = 0; state.cellState[pos].mortgaged = false;
        });
        player.money = 0; player.bankrupt = true; player.properties = [];
        state.pendingAction = null; state.pendingData = null;
        return true;
    }
    const shortfall = -player.money;
    addLog(state, `⚠️ ${player.name} у мінусі ₴${shortfall} — продайте майно або оголосіть банкрутство`, 'error');
    state.pendingAction = 'coverDebt'; state.pendingData = { shortfall };
    return false;
}

function calcNetWorth(state, player) {
    let total = player.money;
    player.properties.forEach(pos => {
        const c = BOARD[pos]; const s = state.cellState[pos];
        total += s.mortgaged ? Math.floor(c.price / 2) : c.price;
        total += s.houses === 5 ? (c.housePrice || 0) * 5 : s.houses * (c.housePrice || 0);
    });
    total -= (player.loan || 0) + (player.loanInterest || 0);
    return total;
}

function calculateRent(state, cell) {
    const s = state.cellState[cell.pos];
    if (cell.type === 'property') {
        const group = BOARD.filter(b => b.type === 'property' && b.color === cell.color);
        const allSame = group.every(b => state.cellState[b.pos]?.owner === s.owner);
        let rent = cell.rent[s.houses];
        if (s.houses === 0 && allSame) rent *= 2;
        return rent;
    }
    if (cell.type === 'railway') {
        const owned = BOARD.filter(b => b.type === 'railway' && state.cellState[b.pos]?.owner === s.owner).length;
        return [0, 25, 50, 100, 200][owned];
    }
    if (cell.type === 'utility') {
        const owned = BOARD.filter(b => b.type === 'utility' && state.cellState[b.pos]?.owner === s.owner).length;
        const total = state.lastDiceRoll[0] + state.lastDiceRoll[1];
        return owned === 1 ? total * 4 : total * 10;
    }
    return 0;
}

function goToJail(state, player) {
    player.position = 10; player.inJail = true; player.jailTurns = 0;
    state.hasRolled = true; state.doublesCount = 0;
}

function moveTo(state, player, pos) {
    if (pos < player.position) {
        player.money += 200;
        addLog(state, `💰 ${player.name} пройшов(ла) через СТАРТ. +₴200`, 'success');
    }
    player.position = pos;
}

function drawCard(state, player, type) {
    let deck = type === 'chance' ? state.chanceDeck : state.excursionDeck;
    const cards = type === 'chance' ? CHANCE_CARDS : EXCURSION_CARDS;
    if (deck.length === 0) {
        deck = shuffle(cards.map((_, i) => i));
        if (type === 'chance') state.chanceDeck = deck; else state.excursionDeck = deck;
    }
    const idx = deck.shift();
    const card = cards[idx];
    player.stats.cardsTotal++;
    addLog(state, `🃏 ${player.name}: ${card.text}`, 'success');
    let nextEffect = null;
    switch (card.action) {
        case 'addMoney':    player.money += card.amount; break;
        case 'takeMoney':   player.money -= card.amount; checkForcedDebt(state, player); break;
        case 'goToStart':   moveTo(state, player, 0); break;
        case 'goToJail':    goToJail(state, player); break;
        case 'jailCard':    player.hasJailCard = true; break;
        case 'moveTo':      moveTo(state, player, card.pos); nextEffect = handleLanding(state, player); break;
        case 'moveBack':    player.position = (player.position - card.amount + 40) % 40; nextEffect = handleLanding(state, player); break;
        case 'payAll': {
            const alive = state.players.filter(p => !p.bankrupt && p.id !== player.id);
            alive.forEach(p => { const pay = Math.min(card.amount, Math.max(0, player.money)); player.money -= pay; p.money += pay; });
            break;
        }
        case 'collectAll': {
            const alive = state.players.filter(p => !p.bankrupt && p.id !== player.id);
            alive.forEach(p => { const pay = Math.min(card.amount, Math.max(0, p.money)); p.money -= pay; player.money += pay; });
            break;
        }
        case 'nearestRailway': {
            const railways = BOARD.filter(b => b.type === 'railway').map(b => b.pos);
            const next = railways.find(p => p > player.position) || railways[0];
            moveTo(state, player, next); nextEffect = handleLanding(state, player);
            break;
        }
    }
    return { event: 'cardDrawn', cardType: type, text: card.text, nextEffect };
}

function handleLanding(state, player) {
    const cell = BOARD[player.position];
    if (!cell) return null;
    if (cell.type === 'property' || cell.type === 'railway' || cell.type === 'utility') {
        const s = state.cellState[cell.pos];
        if (s.owner === null || s.owner === undefined) {
            state.pendingAction = 'offerPurchase'; state.pendingData = { pos: cell.pos };
            return { event: 'offerPurchase', cell };
        } else if (s.owner !== player.id && !s.mortgaged) {
            const rent = calculateRent(state, cell);
            if (rent > 0) {
                state.pendingAction = 'payRent'; state.pendingData = { pos: cell.pos, rent, ownerId: s.owner };
                return { event: 'payRent', rent, owner: state.players[s.owner], cell };
            }
        }
    } else if (cell.type === 'tax') {
        player.money -= cell.amount; player.stats.taxesPaid += cell.amount;
        checkForcedDebt(state, player);
        const taxReasons = cell.pos === 4 ? [
            `🍺 ${player.name} сплачує податок за розпиття пива «Опілля» на вулицях Львова без письмового погодження з міською радою. ₴${cell.amount}`,
            `🌿 Сусід поскаржився, що трава на подвір'ї у ${player.name} зеленіша, ніж у нього. Введено екстрений податок на надмірний оптимізм лужка. ₴${cell.amount}`,
            `🐈 У ${player.name} живе аж троє котів. Держава все порахувала. Це податок на надлишок пухнастого щастя. ₴${cell.amount}`,
            `☀️ Податкова помітила, що у ${player.name} надто гарний настрій як для ранку понеділка. Це підозріло. Сплатіть збір за приховування стресу. ₴${cell.amount}`,
            `🥣 ${player.name} їв(ла) вівсянку на сніданок замість патріотичної гречки. ДПС кваліфікує це як несанкціонований імпорт західної культури. ₴${cell.amount}`,
            `📸 ${player.name} зробив(ла) фото своєї кави в інстаграм перед тим, як випити. Податок на мікроінфлюенсерство. ₴${cell.amount}`,
            `🧦 ${player.name} носить різні шкарпетки. Митниця оцінила це як незаконне ввезення елементів авангардної моди. ₴${cell.amount}`,
            `🌧️ ${player.name} поскаржив(ла)ся на погоду в соцмережах. Нараховано екологічний збір за незадоволення кліматичною зоною. ₴${cell.amount}`,
            `🏋️ ${player.name} записав(ла)ся до спортзалу в січні й кинув(ла) у лютому. Штраф від ДПС за нереалізовані спортивні амбіції. ₴${cell.amount}`,
            `🐕 Собака ${player.name} гавкав на перехожих о 6 ранку. Сусіди об'єднались у кооператив і виставили колективний позов. ₴${cell.amount}`,
            `📝 ${player.name} надіслав(ла) листівку Азарову на день народження «суто заради іронії». ДПС ретельно вивчила ваші зв'язки. ₴${cell.amount}`,
            `🍯 ${player.name} відмовив(ла)ся від фірмового меду і замовив(ла) штучний сироп. Спілка пасічників зафіксувала бджолину зраду. ₴${cell.amount}`,
            `🪅 ${player.name} купив(ла) на барахолці матрьошку «для приколу». Митники не зрозуміли тонкого постмодернізму. Штраф. ₴${cell.amount}`,
            `🗣️ ${player.name} спробував(ла) відтворити «азарівку» для сміху на камеру. Відео потрапило в інтернет, тепер це офіційний доказ філологічного злочину. ₴${cell.amount}`,
            `🏚️ ${player.name} назвав(ла) Межигір'я «звичайною дачею». Гільдія оцінювачів нерухомості вимагає компенсацію за образу елітного майна. ₴${cell.amount}`,
        ] : [
            `👟 ${player.name} придбав(ла) п'яту пару кросівок за цей місяць. Розкішне життя саме себе не оподаткує. ₴${cell.amount}`,
            `✈️ ${player.name} летів(ла) лоукостером і посмів(ла) попросити у бортпровідника склянку води без газу. Розкіш зафіксовано. Сплатіть ₴${cell.amount}`,
            `🧴 ${player.name} купив(ла) крем для обличчя, який коштує дорожче, ніж середня пенсія. Миттєвий податок на гламур. ₴${cell.amount}`,
            `🍾 На вечірці у ${player.name} відкоркували шампанське у неділю ще до 18:00. Пряме порушення кодексу скромності. ₴${cell.amount}`,
            `🚗 ${player.name} помив(ла) машину на дорогій мийці, а за годину пішов злива. Карма і податкова інспекція діють спільно. ₴${cell.amount}`,
            `🛴 ${player.name} орендував(ла) електросамокат на цілу годину і весь день розповідав(ла) про це друзям. Збір за хвастощі. ₴${cell.amount}`,
            `🥩 ${player.name} замовив(ла) стейк прожарки medium rare і прочитав(ла) офіціанту лекцію про мармуровість яловичини. Штраф за гастрономічний снобізм. ₴${cell.amount}`,
            `🎲 ${player.name} грав(ла) у настільні ігри з преміальними дерев'яними фішками. Розкішний збір від заздрісних суперників. ₴${cell.amount}`,
            `👜 ${player.name} купив(ла) брендову паперову сумочку і носить у ній судочки з обідом на роботу. Податок на недоречний шик. ₴${cell.amount}`,
            `🍜 ${player.name} їв(ла) мівіну елітними китайськими паличками, хоча виделка лежала поруч. Претензії від лобі виробників столових приборів. ₴${cell.amount}`,
        ];
        const taxReason = taxReasons[Math.floor(Math.random() * taxReasons.length)];
        addLog(state, `💸 ${taxReason}`, 'warn');
        return { event: 'tax', amount: cell.amount, cellPos: cell.pos, reason: taxReason };
    } else if (cell.type === 'card') {
        return drawCard(state, player, cell.cardType);
    } else if (cell.pos === 30) {
        const jailReasons = [
            `🎵 ${player.name} спіймали на публічному прослуховуванні російського репу без навушників. До В'ЯЗНИЦІ!`,
            `🗣️ У центрі Львова хтось почув, як ${player.name} ностальгує за «стабільністю» часів Януковича. Пакуйте речі, В'ЯЗНИЦЯ чекає!`,
            `🪆 На митниці у ${player.name} в чемодані знайшли три розписні матрьошки. Пояснення «це на подарунок тещі» не спрацювало. В'ЯЗНИЦЯ!`,
            `📺 ${player.name} дивив(ла)ся нишком заборонені серіали через VPN замість вітчизняного контенту. Порушення кібербезпеки. До В'ЯЗНИЦІ!`,
            `🥟 ${player.name} назвав(ла) справжні українські вареники пельменями. Ображені кухарі написали заяву. В'ЯЗНИЦЯ!`,
            `🌊 ${player.name} публічно запевнив(ла), що Крим — «це просто шматок землі». Порушення географічної та державної логіки. Вирушайте до В'ЯЗНИЦІ!`,
            `🚗 ${player.name} припаркував(ла) свій елітний кросовер на місці для людей з інвалідністю біля супермаркету «на одну секундочку». Справедливість є — В'ЯЗНИЦЯ!`,
            `📱 ${player.name} надіслав(ла) в месенджері голосове повідомлення тривалістю 12 хвилин замість тексту. Суспільство не пробачає таких злочинів. В'ЯЗНИЦЯ!`,
            `🐱 ${player.name} пройшов(ла) повз дворового кота і навіть не спробував(ла) його погладити. Кіт звернувся до органів. В'ЯЗНИЦЯ!`,
            `🧂 ${player.name} густо посолив(ла) та поперчив(ла) борщ ще до того, як спробував(ла) першу ложку. Мама чи господиня таке не пробачає. До В'ЯЗНИЦІ!`,
            `🫖 ${player.name} заварив(ла) пакетик чаю в мікрохвильовці. Британське посольство висловило офіційний протест. В'ЯЗНИЦЯ!`,
            `🤳 ${player.name} намагався(лась) залізти на пам'ятник архітектури заради невдалого відео в ТікТок. Культурна поліція на місці. До В'ЯЗНИЦІ!`,
        ];
        const jailReason = jailReasons[Math.floor(Math.random() * jailReasons.length)];
        goToJail(state, player);
        addLog(state, `👮 ${jailReason}`, 'warn');
        return { event: 'goToJail', reason: jailReason };
    } else if (cell.type === 'casino') {
        addLog(state, `🎰 ${player.name} зайшов(ла) до КАЗИНО — зроби ставку!`);
        state.pendingAction = 'casino'; state.pendingData = { pos: 20 };
        return { event: 'casino', playerMoney: player.money };
    }
    return null;
}

function nextPlayer(state) {
    state.pendingAction = null; state.pendingData = null;
    const cur = state.players[state.currentPlayerIndex];
    if (cur.loan > 0 && cur.loanTurnsLeft > 0) cur.loanTurnsLeft--;
    state.doublesCount = 0; state.hasRolled = false;
    const totalPlayers = state.players.length;
    let steps = 0;
    do {
        state.currentPlayerIndex = (state.currentPlayerIndex + 1) % totalPlayers;
        if (++steps > totalPlayers) return null;
    } while (state.players[state.currentPlayerIndex].bankrupt);
    const next = state.players[state.currentPlayerIndex];
    if (next.inJail) return { event: 'inJail', player: next };
    if (next.loan > 0) {
        if (next.loanTurnsLeft === 1) return { event: 'loanWarning', player: next };
        if (next.loanTurnsLeft <= 0) {
            const total = next.loan + next.loanInterest;
            if (next.money >= total) {
                next.money -= total; next.loan = 0; next.loanInterest = 0; next.loanTurnsLeft = 0;
                addLog(state, `🏦 Банк автоматично списав борг ₴${total} з ${next.name}`, 'warn');
            } else {
                next.money -= total; next.loan = 0; next.loanInterest = 0; next.loanTurnsLeft = 0;
                addLog(state, `🏦 Банк примусово списав кредит ₴${total} — ${next.name} у мінусі!`, 'error');
                const netWorth = calcNetWorth(state, next);
                if (netWorth <= 0) {
                    addLog(state, `💀 ${next.name} нічим покрити борг — банкрутство!`, 'error');
                    next.properties.forEach(pos => { state.cellState[pos].owner = null; state.cellState[pos].houses = 0; state.cellState[pos].mortgaged = false; });
                    next.money = 0; next.bankrupt = true; next.properties = [];
                    return nextPlayer(state);
                }
                state.pendingAction = 'coverDebt'; state.pendingData = { shortfall: -next.money };
                return { event: 'loanDeadline', player: next };
            }
        }
    }
    return null;
}

function awardAuction(state, a) {
    const winner = state.players[a.currentBidder];
    if (winner.money < a.currentBid) {
        addLog(state, `💀 ${winner.name} не може сплатити аукціон ₴${a.currentBid} — скасовано`, 'error');
        state.auctionState = null; return;
    }
    winner.money -= a.currentBid;
    state.cellState[a.cell.pos].owner = a.currentBidder;
    winner.properties.push(a.cell.pos);
    addLog(state, `🔨 ${winner.name} виграв(ла) аукціон "${a.cell.name}" за ₴${a.currentBid}`, 'success');
    state.auctionState = null;
}

// ── Обробка дій від клієнта ───────────────────
function processAction(state, type, data, room) {
    const player = state.players[state.currentPlayerIndex];
    let sideEffect = null;
    switch (type) {
        case 'rollDice': {
            if (state.hasRolled) break;
            const d1 = Math.floor(Math.random() * 6) + 1;
            const d2 = Math.floor(Math.random() * 6) + 1;
            state.lastDiceRoll = [d1, d2];
            const isDouble = d1 === d2;
            if (isDouble) state.doublesCount++; else state.doublesCount = 0;
            addLog(state, `🎲 ${player.name} кинув(ла) ${d1}+${d2}=${d1+d2}${isDouble ? ' (дубль!)' : ''}`, '');
            if (player.inJail) {
                if (isDouble) {
                    player.inJail = false; player.jailTurns = 0; state.doublesCount = 0; state.hasRolled = true;
                    addLog(state, `🔓 ${player.name} вийшов(ла) з В'язниці дублем!`, 'success');
                } else {
                    player.jailTurns++;
                    if (player.jailTurns >= 3) {
                        player.money -= 50; player.inJail = false;
                        addLog(state, `💸 ${player.name} сплатив(ла) ₴50 і вийшов(ла) з В'язниці`, 'warn');
                        checkForcedDebt(state, player);
                    } else {
                        state.hasRolled = true;
                        addLog(state, `🔒 ${player.name} залишається у В'язниці (хід ${player.jailTurns}/3)`, 'warn');
                        break;
                    }
                }
            }
            if (state.doublesCount >= 3) {
                addLog(state, `👮 Три дублі поспіль — ${player.name} до В'ЯЗНИЦІ!`, 'warn');
                goToJail(state, player); break;
            }
            if (!isDouble) state.hasRolled = true;
            player.position = (player.position + d1 + d2) % 40;
            const prevPos = ((player.position - d1 - d2) % 40 + 40) % 40;
            if (prevPos + d1 + d2 >= 40) {
                player.money += 200;
                addLog(state, `💰 ${player.name} пройшов(ла) через СТАРТ. +₴200`, 'success');
            }
            const landingPos = player.position;
            addLog(state, `📍 ${player.name} зупинив(ла)ся на: ${BOARD[landingPos].name}`);
            sideEffect = handleLanding(state, player);
            if (sideEffect) sideEffect.landingPos = landingPos;
            break;
        }
        case 'buyProperty': {
            const { pos } = state.pendingData || {};
            const cell = BOARD[pos];
            if (!cell || state.cellState[pos].owner !== null) break;
            if (player.money < cell.price) break;
            player.money -= cell.price; state.cellState[pos].owner = player.id; player.properties.push(pos);
            addLog(state, `🏆 ${player.name} придбав(ла) "${cell.name}" за ₴${cell.price}`, 'success');
            state._toast = { text: `🏠 ${player.name} купив ${cell.name} за ₴${cell.price}`, color: '#2e7d32' };
            state.pendingAction = null; state.pendingData = null;
            break;
        }
        case 'startAuction': {
            const { pos } = state.pendingData || {};
            const cell = BOARD[pos];
            const n = state.players.length;
            const eligible = [];
            for (let i = 1; i < n; i++) { const p = state.players[(state.currentPlayerIndex + i) % n]; if (!p.bankrupt) eligible.push(p.id); }
            if (eligible.length < 1) { addLog(state, 'Немає учасників для аукціону', 'warn'); break; }
            state.auctionState = { cell, currentBid: Math.floor(cell.price / 2), currentBidder: null, active: eligible, turnIdx: 0, declinerId: player.id };
            state.pendingAction = null; state.pendingData = null;
            addLog(state, `🔨 Аукціон на "${cell.name}" (старт ₴${state.auctionState.currentBid})`, 'warn');
            sideEffect = { event: 'auctionStarted' };
            break;
        }
        case 'auctionBid': {
            const a = state.auctionState; if (!a) break;
            const bidderId = a.active[a.turnIdx % a.active.length];
            const bidder = state.players[bidderId];
            const { bid } = data;
            if (bid < a.currentBid + 1 || bid > bidder.money) break;
            a.currentBid = bid; a.currentBidder = bidderId; a.turnIdx++;
            addLog(state, `💰 ${bidder.name} ставить ₴${bid}`);
            if (a.active.length === 1) awardAuction(state, a); else sideEffect = { event: 'auctionUpdated' };
            break;
        }
        case 'auctionPass': {
            const a = state.auctionState; if (!a) break;
            const bidderId = a.active[a.turnIdx % a.active.length];
            const bidder = state.players[bidderId];
            addLog(state, `⏭️ ${bidder.name} пасує`, 'warn');
            a.active = a.active.filter(id => id !== bidderId);
            if (a.active.length === 0) { addLog(state, 'Аукціон завершився без покупця', 'warn'); state.auctionState = null; }
            else if (a.active.length === 1) { if (a.currentBidder === null) a.currentBidder = a.active[0]; awardAuction(state, a); }
            else { if (a.turnIdx >= a.active.length) a.turnIdx %= a.active.length; sideEffect = { event: 'auctionUpdated' }; }
            break;
        }
        case 'payRent': {
            if (state.pendingAction !== 'payRent' || !state.pendingData) break;
            const { rent, ownerId } = state.pendingData;
            const owner = state.players[ownerId];
            if (!owner || typeof rent !== 'number') break;
            if (player.money < rent) break;
            player.money -= rent; owner.money += rent; player.stats.rentPaid += rent; owner.stats.rentReceived += rent;
            addLog(state, `💰 ${player.name} сплатив(ла) оренду ₴${rent} → ${owner.name}`, 'warn');
            state._toast = { text: `💸 ${player.name} сплатив(ла) ₴${rent} → ${owner.name}`, color: '#1565c0' };
            state.pendingAction = null; state.pendingData = null;
            break;
        }
        case 'declareBankrupt': {
            const creditorId = state.pendingData?.ownerId ?? null;
            const creditor = creditorId !== null ? state.players[creditorId] : null;
            addLog(state, `💀 ${player.name} оголосив(ла) банкрутство!`, 'error');
            if (creditor) {
                creditor.money += player.money;
                player.properties.forEach(pos => { state.cellState[pos].owner = creditor.id; state.cellState[pos].houses = 0; creditor.properties.push(pos); });
            } else {
                player.properties.forEach(pos => { state.cellState[pos].owner = null; state.cellState[pos].houses = 0; state.cellState[pos].mortgaged = false; });
            }
            player.money = 0; player.bankrupt = true; player.properties = [];
            state.pendingAction = null; state.pendingData = null;
            sideEffect = nextPlayer(state);
            break;
        }
        case 'buildHouse': {
            const { pos } = data; const cell = BOARD[pos]; const s = state.cellState[pos];
            if (!s || s.owner !== player.id) break;
            if (s.houses >= 5 || player.money < cell.housePrice) break;
            const group = BOARD.filter(b => b.type === 'property' && b.color === cell.color);
            const allOwned = group.every(b => state.cellState[b.pos].owner === player.id && !state.cellState[b.pos].mortgaged);
            const minH = Math.min(...group.map(b => state.cellState[b.pos].houses));
            if (!allOwned || s.houses !== minH) break;
            player.money -= cell.housePrice; s.houses++;
            if (s.houses === 5) player.stats.hotelsBuilt++; else player.stats.housesBuilt++;
            addLog(state, `🏠 ${player.name} збудував(ла) ${s.houses === 5 ? 'готель' : 'будинок'} на "${cell.name}"`, 'success');
            break;
        }
        case 'sellHouse': {
            const { pos } = data; const cell = BOARD[pos]; const s = state.cellState[pos];
            if (!s || s.owner !== player.id || s.houses === 0) break;
            const group = BOARD.filter(b => b.type === 'property' && b.color === cell.color);
            const maxH = Math.max(...group.map(b => state.cellState[b.pos].houses));
            if (s.houses !== maxH) break;
            s.houses--; player.money += Math.floor(cell.housePrice * 0.9);
            addLog(state, `🔻 ${player.name} продав(ла) будинок на "${cell.name}"`, 'success');
            checkDebtCleared(state, player);
            break;
        }
        case 'mortgage': {
            const { pos } = data; const cell = BOARD[pos]; const s = state.cellState[pos];
            if (!s || s.owner !== player.id || s.mortgaged || s.houses > 0) break;
            s.mortgaged = true; player.money += Math.floor(cell.price / 2);
            addLog(state, `🏷️ ${player.name} заставив(ла) "${cell.name}"`, 'warn');
            checkDebtCleared(state, player);
            break;
        }
        case 'redeem': {
            const { pos } = data; const cell = BOARD[pos]; const s = state.cellState[pos];
            if (!s || s.owner !== player.id) break;
            const cost = Math.ceil(Math.floor(cell.price / 2) * 1.1);
            if (!s.mortgaged || player.money < cost) break;
            s.mortgaged = false; player.money -= cost;
            addLog(state, `💸 ${player.name} викупив(ла) "${cell.name}" за ₴${cost}`, 'success');
            break;
        }
        case 'takeLoan': {
            const { amount } = data;
            if (player.loan > 0) break;
            const maxLoan = player.properties.reduce((acc, pos) => acc + (!state.cellState[pos].mortgaged ? Math.floor(BOARD[pos].price / 2) : 0), 0);
            if (maxLoan < 50 || amount < 50 || amount > maxLoan) break;
            player.money += amount; player.loan += amount; player.loanInterest += Math.ceil(amount * 0.1);
            if (!player.loanTurnsLeft || player.loanTurnsLeft <= 0) player.loanTurnsLeft = 10;
            addLog(state, `🏦 ${player.name} взяв ₴${amount} кредиту (повернути за 10 ходів)`, 'success');
            break;
        }
        case 'repayLoan': {
            const total = player.loan + player.loanInterest;
            if (player.money < total) break;
            player.money -= total; player.loan = 0; player.loanInterest = 0; player.loanTurnsLeft = 0;
            addLog(state, `✅ ${player.name} повернув(ла) кредит ₴${total}`, 'success');
            break;
        }
        case 'jailPay': {
            if (player.money < 50) break;
            player.money -= 50; player.inJail = false;
            addLog(state, `💸 ${player.name} сплатив(ла) ₴50 і вийшов(ла) з В'язниці`, 'success');
            break;
        }
        case 'jailCard': {
            if (!player.hasJailCard || !player.inJail) break;
            player.hasJailCard = false; player.inJail = false; player.jailTurns = 0;
            addLog(state, `🔓 ${player.name} використав картку виходу з В'язниці`, 'success');
            break;
        }
        case 'casinoBet': {
            if (state.pendingAction !== 'casino') break;
            const bet = parseInt(data.amount) || 0;
            if (bet < 50 || bet > player.money) break;
            const d1 = Math.floor(Math.random() * 6) + 1, d2 = Math.floor(Math.random() * 6) + 1, sum = d1 + d2, isDouble = d1 === d2;
            let result, delta;
            if (isDouble) { delta = bet * 3; result = `🎉 ДУБЛЬ ${d1}+${d2}! Виграш ×3 → +₴${delta}`; player.money += delta; }
            else if (sum >= 8) { delta = bet * 2; result = `✅ ${d1}+${d2}=${sum} — виграш ×2 → +₴${delta}`; player.money += delta; }
            else { delta = -bet; result = `❌ ${d1}+${d2}=${sum} — програш → -₴${bet}`; player.money -= bet; }
            addLog(state, `🎰 ${player.name}: ставка ₴${bet}. ${result}`, isDouble ? 'success' : sum >= 8 ? 'success' : 'warn');
            state._toast = { text: `🎰 ${result}`, color: isDouble ? '#2e7d32' : sum >= 8 ? '#1565c0' : '#c62828' };
            state.pendingAction = null; state.pendingData = null;
            sideEffect = { event: 'casinoResult', d1, d2, sum, isDouble, bet, delta, result };
            break;
        }
        case 'casinoSkip': {
            if (state.pendingAction !== 'casino') break;
            addLog(state, `🎰 ${player.name} пройшов(ла) мимо казино`);
            state.pendingAction = null; state.pendingData = null;
            break;
        }
        case 'endTurn': {
            if (!state.hasRolled || state.pendingAction) break;
            sideEffect = nextPlayer(state);
            break;
        }
        case 'offerTrade': {
            const { toIdx, offerMoney = 0, offerProps = [], requestMoney = 0, requestProps = [] } = data;
            if (toIdx < 0 || toIdx >= state.players.length) break;
            const to = state.players[toIdx];
            if (!to || to.bankrupt || toIdx === state.currentPlayerIndex) break;
            if (offerMoney > player.money || requestMoney > to.money) break;
            if (offerProps.some(pos => !player.properties.includes(pos))) break;
            if (requestProps.some(pos => !to.properties.includes(pos))) break;
            state.pendingTrade = { fromIdx: state.currentPlayerIndex, toIdx, offerMoney, offerProps, requestMoney, requestProps };
            addLog(state, `🤝 ${player.name} пропонує угоду до ${to.name}`);
            sideEffect = { event: 'tradeOffer', trade: state.pendingTrade };
            break;
        }
        case 'acceptTrade': {
            const trade = state.pendingTrade;
            if (!trade || data.callerIdx !== trade.toIdx) break;
            const from = state.players[trade.fromIdx], to = state.players[trade.toIdx];
            if (from.money < trade.offerMoney || to.money < trade.requestMoney) {
                addLog(state, `❌ Угоду скасовано — умови більше не діють (недостатньо коштів)`, 'error');
                state.pendingTrade = null; break;
            }
            from.money -= trade.offerMoney; to.money += trade.offerMoney;
            from.money += trade.requestMoney; to.money -= trade.requestMoney;
            for (const pos of trade.offerProps) { from.properties = from.properties.filter(p => p !== pos); to.properties.push(pos); state.cellState[pos].owner = trade.toIdx; }
            for (const pos of trade.requestProps) { to.properties = to.properties.filter(p => p !== pos); from.properties.push(pos); state.cellState[pos].owner = trade.fromIdx; }
            addLog(state, `✅ ${from.name} і ${to.name} уклали угоду!`, 'success');
            state._toast = { text: `🤝 ${from.name} і ${to.name} обмінялись!`, color: '#1565c0' };
            state.pendingTrade = null;
            break;
        }
        case 'rejectTrade': {
            const trade = state.pendingTrade;
            if (!trade || data.callerIdx !== trade.toIdx) break;
            const from = state.players[trade.fromIdx], to = state.players[trade.toIdx];
            addLog(state, `❌ ${to.name} відхилив угоду від ${from.name}`, 'warn');
            state._toast = { text: `❌ ${to.name} відхилив угоду від ${from.name}`, color: '#c62828' };
            state.pendingTrade = null;
            break;
        }
    }
    return sideEffect;
}

// ── Таймери ────────────────────────────────────
function clearTurnTimer(room) {
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    if (room.state) room.state.turnDeadline = null;
}

function clearTradeTimer(room) {
    if (room.tradeTimer) { clearTimeout(room.tradeTimer); room.tradeTimer = null; }
    if (room.state) room.state.tradeDeadline = null;
}

function startTradeTimer(room) {
    clearTradeTimer(room); clearTurnTimer(room);
    room.state.tradeDeadline = Date.now() + 20000;
    room.tradeTimer = setTimeout(() => {
        if (!room.started || !room.state?.pendingTrade) return;
        const trade = room.state.pendingTrade;
        const to = room.state.players[trade.toIdx];
        addLog(room.state, `⏱️ ${to.name} не відповів на угоду — скасовано`, 'warn');
        room.state.pendingTrade = null; room.state.tradeDeadline = null;
        startTurnTimer(room);
        _io.to(room.code).emit('stateUpdate', {
            state: sanitize(room.state), sideEffect: null,
            toast: { text: `⏱️ Час на відповідь вийшов — угоду скасовано`, color: '#e65100' },
        });
    }, 20000);
}

function startTurnTimer(room) {
    if (room.state?.pendingTrade) return;
    const next = room.state?.players[room.state?.currentPlayerIndex];
    if (next?.bankrupt) return;
    clearTurnTimer(room);
    const TURN_MS = 90 * 1000;
    room.state.turnDeadline = Date.now() + TURN_MS;
    room.turnTimer = setTimeout(() => {
        if (!room.started || !room.state) return;
        const state = room.state;
        try {
            if (state.auctionState) {
                processAction(state, 'auctionPass', {}, room);
            } else if (state.pendingAction === 'coverDebt') {
                processAction(state, 'declareBankrupt', {}, room);
            } else if (state.pendingAction === 'casino') {
                processAction(state, 'casinoSkip', {}, room);
                processAction(state, 'endTurn', {}, room);
            } else if (!state.hasRolled) {
                processAction(state, 'rollDice', {}, room);
                if (state.pendingAction === 'payRent') {
                    const canPay = state.players[state.currentPlayerIndex].money >= (state.pendingData?.rent || 0);
                    processAction(state, canPay ? 'payRent' : 'declareBankrupt', {}, room);
                } else if (state.pendingAction === 'offerPurchase') {
                    processAction(state, 'startAuction', {}, room);
                } else if (state.pendingAction === 'casino') {
                    processAction(state, 'casinoSkip', {}, room);
                }
                if (state.hasRolled && !state.auctionState && !state.pendingAction) processAction(state, 'endTurn', {}, room);
            } else if (!state.auctionState && !state.pendingAction) {
                processAction(state, 'endTurn', {}, room);
            }
        } catch(e) { console.error('Auto-turn error:', e.message); }
        const alive = state.players.filter(p => !p.bankrupt);
        if (alive.length === 1) {
            clearTurnTimer(room);
            addLog(state, `🏆 ${alive[0].name} — переможець!`, 'success');
            _io.to(room.code).emit('gameOver', { winner: alive[0], state: sanitize(state) });
            return;
        }
        _io.to(room.code).emit('stateUpdate', {
            state: sanitize(room.state), sideEffect: null,
            toast: { text: '⏱️ Час вийшов! Хід передано автоматично.', color: '#e65100' },
        });
        startTurnTimer(room);
    }, TURN_MS);
}

module.exports = {
    init, createGameState, processAction, sanitize, addLog,
    clearTurnTimer, clearTradeTimer, startTurnTimer, startTradeTimer,
};
