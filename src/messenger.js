/**
 * messenger.js — Thin wrapper around the Meta Graph API Send API.
 *
 * Key limitations of the official API (important to understand):
 *   1. You can only message users who have previously messaged your Facebook Page.
 *   2. For notifications outside the 24-hour window you MUST use a Message Tag
 *      (e.g. CONFIRMED_EVENT_UPDATE) — otherwise Meta will reject the request.
 *   3. You build the guardian's PSID by having them send "Register" to your Page
 *      (the webhook stores their PSID from the messaging event).
 *
 * The MCP tools handle all of this gracefully and return clear error messages.
 */

import axios from 'axios';

const BASE = 'https://graph.facebook.com';

/**
 * Low-level: POST to the Messenger Send API.
 *
 * @param {string} psid          – Page-Scoped User ID of the recipient
 * @param {object} messageBody   – The `message` object { text } or { attachment }
 * @param {string} [tag]         – Optional Message Tag for out-of-window messages
 * @returns {Promise<object>}    – Raw API response
 */
export async function sendMessage(psid, messageBody, tag = null) {
    const token   = process.env.FB_PAGE_ACCESS_TOKEN;
    const version = process.env.FB_API_VERSION || 'v19.0';

    if (!token) throw new Error('FB_PAGE_ACCESS_TOKEN is not set in .env');

    const payload = {
        recipient:        { id: psid },
        message:          messageBody,
        messaging_type:   tag ? 'MESSAGE_TAG' : 'RESPONSE',
    };
    if (tag) payload.tag = tag;

    const url = `${BASE}/${version}/me/messages`;

    try {
        const res = await axios.post(url, payload, {
            params:  { access_token: token },
            headers: { 'Content-Type': 'application/json' },
            timeout: 10_000,
        });
        return res.data;
    } catch (err) {
        const detail = err.response?.data?.error;
        const msg    = detail
            ? `Meta API error ${detail.code}: ${detail.message}`
            : err.message;
        throw new Error(msg);
    }
}

/**
 * Send a plain-text attendance notification to a guardian.
 *
 * Uses the CONFIRMED_EVENT_UPDATE tag so the message is delivered
 * even if the guardian hasn't messaged the Page in the last 24 h.
 *
 * @param {string} psid
 * @param {object} opts
 * @param {string} opts.studentName
 * @param {string} opts.status        – 'absent' | 'late' | 'present'
 * @param {string} opts.className
 * @param {string} opts.date          – YYYY-MM-DD
 * @param {string} [opts.teacherName]
 * @param {string} [opts.schoolName]
 * @param {string} [opts.remark]
 */
export async function sendAttendanceNotification(psid, opts) {
    const {
        studentName,
        status,
        className,
        date,
        teacherName = process.env.TEACHER_NAME || 'the teacher',
        schoolName  = process.env.SCHOOL_NAME  || 'School',
        remark      = '',
    } = opts;

    const statusLine = {
        absent:  `⚠️ ABSENT — ${studentName} was marked ABSENT`,
        late:    `🕐 LATE — ${studentName} arrived LATE`,
        present: `✅ PRESENT — ${studentName} was marked PRESENT`,
    }[status] ?? `📋 ${studentName} attendance status: ${status}`;

    const lines = [
        `📢 Attendance Notice from ${schoolName}`,
        ``,
        statusLine,
        `📚 Subject : ${className}`,
        `📅 Date    : ${date}`,
        remark ? `📝 Note    : ${remark}` : null,
        ``,
        `— ${teacherName}`,
        ``,
        `If you have questions, please contact the school directly.`,
    ].filter(l => l !== null);

    return sendMessage(
        psid,
        { text: lines.join('\n') },
        'CONFIRMED_EVENT_UPDATE',  // approved tag for school event updates
    );
}

/**
 * Resolve a stored guardian contact value to a PSID.
 *
 * guardianContact is stored in one of these formats:
 *   • "1234567890"          → treated as a raw PSID (numeric string ≥ 10 digits)
 *   • "m.me/username"       → user profile link (cannot auto-convert → inform user)
 *   • "facebook.com/name"   → profile link (cannot auto-convert → inform user)
 *
 * PSIDs can ONLY be obtained from webhooks (when the user messages your Page).
 * If the stored value is not a raw numeric PSID, we cannot send via API.
 *
 * @param {string} guardianContact
 * @returns {{ psid: string|null, error: string|null }}
 */
export function resolveGuardianPSID(guardianContact) {
    if (!guardianContact) {
        return { psid: null, error: 'No guardian contact set for this student.' };
    }

    // Strip URL prefixes
    const clean = guardianContact
        .replace(/^https?:\/\//i, '')
        .replace(/^(www\.)?facebook\.com\//i, '')
        .replace(/^m\.me\//i, '')
        .trim();

    // A PSID is a long numeric string (≥ 10 digits)
    if (/^\d{10,}$/.test(clean)) {
        return { psid: clean, error: null };
    }

    return {
        psid: null,
        error:
            `"${guardianContact}" looks like a Facebook profile username or link, not a PSID.\n` +
            `To get the PSID, the guardian must first message your school's Facebook Page.\n` +
            `The webhook will capture their PSID automatically — use the register_guardian tool to save it.`,
    };
}
