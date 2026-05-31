const { shuffle, addLog } = require('./utils.js');

let _io;
function init(io) { _io = io; }

const D_RANKS    = ['6','7','8','9','10','J','Q','K','A'];
const D_SUITS    = ['♠','♣','♦','♥'];
const D_RANK_IDX = Object.fromEntries(D_RANKS.map((r,i)=>[r,i]));

function dRank(c) { return c.slice(0,-1); }
function dSuit(c) { return c.slice(-1); }
function dCanBeat(atk, def, trump) {
    const as=dSuit(atk), ds=dSuit(def);
    if(ds===trump && as!==trump) return true;
    if(ds===as) return D_RANK_IDX[dRank(def)] > D_RANK_IDX[dRank(atk)];
    return false;
}
function dNextActive(state, from) {
    const n=state.players.length;
    for(let i=1;i<=n;i++){
        const idx=(from+i)%n;
        if(!state.finished.includes(idx)) return idx;
    }
    return from;
}

function dFindFirstAttacker(players, trump) {
    let best = -1, bestRank = 999, hasTrump = false;
    players.forEach((p, i) => {
        const trumps = p.hand.filter(c => dSuit(c) === trump);
        if(trumps.length){
            const min = Math.min(...trumps.map(c => D_RANK_IDX[dRank(c)]));
            if(!hasTrump || min < bestRank){ hasTrump = true; bestRank = min; best = i; }
        }
    });
    if(hasTrump) return best;
    bestRank = 999;
    players.forEach((p, i) => {
        const min = Math.min(...p.hand.map(c => D_RANK_IDX[dRank(c)]));
        if(min < bestRank){ bestRank = min; best = i; }
    });
    return best >= 0 ? best : 0;
}

const DURAK_TURN_MS = 45_000;

function dStartTurnTimer(room) {
    if (room.durakTimer) clearTimeout(room.durakTimer);
    const state = room.state;
    if (!state || state.phase === 'gameover') return;
    state.turnDeadline = Date.now() + DURAK_TURN_MS;
    room.durakTimer = setTimeout(() => {
        if (!room.state || room.state.phase === 'gameover') return;
        const s = room.state;
        let result = null;
        if (s.phase === 'attack') {
            const atk = s.players[s.attacker];
            if (s.table.length === 0 && atk?.hand?.length > 0) {
                result = processDurakAction(s, 'dPlay', { cards: [atk.hand[0]] }, s.attacker);
            } else if (s.table.every(t => t.defense)) {
                result = processDurakAction(s, 'dPass', {}, s.attacker);
            }
        } else if (s.phase === 'defend') {
            result = processDurakAction(s, 'dTake', {}, s.defender);
        } else if (s.phase === 'throw') {
            s.players.forEach((p, i) => {
                if (i !== s.defender && !s.passedThrow.includes(i))
                    processDurakAction(s, 'dPass', {}, i);
            });
        }
        if (result?.event === 'dGameOver') {
            room.players.forEach(rp => _io.to(rp.socketId).emit('gameOver', { state: sanitizeDurak(s, rp.index) }));
        } else {
            emitDurakUpdate(room, null);
        }
    }, DURAK_TURN_MS);
}

function createDurakState(roomPlayers, settings={}) {
    const allCards = shuffle(D_SUITS.flatMap(s=>D_RANKS.map(r=>r+s)));
    // Беремо козирь ДО роздачі — інакше при 6 гравцях (6×6=36) колода порожніє
    // і trumpCard стає undefined, що крашить dSuit()
    const trumpCard = allCards.pop();           // виймаємо останню карту
    const trump = dSuit(trumpCard);
    allCards.unshift(trumpCard);                // кладемо козирь «відкрито» знизу колоди
    const deck = allCards;
    const players = roomPlayers.map((rp,i)=>({ id:i, name:rp.name, hand:deck.splice(1,6), avatarId: rp.avatarId||null, avatarColor: rp.avatarColor||'#1a56db' }));
    const attacker = dFindFirstAttacker(players, trump);
    return {
        gameType:'durak', mode: settings.mode||'podkidnoy',
        players, deck,
        trump, trumpCard,
        attacker, defender:(attacker+1)%roomPlayers.length,
        phase:'attack',
        table:[], passedThrow:[], finished:[],
        log:[], loser:null, turnDeadline: null,
        isSecretVoting: false, kumData: null, quarantined: [],
    };
}

function processDurakAction(state, type, data, pidx) {
    const player = state.players[pidx];
    if(!player || state.phase==='gameover') return null;

    switch(type){
        case 'dPlay': {
            const ph = state.phase;
            if(ph==='attack' && pidx!==state.attacker) break;
            if(ph==='throw' && (pidx===state.defender || state.passedThrow.includes(pidx))) break;
            if(ph!=='attack' && ph!=='throw') break;
            const { cards } = data||{};
            if(!cards?.length) break;
            const tableRanks = new Set(state.table.flatMap(t=>[dRank(t.attack), t.defense?dRank(t.defense):null].filter(Boolean)));
            if(ph==='attack' && state.table.length===0){
                const r=dRank(cards[0]);
                if(!cards.every(c=>dRank(c)===r)) break;
            } else {
                if(!cards.every(c=>tableRanks.has(dRank(c)))) break;
            }
            const defender = state.players[state.defender];
            if (!defender) break;
            const defHand = defender.hand.length;
            const unbeaten = state.table.filter(t=>!t.defense).length;
            if(unbeaten+cards.length > defHand) break;
            if(state.table.length+cards.length > 6) break;
            const tmp=[...player.hand];
            for(const c of cards){ const i=tmp.indexOf(c); if(i===-1) return null; tmp.splice(i,1); }
            for(const c of cards){ player.hand.splice(player.hand.indexOf(c),1); state.table.push({attack:c,defense:null}); }
            state.phase='defend'; state.passedThrow=[];
            addLog(state, ph==='attack'?`⚔️ ${player.name} ходить`:`➕ ${player.name} підкидає`);
            break;
        }
        case 'dBeat': {
            if(state.phase!=='defend'||pidx!==state.defender) break;
            const { attackCard, defenseCard } = data||{};
            const slot=state.table.find(t=>t.attack===attackCard&&!t.defense);
            if(!slot) break;
            const di=player.hand.indexOf(defenseCard);
            if(di===-1) break;
            if(!dCanBeat(attackCard, defenseCard, state.trump)) break;
            player.hand.splice(di,1); slot.defense=defenseCard;
            addLog(state,`🛡️ ${player.name} відбиває`);
            if(state.table.every(t=>t.defense)){
                state.phase='throw'; state.passedThrow=[state.defender];
            }
            break;
        }
        case 'dTake': {
            if(state.phase!=='defend'||pidx!==state.defender) break;
            player.hand.push(...state.table.flatMap(t=>[t.attack,t.defense].filter(Boolean)));
            state.table=[];
            addLog(state,`😵 ${player.name} забирає карти`);
            return dAdvance(state, true);
        }
        case 'dTransfer': {
            if(state.mode!=='perevodnoj'||state.phase!=='defend'||pidx!==state.defender) break;
            if(state.table.some(t=>t.defense)) break;
            const { card } = data||{};
            if(!state.table.map(t=>dRank(t.attack)).includes(dRank(card))) break;
            const nextDef=dNextActive(state,state.defender);
            if(nextDef===state.attacker) break;
            if(state.players[nextDef].hand.length < state.table.length+1) break;
            const i=player.hand.indexOf(card); if(i===-1) break;
            player.hand.splice(i,1); state.table.push({attack:card,defense:null});
            state.attacker=state.defender; state.defender=nextDef;
            addLog(state,`🔄 ${player.name} переводить → ${state.players[nextDef].name}`);
            break;
        }
        case 'dPass': {
            const isEndTurn = state.phase==='attack' && pidx===state.attacker
                && state.table.length>0 && state.table.every(t=>t.defense);
            if(isEndTurn) return dAdvance(state, false);
            if(state.phase!=='throw'||pidx===state.defender) break;
            if(!state.passedThrow.includes(pidx)) state.passedThrow.push(pidx);
            state.players.forEach(p => {
                if(p.id!==state.defender && p.hand.length===0 && !state.passedThrow.includes(p.id))
                    state.passedThrow.push(p.id);
            });
            const nonDef=state.players.filter(p=>!state.finished.includes(p.id)&&p.id!==state.defender);
            if(nonDef.every(p=>state.passedThrow.includes(p.id)))
                return dAdvance(state, false);
            break;
        }
    }
    return null;
}

function dAdvance(state, defenderTook) {
    if(!defenderTook){ state.table=[]; }
    const n=state.players.length;
    const order=[];
    for(let i=0;i<n;i++){
        const idx=(state.attacker+i)%n;
        if(idx!==state.defender) order.push(idx);
    }
    order.push(state.defender);
    for(const idx of order){
        const p=state.players[idx];
        while(p.hand.length<6 && state.deck.length>0) p.hand.push(state.deck.pop());
        if(state.deck.length===0) state.trumpCard = null;
        if(p.hand.length===0 && !state.finished.includes(idx)){
            state.finished.push(idx);
            addLog(state,`🏅 ${p.name} вийшов(ла) з гри`);
        }
    }
    const active=state.players.filter(p=>!state.finished.includes(p.id));
    if(active.length<=1){
        state.phase='gameover';
        state.loser=active.length===1?active[0].id:null;
        addLog(state, state.loser!==null?`🤡 ${state.players[state.loser].name} — ДУРЕНЬ!`:`🏁 Нічия!`);
        return { event:'dGameOver' };
    }
    const prevDefender = state.defender;
    if(defenderTook){
        state.attacker = dNextActive(state, prevDefender);
    } else {
        state.attacker = state.finished.includes(prevDefender)
            ? dNextActive(state, prevDefender)
            : prevDefender;
    }
    state.defender = dNextActive(state, state.attacker);
    state.phase='attack'; state.passedThrow=[]; state.table=[];
    addLog(state,`🃏 Хід ${state.players[state.attacker].name}`);
    return null;
}

function sanitizeDurak(state, forIdx) {
    return {
        gameType:'durak', mode:state.mode, myId:forIdx,
        players: state.players.map((p,i)=>({
            id:p.id, name:p.name, handCount:p.hand.length,
            hand: i===forIdx ? p.hand : null,
            finished: state.finished.includes(p.id),
            avatarId: p.avatarId||null, avatarColor: p.avatarColor||'#1a56db',
        })),
        deckCount: state.deck.length,
        trump: state.trump, trumpCard: state.trumpCard,
        attacker: state.attacker, defender: state.defender,
        phase: state.phase,
        table: state.table,
        passedThrow: state.passedThrow,
        finished: state.finished,
        log: state.log.slice(0,25),
        loser: state.loser,
        turnDeadline: state.turnDeadline || null,
    };
}

function emitDurakUpdate(room, sideEffect) {
    dStartTurnTimer(room);
    room.players.forEach(rp=>{
        _io.to(rp.socketId).emit('stateUpdate',{
            state: sanitizeDurak(room.state, rp.index),
            sideEffect: sideEffect||null,
        });
    });
}

module.exports = {
    init,
    createDurakState,
    processDurakAction,
    sanitizeDurak,
    emitDurakUpdate,
    dStartTurnTimer,
};
