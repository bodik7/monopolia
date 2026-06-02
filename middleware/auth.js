// ============================================
// Auth middleware: requireAuth, requireAdmin
// Rate limiting helpers
// ============================================
const jwt = require('jsonwebtoken');
const db  = require('../db');
const { JWT_SECRET } = require('../config');

// ── In-memory rate limiter ─────────────────
const _rl = new Map();
const RL_MAX_ENTRIES = 50_000;

function rateLimit(key, max, windowMs) {
    const now   = Date.now();
    const entry = _rl.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
    entry.count++;
    _rl.set(key, entry);
    return entry.count <= max;
}

// Очищення: прострочені записи кожні 5 хв + hard cap при переповненні
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _rl) if (now > v.resetAt) _rl.delete(k);
    if (_rl.size > RL_MAX_ENTRIES) {
        const toDelete = _rl.size - RL_MAX_ENTRIES;
        let i = 0;
        for (const k of _rl.keys()) { if (i++ >= toDelete) break; _rl.delete(k); }
    }
}, 5 * 60_000);

function apiLimiter(max, windowMs) {
    return (req, res, next) => {
        const forwarded = req.headers['x-forwarded-for'];
        const ip = (forwarded ? forwarded.split(',').at(-1).trim() : null) || req.socket.remoteAddress || 'unknown';
        if (!rateLimit(`api:${ip}`, max, windowMs))
            return res.status(429).json({ error: 'Занадто багато запитів. Спробуйте пізніше.' });
        next();
    };
}

function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer '))
        return res.status(401).json({ error: 'Не авторизовано' });
    try {
        req.authUser = jwt.verify(auth.slice(7), JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Токен недійсний або прострочений' });
    }
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, async () => {
        const user = await db.getUser(req.authUser.username);
        if (Number(user?.is_admin) !== 1) return res.status(403).json({ error: 'Немає доступу' });
        req.dbUser = user;
        next();
    });
}

module.exports = { rateLimit, apiLimiter, requireAuth, requireAdmin };
