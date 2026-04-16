/**
 * psid-store.js — Simple JSON-file based store mapping
 *   studentId  →  { guardianContact, psid, registeredAt }
 *
 * When a guardian messages your Facebook Page, the webhook receives
 * their PSID. This store links that PSID to a student so future
 * notifications can be sent automatically.
 *
 * File: messenger-mcp/data/psid-store.json  (auto-created)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir   = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dir, '..', 'data');
const STORE    = path.join(DATA_DIR, 'psid-store.json');

function load() {
    if (!fs.existsSync(STORE)) return {};
    try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
    catch { return {}; }
}

function save(data) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(data, null, 2), 'utf8');
}

export const psidStore = {
    /** Register or update a guardian's PSID for a student. */
    set(studentId, guardianContact, psid) {
        const data = load();
        data[String(studentId)] = {
            guardianContact,
            psid,
            registeredAt: new Date().toISOString(),
        };
        save(data);
    },

    /** Get the stored PSID for a student (returns null if not registered). */
    get(studentId) {
        const data = load();
        return data[String(studentId)] || null;
    },

    /** List all registered guardians. */
    list() {
        return load();
    },

    /** Remove a guardian registration. */
    remove(studentId) {
        const data = load();
        delete data[String(studentId)];
        save(data);
    },
};
