/**
 * webhook.js — Express server that handles the Facebook Messenger Webhook.
 *
 * Two purposes:
 *   1. GET /webhook  — Verification handshake with Meta during app setup
 *   2. POST /webhook — Receives messaging events from Facebook
 *
 * When a guardian messages your Page with a registration keyword (e.g. the
 * student's ID number), this webhook captures their PSID and stores it so
 * the MCP tools can send them notifications later.
 *
 * IMPORTANT: This server must be publicly accessible (use ngrok for local dev).
 *   npx ngrok http 3000   →  copy the HTTPS URL → paste into Facebook App Webhook settings
 */

import express from 'express';
import { psidStore } from './psid-store.js';
import { sendAttendanceNotification } from './messenger.js';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_eUrzjP0I7gOD@ep-morning-bonus-akb47ako-pooler.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false }
});

export function createWebhookServer() {
    const app         = express();
    const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'attendease_verify_token';

    // ── CORS — allow the local teacher dashboard to call this API ──────────────
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    app.use(express.json());

    // ── GET /webhook — Meta verification handshake ─────────────────────────────
    app.get('/webhook', (req, res) => {
        const mode      = req.query['hub.mode'];
        const token     = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('[Webhook] ✅ Verified by Meta');
            res.status(200).send(challenge);
        } else {
            console.warn('[Webhook] ❌ Verification failed — token mismatch');
            res.sendStatus(403);
        }
    });

    // ── POST /webhook — Incoming messaging events ──────────────────────────────
    app.post('/webhook', (req, res) => {
        const body = req.body;
        if (body.object !== 'page') { res.sendStatus(404); return; }

        for (const entry of body.entry ?? []) {
            for (const event of entry.messaging ?? []) {
                handleMessagingEvent(event);
            }
        }

        res.sendStatus(200);   // always ACK quickly
    });

    // ── Health check ───────────────────────────────────────────────────────────
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', server: 'AttendEase Messenger MCP', ts: new Date().toISOString() });
    });

    // ── POST /api/notify — Send a Messenger notification from the teacher dashboard ──
    app.post('/api/notify', async (req, res) => {
        const { studentId, studentName, status, className, date, remark } = req.body;
        if (!studentId || !studentName || !status || !className || !date) {
            return res.status(400).json({ ok: false, message: 'Missing required fields.' });
        }
        const stored = psidStore.get(studentId);
        if (!stored?.psid) {
            return res.json({
                ok: false,
                message: `No Messenger registered for ${studentName}. Guardian must message the Facebook Page with: REGISTER ${studentId}`,
            });
        }
        try {
            await sendAttendanceNotification(stored.psid, { studentName, status, className, date, remark: remark || '' });
            res.json({ ok: true, message: `Notification sent to guardian of ${studentName}` });
        } catch (err) {
            res.json({ ok: false, message: `Send failed: ${err.message}` });
        }
    });

    // ── GET /api/guardian-status/:studentId — Check if a guardian is registered ──
    app.get('/api/guardian-status/:studentId', (req, res) => {
        const stored = psidStore.get(req.params.studentId);
        res.json({ registered: !!stored?.psid });
    });

    // ── CLOUD DATABASE SYNC ENDPOINTS ──────────────────────────────────────────
    // Auto-create the table on first use
    pool.query(`
        CREATE TABLE IF NOT EXISTS global_state (
            id   INTEGER PRIMARY KEY DEFAULT 1,
            data JSONB   NOT NULL DEFAULT '{}'
        )
    `).catch(err => console.error('[DB] Table init failed:', err.message));

    // GET /api/db/sync — teacher dashboard polls this to get student scans
    app.get('/api/db/sync', async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT data FROM global_state WHERE id = 1');
            if (!rows.length) {
                return res.json({ ok: true, state: {} });
            }
            res.json({ ok: true, state: rows[0].data });
        } catch (err) {
            console.error('[DB] GET /api/db/sync error:', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /api/db/sync — student phone pushes attendance data here after QR scan
    app.post('/api/db/sync', async (req, res) => {
        try {
            const incoming = req.body;
            if (!incoming || typeof incoming !== 'object') {
                return res.status(400).json({ ok: false, error: 'Invalid payload' });
            }

            // Read current state, deep-merge at the session level, write back
            const { rows } = await pool.query('SELECT data FROM global_state WHERE id = 1');
            const current = (rows[0]?.data) || {};

            // For each key in the incoming state, merge intelligently
            const merged = { ...current };
            for (const [k, v] of Object.entries(incoming)) {
                if (k === '__sync_version') { merged[k] = v; continue; }

                if (k.startsWith('attendease_teacher_') && current[k]) {
                    // Deep-merge sessions so no scan is ever lost
                    try {
                        const cur = typeof current[k] === 'string' ? JSON.parse(current[k]) : current[k];
                        const inc = typeof v === 'string' ? JSON.parse(v) : v;
                        const mergedSessions = { ...(cur.sessions || {}), ...(inc.sessions || {}) };

                        // Per-session: merge individual student records
                        for (const sKey of Object.keys(inc.sessions || {})) {
                            const curRecs = (cur.sessions || {})[sKey] || [];
                            const incRecs = inc.sessions[sKey] || [];
                            const curMap = {};
                            curRecs.forEach(r => { curMap[r.studentId] = r; });
                            const final = [];
                            const seen = new Set();
                            incRecs.forEach(r => {
                                seen.add(r.studentId);
                                const old = curMap[r.studentId];
                                final.push({
                                    ...r,
                                    timeIn:  r.timeIn  || (old && old.timeIn)  || null,
                                    timeOut: r.timeOut || (old && old.timeOut) || null,
                                });
                            });
                            // Keep curRecs not in incRecs
                            curRecs.forEach(r => { if (!seen.has(r.studentId)) final.push(r); });
                            mergedSessions[sKey] = final;
                        }

                        merged[k] = JSON.stringify({ ...cur, ...inc, sessions: mergedSessions });
                    } catch {
                        merged[k] = typeof v === 'string' ? v : JSON.stringify(v);
                    }
                } else {
                    merged[k] = typeof v === 'string' ? v : JSON.stringify(v);
                }
            }

            await pool.query(
                `INSERT INTO global_state (id, data)
                 VALUES (1, $1::jsonb)
                 ON CONFLICT (id) DO UPDATE SET data = $1::jsonb`,
                [JSON.stringify(merged)]
            );

            res.json({ ok: true });
        } catch (err) {
            console.error('[DB] POST /api/db/sync error:', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    return app;
}

/**
 * Handle a single messaging event from a guardian.
 *
 * Registration flow:
 *   Guardian messages your Page with the text: REGISTER <studentId>
 *   e.g.  "REGISTER 2024-00001"
 *
 * The webhook stores their PSID linked to that student ID.
 * The teacher can then use the MCP notify_guardian tool to send notifications.
 */
function handleMessagingEvent(event) {
    // Only handle standard text messages
    if (!event.message || event.message.is_echo) return;

    const psid = event.sender?.id;
    const text  = event.message?.text?.trim() ?? '';

    console.log(`[Webhook] Message from PSID ${psid}: "${text}"`);

    // Registration command: REGISTER <studentId>
    const match = text.match(/^register\s+(.+)$/i);
    if (match) {
        const studentId = match[1].trim();
        psidStore.set(studentId, '', psid);
        console.log(`[Webhook] ✅ Registered guardian PSID ${psid} → student ${studentId}`);

        // Send confirmation reply to guardian
        import('./messenger.js').then(({ sendMessage }) => {
            sendMessage(psid, {
                text: `✅ You are now registered for attendance alerts for student ${studentId}.\n\nYou will receive a Messenger notification whenever your child is marked absent or late. 📚`
            }).catch(err => console.error('[Webhook] Reply failed:', err.message));
        });
        return;
    }

    // INFO command: show usage
    if (/^(info|help|start)$/i.test(text)) {
        console.log(`[Webhook] Help request from PSID ${psid}`);
        // Optionally auto-reply with instructions
        return;
    }

    console.log(`[Webhook] Unrecognised message from ${psid}: "${text}"`);
}
