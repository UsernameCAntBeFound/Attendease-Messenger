/**
 * AttendEase — Facebook Messenger MCP Server
 * ──────────────────────────────────────────
 * Exposes these MCP tools to Claude (or any MCP client):
 *
 *   notify_guardian        — Send an attendance notification to a guardian
 *   notify_all_absent      — Notify all guardians of absent students for a session
 *   register_guardian      — Manually link a guardian's PSID to a student
 *   list_registered        — List all registered guardian PSIDs
 *   remove_guardian        — Unlink a guardian from a student
 *   check_guardian_status  — Check if a student has a registered guardian PSID
 *   send_custom_message    — Send a custom free-form message to a guardian
 *
 * Also starts an Express webhook server on WEBHOOK_PORT so Meta can deliver
 * guardian registration messages (when a guardian texts your Facebook Page).
 */

import 'dotenv/config';
import { McpServer }         from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z }                 from 'zod';

import { sendMessage, sendAttendanceNotification, resolveGuardianPSID } from './messenger.js';
import { psidStore }         from './psid-store.js';
import { createWebhookServer } from './webhook.js';

// ── Start the webhook HTTP server (non-fatal if port is busy) ─────────────────
const PORT = parseInt(process.env.WEBHOOK_PORT || '3000', 10);
const webhookApp = createWebhookServer();
const httpServer = webhookApp.listen(PORT, () => {
    console.error(`[AttendEase MCP] Webhook server listening on http://localhost:${PORT}`);
    console.error(`[AttendEase MCP] MCP server starting on stdio...`);
});
httpServer.on('error', (err) => {
    // Port already in use or other network error — MCP tools still work without webhook
    console.error(`[AttendEase MCP] ⚠️  Webhook could not start on port ${PORT}: ${err.message}`);
    console.error(`[AttendEase MCP] MCP tools will still function. Webhook (guardian registration) disabled.`);
});

// ── Create MCP Server ─────────────────────────────────────────────────────────
const server = new McpServer({
    name:    'attendease-messenger',
    version: '1.0.0',
});

// ══════════════════════════════════════════════════════════════════════════════
//  TOOL: notify_guardian
//  Send an attendance notification to a single student's guardian.
// ══════════════════════════════════════════════════════════════════════════════
server.tool(
    'notify_guardian',
    'Send a Messenger attendance notification to the guardian of a specific student.',
    {
        studentId:   z.string().describe('The student UID, e.g. "2024-00001"'),
        studentName: z.string().describe('Full name of the student'),
        status:      z.enum(['absent', 'late', 'present']).describe('Attendance status'),
        className:   z.string().describe('Subject/class name, e.g. "English"'),
        date:        z.string().describe('Date in YYYY-MM-DD format'),
        remark:      z.string().optional().describe('Optional teacher remark'),
    },
    async ({ studentId, studentName, status, className, date, remark }) => {
        // 1. Try stored PSID first (from webhook registration)
        const stored = psidStore.get(studentId);
        if (!stored?.psid) {
            return {
                content: [{
                    type: 'text',
                    text:
                        `⚠️ No Messenger PSID registered for student "${studentId}" (${studentName}).\n\n` +
                        `The guardian must first message your school's Facebook Page with:\n` +
                        `  REGISTER ${studentId}\n\n` +
                        `Once they do, their PSID is captured automatically and future notifications will work.`,
                }],
            };
        }

        try {
            await sendAttendanceNotification(stored.psid, {
                studentName, status, className, date, remark: remark ?? '',
            });
            return {
                content: [{
                    type: 'text',
                    text: `✅ Attendance notification sent to guardian of ${studentName} (${status.toUpperCase()} — ${className} on ${date}).`,
                }],
            };
        } catch (err) {
            return {
                content: [{
                    type: 'text',
                    text: `❌ Failed to send notification: ${err.message}`,
                }],
            };
        }
    },
);

// ══════════════════════════════════════════════════════════════════════════════
//  TOOL: notify_all_absent
//  Notify all guardians of absent (or late) students for a class session.
//  Pass the session records array from AttendEase's localStorage export.
// ══════════════════════════════════════════════════════════════════════════════
server.tool(
    'notify_all_absent',
    'Bulk-notify guardians of all absent (and optionally late) students for a class session.',
    {
        sessionRecords: z.string().describe(
            'JSON string of session records array: [{studentId, name, status, remark}, ...]'
        ),
        className: z.string().describe('Subject name, e.g. "Mathematics"'),
        date:      z.string().describe('Date in YYYY-MM-DD format'),
        includeLate: z.boolean().optional().describe('Also notify guardians of late students (default: false)'),
    },
    async ({ sessionRecords, className, date, includeLate }) => {
        let records;
        try { records = JSON.parse(sessionRecords); }
        catch { return { content: [{ type: 'text', text: '❌ Invalid JSON in sessionRecords.' }] }; }

        const toNotify = records.filter(r =>
            r.status === 'absent' || (includeLate && r.status === 'late')
        );

        if (!toNotify.length) {
            return { content: [{ type: 'text', text: `✅ No absent${includeLate ? '/late' : ''} students in this session.` }] };
        }

        const results = [];
        for (const r of toNotify) {
            const stored = psidStore.get(r.studentId);
            if (!stored?.psid) {
                results.push(`⚠️ ${r.name} (${r.studentId}) — no PSID registered, skipped`);
                continue;
            }
            try {
                await sendAttendanceNotification(stored.psid, {
                    studentName: r.name,
                    status:      r.status,
                    className,
                    date,
                    remark:      r.remark ?? '',
                });
                results.push(`✅ ${r.name} — guardian notified (${r.status})`);
            } catch (err) {
                results.push(`❌ ${r.name} — send failed: ${err.message}`);
            }
        }

        return { content: [{ type: 'text', text: results.join('\n') }] };
    },
);

// ══════════════════════════════════════════════════════════════════════════════
//  TOOL: register_guardian
//  Manually save a guardian's PSID (obtained from the webhook or Copy Link tool)
// ══════════════════════════════════════════════════════════════════════════════
server.tool(
    'register_guardian',
    'Manually register a guardian\'s Facebook Page-Scoped ID (PSID) for a student.',
    {
        studentId:      z.string().describe('Student UID, e.g. "2024-00001"'),
        guardianPsid:   z.string().describe('Numeric PSID from the Messenger webhook, e.g. "5641234567890123"'),
        guardianContact: z.string().optional().describe('Human-readable contact label (e.g. m.me/username)'),
    },
    async ({ studentId, guardianPsid, guardianContact }) => {
        psidStore.set(studentId, guardianContact ?? '', guardianPsid);
        return {
            content: [{
                type: 'text',
                text: `✅ Guardian PSID ${guardianPsid} registered for student ${studentId}.`,
            }],
        };
    },
);

// ══════════════════════════════════════════════════════════════════════════════
//  TOOL: list_registered
// ══════════════════════════════════════════════════════════════════════════════
server.tool(
    'list_registered',
    'List all students who have a registered guardian PSID.',
    {},
    async () => {
        const all = psidStore.list();
        const entries = Object.entries(all);
        if (!entries.length) {
            return { content: [{ type: 'text', text: 'No guardians registered yet.' }] };
        }
        const lines = entries.map(([sid, d]) =>
            `• Student ${sid}  →  PSID ${d.psid}  (${d.guardianContact || 'no contact label'})  registered ${d.registeredAt}`
        );
        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

// ══════════════════════════════════════════════════════════════════════════════
//  TOOL: remove_guardian
// ══════════════════════════════════════════════════════════════════════════════
server.tool(
    'remove_guardian',
    'Remove a guardian PSID registration for a student.',
    { studentId: z.string().describe('Student UID to unregister') },
    async ({ studentId }) => {
        psidStore.remove(studentId);
        return { content: [{ type: 'text', text: `✅ Guardian removed for student ${studentId}.` }] };
    },
);

// ══════════════════════════════════════════════════════════════════════════════
//  TOOL: check_guardian_status
// ══════════════════════════════════════════════════════════════════════════════
server.tool(
    'check_guardian_status',
    'Check whether a student\'s guardian has registered their Messenger PSID.',
    { studentId: z.string().describe('Student UID to check') },
    async ({ studentId }) => {
        const stored = psidStore.get(studentId);
        if (!stored) {
            return { content: [{ type: 'text', text: `⚠️ Student ${studentId} has no registered guardian PSID.` }] };
        }
        return {
            content: [{
                type: 'text',
                text:
                    `✅ Guardian registered for student ${studentId}.\n` +
                    `   PSID    : ${stored.psid}\n` +
                    `   Contact : ${stored.guardianContact || '(none)'}\n` +
                    `   Since   : ${stored.registeredAt}`,
            }],
        };
    },
);

// ══════════════════════════════════════════════════════════════════════════════
//  TOOL: send_custom_message
//  Send any free-form message to a registered guardian.
// ══════════════════════════════════════════════════════════════════════════════
server.tool(
    'send_custom_message',
    'Send a custom free-form Messenger message to a student\'s guardian.',
    {
        studentId: z.string().describe('Student UID whose guardian receives the message'),
        message:   z.string().min(1).max(2000).describe('The message text to send'),
    },
    async ({ studentId, message }) => {
        const stored = psidStore.get(studentId);
        if (!stored?.psid) {
            return {
                content: [{
                    type: 'text',
                    text: `⚠️ No PSID registered for student ${studentId}. Use register_guardian first.`,
                }],
            };
        }
        try {
            await sendMessage(stored.psid, { text: message }, 'CONFIRMED_EVENT_UPDATE');
            return { content: [{ type: 'text', text: `✅ Message sent to guardian of student ${studentId}.` }] };
        } catch (err) {
            return { content: [{ type: 'text', text: `❌ Send failed: ${err.message}` }] };
        }
    },
);

// ── Start MCP transport ───────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
