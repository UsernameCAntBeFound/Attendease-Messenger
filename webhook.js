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
import { sendAttendanceNotification, sendMessage } from './messenger.js';
import pg from 'pg';

import axios from 'axios';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ghcdhisbqjixzzvlmjxt.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoY2RoaXNicWppeHp6dmxtanh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzkzMjAsImV4cCI6MjA5MTg1NTMyMH0.Xc4gWBRhcgY46HfLPnlqcu-ZUnQ5mPTsMtCyXKF2zSw';

const supabaseRest = axios.create({
    baseURL: `${SUPABASE_URL}/rest/v1`,
    headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
    }
});

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

    // API for teacher dashboard to send Messenger notification
    app.post('/api/notify', async (req, res) => {
        const { studentId, studentName, status, className, date, remark } = req.body;
        if (!studentId || !studentName || !status || !className || !date) {
            return res.status(400).json({ ok: false, message: 'Missing required fields.' });
        }
        
        try {
            // Query Supabase REST instead of Neon
            const { data } = await supabaseRest.get(`/guardian_psids?student_id=eq.${studentId}`);
            if (!data || data.length === 0) {
                return res.json({
                    ok: false,
                    message: `No Messenger registered for ${studentName}. Guardian must message the Facebook Page with: REGISTER ${studentId}`,
                });
            }
            
            await sendAttendanceNotification(data[0].psid, { studentName, status, className, date, remark: remark || '' });
            res.json({ ok: true, message: `Notification sent to guardian of ${studentName}` });
        } catch (err) {
            console.error('[Notify] Error:', err.message);
            res.json({ ok: false, message: `Send failed: ${err.message}` });
        }
    });

    // ── GET /api/guardian-status/:studentId — Check if a guardian is registered ──
    app.get('/api/guardian-status/:studentId', async (req, res) => {
        try {
            const { data } = await supabaseRest.get(`/guardian_psids?student_id=eq.${req.params.studentId}`);
            res.json({ registered: !!(data && data.length > 0) });
        } catch (err) {
            res.json({ registered: false });
        }
    });

    // ── CLOUD DATABASE SYNC ENDPOINTS ──────────────────────────────────────────
    // Auto-create tables on first use
    pool.query(`
        CREATE TABLE IF NOT EXISTS global_state (
            id   INTEGER PRIMARY KEY DEFAULT 1,
            data JSONB   NOT NULL DEFAULT '{}'
        )
    `).catch(err => console.error('[DB] Table init failed:', err.message));

    // Dedicated attendance table — completely separate from the global_state sync
    pool.query(`
        CREATE TABLE IF NOT EXISTS attendance_sessions (
            teacher_id  TEXT        NOT NULL,
            session_key TEXT        NOT NULL,
            records     JSONB       NOT NULL DEFAULT '[]',
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (teacher_id, session_key)
        )
    `).catch(err => console.error('[DB] Attendance table init failed:', err.message));

    // ── POST /api/scan ─────────────────────────────────────────────────────────
    // Called by student dashboard immediately after a successful QR scan.
    // Body: { teacherId, sessionKey, record }
    // record: { studentId, name, status, timeIn, timeOut, remark, location }
    app.post('/api/scan', async (req, res) => {
        const { teacherId, sessionKey, record } = req.body || {};
        if (!teacherId || !sessionKey || !record || !record.studentId) {
            return res.status(400).json({ ok: false, error: 'Missing teacherId, sessionKey, or record' });
        }
        try {
            // Read existing records for this session
            const { rows } = await pool.query(
                'SELECT records FROM attendance_sessions WHERE teacher_id = $1 AND session_key = $2',
                [teacherId, sessionKey]
            );

            let records = rows.length ? rows[0].records : [];

            // Find existing record for this student and update, or add new
            const idx = records.findIndex(r => r.studentId === record.studentId);
            if (idx >= 0) {
                // Preserve existing timeIn when updating timeOut
                records[idx] = {
                    ...records[idx],
                    ...record,
                    timeIn:  record.timeIn  || records[idx].timeIn  || null,
                    timeOut: record.timeOut || records[idx].timeOut || null,
                };
            } else {
                records.push(record);
            }

            await pool.query(
                `INSERT INTO attendance_sessions (teacher_id, session_key, records, updated_at)
                 VALUES ($1, $2, $3::jsonb, NOW())
                 ON CONFLICT (teacher_id, session_key)
                 DO UPDATE SET records = $3::jsonb, updated_at = NOW()`,
                [teacherId, sessionKey, JSON.stringify(records)]
            );

            console.log(`[Scan] ${record.name} → ${sessionKey} (${record.status})`);
            res.json({ ok: true });
        } catch (err) {
            console.error('[Scan] Error:', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ── GET /api/sessions/:teacherId ───────────────────────────────────────────
    // Polled by teacher dashboard every 3s to get all live attendance data.
    // Returns: { ok: true, sessions: { "ENG_2026-04-15": [...records], ... } }
    app.get('/api/sessions/:teacherId', async (req, res) => {
        try {
            const { rows } = await pool.query(
                'SELECT session_key, records FROM attendance_sessions WHERE teacher_id = $1',
                [req.params.teacherId]
            );
            const sessions = {};
            rows.forEach(r => { sessions[r.session_key] = r.records; });
            res.json({ ok: true, sessions });
        } catch (err) {
            console.error('[Sessions] Error:', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // Dedicated excuse letters table
    pool.query(`
        CREATE TABLE IF NOT EXISTS excuse_letters (
            id              SERIAL      PRIMARY KEY,
            teacher_id      TEXT        NOT NULL,
            student_id      TEXT        NOT NULL,
            student_name    TEXT        NOT NULL,
            class_code      TEXT        NOT NULL,
            date            TEXT        NOT NULL,
            file_name       TEXT        NOT NULL,
            file_type       TEXT        NOT NULL DEFAULT 'image',
            data_url        TEXT        NOT NULL,
            submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            seen            BOOLEAN     NOT NULL DEFAULT FALSE,
            UNIQUE (teacher_id, student_id, class_code, date)
        )
    `).catch(err => console.error('[DB] Excuse table init failed:', err.message));

    // ── POST /api/excuse ───────────────────────────────────────────────────────
    // Called by student dashboard after uploading an excuse letter.
    // Body: { teacherId, studentId, studentName, classCode, date, fileName, fileType, dataUrl }
    app.post('/api/excuse', async (req, res) => {
        const { teacherId, studentId, studentName, classCode, date, fileName, fileType, dataUrl } = req.body || {};
        if (!teacherId || !studentId || !classCode || !date || !dataUrl) {
            return res.status(400).json({ ok: false, error: 'Missing required fields' });
        }
        try {
            await pool.query(
                `INSERT INTO excuse_letters
                    (teacher_id, student_id, student_name, class_code, date, file_name, file_type, data_url, submitted_at, seen)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),FALSE)
                 ON CONFLICT (teacher_id, student_id, class_code, date)
                 DO UPDATE SET
                    data_url     = EXCLUDED.data_url,
                    file_name    = EXCLUDED.file_name,
                    file_type    = EXCLUDED.file_type,
                    submitted_at = NOW(),
                    seen         = FALSE`,
                [teacherId, studentId, studentName || 'Student', classCode, date,
                 fileName || 'excuse_letter', fileType || 'image', dataUrl]
            );
            console.log(`[Excuse] ${studentName || studentId} submitted excuse for ${classCode} ${date}`);
            res.json({ ok: true });
        } catch (err) {
            console.error('[Excuse] POST error:', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ── GET /api/excuses/:teacherId ────────────────────────────────────────────
    // Polled by teacher dashboard to pick up new excuse letters from any device.
    // Returns: { ok: true, excuses: [...] }  — ordered newest first
    app.get('/api/excuses/:teacherId', async (req, res) => {
        try {
            const { rows } = await pool.query(
                `SELECT id, student_id, student_name, class_code, date,
                        file_name, file_type, data_url, submitted_at, seen
                 FROM excuse_letters
                 WHERE teacher_id = $1
                 ORDER BY submitted_at DESC`,
                [req.params.teacherId]
            );
            res.json({ ok: true, excuses: rows });
        } catch (err) {
            console.error('[Excuses] GET error:', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // ── PATCH /api/excuse/:id/seen ─────────────────────────────────────────────
    // Teacher marks an excuse as seen after viewing it.
    app.patch('/api/excuse/:id/seen', async (req, res) => {
        try {
            await pool.query('UPDATE excuse_letters SET seen = TRUE WHERE id = $1', [req.params.id]);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });


    // GET /api/db/sync — teacher dashboard polls this to get student scans
    app.get('/api/db/sync', async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT data FROM global_state WHERE id = 1');
            if (!rows.length) {
                return res.json({ ok: true, state: {} });
            }

            let stateData = rows[0].data;

            // Flatten rogue nested 'state' key if present (caused by old wrapper bug)
            // Any data inside stateData.state is promoted to the top level
            if (stateData.state && typeof stateData.state === 'object') {
                const nested = stateData.state;
                const { state: _drop, ...rest } = stateData;
                stateData = { ...nested, ...rest };  // nested keys are overridden by real keys

                // Persist the cleaned version back to DB
                pool.query(
                    `UPDATE global_state SET data = $1::jsonb WHERE id = 1`,
                    [JSON.stringify(stateData)]
                ).catch(e => console.warn('[DB] Cleanup write failed:', e.message));
            }

            res.json({ ok: true, state: stateData });
        } catch (err) {
            console.error('[DB] GET /api/db/sync error:', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // POST /api/db/sync — student phone pushes attendance data here after QR scan
    app.post('/api/db/sync', async (req, res) => {
        try {
            // cloud-sync.js sends: { state: { attendease_teacher_2: "...", ... } }
            // We unwrap the 'state' envelope so keys land at the top level of the DB.
            const incoming = req.body.state || req.body;
            if (!incoming || typeof incoming !== 'object') {
                return res.status(400).json({ ok: false, error: 'Invalid payload' });
            }

            // Read current state, deep-merge at the session level, write back
            const { rows } = await pool.query('SELECT data FROM global_state WHERE id = 1');
            const current = (rows[0]?.data) || {};

            // For each key in the incoming state, merge intelligently
            const merged = { ...current };
            for (const [k, v] of Object.entries(incoming)) {
                // Never store schema version or session in cloud — these are local-only
                if (k === 'attendease_version') continue;
                if (k === 'attendease_session') continue;
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
async function handleMessagingEvent(event) {
    // Only handle standard text messages
    if (!event.message || event.message.is_echo) return;

    const psid = event.sender?.id;
    const text  = event.message?.text?.trim() ?? '';

    console.log(`[Webhook] Message from PSID ${psid}: "${text}"`);

    // Registration command: REGISTER <studentId>
    // We'll also accept just the ID if it looks like YYYY-XXXXX or UID-XXXX
    const match = text.match(/register\s+(.+)/i) || (text.match(/^(20\d{2}-\d{5}|uid-\d+)$/i) ? [null, text] : null);
    if (match) {
        const studentId = match[1].trim();
        
        try {
            // Upsert directly to Supabase via REST
            await supabaseRest.post('/guardian_psids', 
                { student_id: studentId, psid: psid, registered_at: new Date().toISOString() },
                { headers: { 'Prefer': 'resolution=merge-duplicates' } } // This triggers Postgres ON CONFLICT DO UPDATE
            );
            
            console.log(`[Webhook] ✅ Registered guardian PSID ${psid} → student ${studentId} in Supabase`);
            
            sendMessage(psid, {
                text: `✅ You are now registered for attendance alerts for student ${studentId}.\n\nYou will receive a Messenger notification whenever your child is marked absent or late. 📚`
            }).catch(err => console.error('[Webhook] Reply failed:', err.message));
        } catch (err) {
            console.error('[Webhook] Failed to save PSID to Supabase:', err.message);
            sendMessage(psid, {
                text: `⚠ Failed to connect to database. Please try again in a moment.`
            }).catch(() => {});
        }
        return;
    }

    // INFO command: show usage
    if (/^(info|help|start|hello|hi)$/i.test(text)) {
        console.log(`[Webhook] Help request from PSID ${psid}`);
        sendMessage(psid, {
            text: `👋 Welcome to the AttendEase Notifier.\n\nTo link your account to receive attendance alerts, please reply with "REGISTER" followed by the Student ID.\n\nExample: REGISTER 2026-00001`
        }).catch(err => console.error('[Webhook] Help reply failed:', err.message));
        return;
    }

    console.log(`[Webhook] Unrecognised message from ${psid}: "${text}"`);
    sendMessage(psid, {
        text: `🤔 I didn't quite catch that.\n\nIf you want to register for a student's alerts, please format your message like this:\nREGISTER 2026-00001`
    }).catch(err => console.error('[Webhook] Fallback reply failed:', err.message));
}
