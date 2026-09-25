const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const http = require('http');
const { Server } = require('socket.io');
const setupSendPulse = require('./sendpulse_engine');
const setupEmailEngine = require('./email_engine');

const app = express();
let globalAiPaused = false;

// CRM access is intentionally enforced on the server (not merely hidden in
// the browser). Set CRM_ADMIN_USER and CRM_PASSWORD_HASH in the environment
// to replace the local administrator credentials without changing code.
const CRM_ADMIN_USER = process.env.CRM_ADMIN_USER || 'Shyam';
const CRM_PASSWORD_HASH = process.env.CRM_PASSWORD_HASH || '4aa9f354454571beb493ea827e70d44ba797cffddff8cf9d7056c22998cceb0940dc4b8c2e317ce9e42271b35767f3cd3fb6905f2e4a3107d578c22580ff7236';
const CRM_SESSION_SECRET = process.env.CRM_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const crmLoginAttempts = new Map();

function parseCookies(req) {
    return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
        const index = part.indexOf('=');
        return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    }));
}
function signCrmSession(value) { return crypto.createHmac('sha256', CRM_SESSION_SECRET).update(value).digest('base64url'); }
function crmSessionFor(req) {
    const token = parseCookies(req).sv_crm_session;
    if (!token) return null;
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature || !crypto.timingSafeEqual(Buffer.from(signCrmSession(encoded)), Buffer.from(signature))) return null;
    try { const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); return payload?.u === CRM_ADMIN_USER && payload.exp > Date.now() ? payload : null; } catch { return null; }
}
function crmAuthRequired(req, res, next) {
    if (crmSessionFor(req)) return next();
    if (req.originalUrl?.startsWith('/api/') || req.baseUrl?.startsWith('/api/') || req.path.startsWith('/api/')) return res.status(401).json({ success: false, message: 'Please sign in to use ScholarVault CRM.' });
    return res.redirect('/crm/login');
}
function setCrmSession(res, req) {
    const encoded = Buffer.from(JSON.stringify({ u: CRM_ADMIN_USER, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
    res.cookie('sv_crm_session', `${encoded}.${signCrmSession(encoded)}`, { httpOnly: true, sameSite: 'lax', secure, maxAge: 12 * 60 * 60 * 1000, path: '/' });
}

// Register request parsers before any routes.  The Master AI routes are near
// the top of this file, so putting these after the routes leaves req.body
// undefined for JSON requests.
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Keep legacy assets reachable, but do not let the old index.html take over `/`.
// The enterprise CRM is now the primary interface; `/legacy` remains a safe rollback.
app.use(express.static(__dirname, { index: false }));
// The CRM uses this local copy for Excel contact imports and template downloads.
// It is deliberately served from this machine, not from a third-party CDN.
app.use('/vendor/xlsx', express.static(path.join(__dirname, 'node_modules', 'xlsx', 'dist')));
// The enterprise CRM is a separate frontend over the existing campaign
// engine. Keeping it on the same server preserves every current API, socket,
// database, scheduler and integration without a migration.
app.get('/crm/login', (req, res) => {
    if (crmSessionFor(req)) return res.redirect('/crm');
    res.sendFile(path.join(__dirname, 'WhatsApp CRM', 'login.html'));
});
app.post('/api/auth/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now(); const attempts = (crmLoginAttempts.get(ip) || []).filter(time => now - time < 10 * 60 * 1000);
    if (attempts.length >= 5) return res.status(429).json({ success: false, message: 'Too many attempts. Please wait 10 minutes.' });
    const user = String(req.body?.username || '').trim();
    const candidate = crypto.scryptSync(String(req.body?.password || ''), 'scholarvault-crm-v1', 64).toString('hex');
    const valid = user === CRM_ADMIN_USER && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(CRM_PASSWORD_HASH));
    if (!valid) { attempts.push(now); crmLoginAttempts.set(ip, attempts); return res.status(401).json({ success: false, message: 'Incorrect username or password.' }); }
    crmLoginAttempts.delete(ip); setCrmSession(res, req); res.json({ success: true });
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('sv_crm_session', { path: '/' }); res.json({ success: true }); });
app.get('/api/auth/status', (req, res) => res.json({ success: true, signedIn: Boolean(crmSessionFor(req)), user: crmSessionFor(req)?.u || '' }));
app.use('/api', (req, res, next) => req.path.startsWith('/auth/') || req.path === '/email/webhooks/brevo' || req.path.startsWith('/sarvam/') ? next() : crmAuthRequired(req, res, next));
const crmStaticOptions = {
    etag: false,
    lastModified: false,
    setHeaders: res => res.setHeader('Cache-Control', 'no-store, max-age=0')
};
app.use('/crm/assets', express.static(path.join(__dirname, 'WhatsApp CRM', 'assets'), crmStaticOptions));
app.use('/crm', crmAuthRequired, express.static(path.join(__dirname, 'WhatsApp CRM'), crmStaticOptions));
app.get('/legacy', (req, res) => res.redirect('/crm'));
app.get('/', (req, res) => res.redirect('/crm'));
app.get('/crm/assets/scholarvault-logo.png', (req, res) => {
    res.sendFile('C:/Users/Shyam/Scholar Vault 2/Official Files and documents/files/scholarvault-logo.png');
});

app.post('/api/settings/master-ai', (req, res) => {
    globalAiPaused = Boolean(req.body?.paused);
    const settings = getDb('settings_ai');
    settings.globalAiPaused = globalAiPaused;
    saveDb('settings_ai', settings);
    console.log(`[Master AI] Global AI Processing is now ${globalAiPaused ? 'PAUSED' : 'ACTIVE'}.`);
    if(typeof io !== 'undefined') io.emit('master_ai_status', { paused: globalAiPaused });
    res.json({ success: true, paused: globalAiPaused });
});

app.get('/api/settings/master-ai', (req, res) => res.json({ paused: globalAiPaused }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
io.use((socket, next) => {
    const session = crmSessionFor({ headers: { cookie: socket.handshake.headers.cookie || '' } });
    if (!session) return next(new Error('Authentication required'));
    next();
});
const PORT = Number(process.env.PORT || 3000);

// --- Database Engine Setup ---
const DB_DIR = path.join(__dirname, 'database');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

// --- Google Sheets Configuration ---
const GOOGLE_SHEET_ID = '13DPuBIqpvZeQEmD7nlg2yLYccpbdzb7ur7moWeDlRmY';
const GOOGLE_CREDS_PATH = path.join(__dirname, 'google-credentials.json');

let sheetsService = null;
async function initSheets() {
    try {
        let authOpts = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
        const envCreds = process.env.GOOGLE_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (envCreds) {
            authOpts.credentials = JSON.parse(envCreds);
        } else {
            authOpts.keyFile = GOOGLE_CREDS_PATH;
        }
        const auth = new google.auth.GoogleAuth(authOpts);
        const client = await auth.getClient();
        sheetsService = google.sheets({ version: 'v4', auth: client });
        console.log('[Google Sheets] Connected successfully.');
    } catch (e) {
        console.error('[Google Sheets] Initialization failed:', e.message);
    }
}
initSheets();

async function syncLeadToSheet(lead) {
    if (!sheetsService) return;
    try {
        const values = [[
            new Date().toLocaleString(),
            lead.name || 'Unknown',
            lead.phone,
            lead.keyword || 'Manual',
            lead.sentiment || 'Neutral',
            lead.message || ''
        ]];
        await sheetsService.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Sheet1!A2',
            valueInputOption: 'USER_ENTERED',
            resource: { values }
        });
        console.log(`[Google Sheets] Synced lead: ${lead.phone}`);
    } catch (e) {
        console.error('[Google Sheets] Sync failed:', e.message);
    }
}

const getDb = (name) => {
    try {
        const file = path.join(DB_DIR, `${name}.json`);
        if (!fs.existsSync(file)) {
            const isArray = ['blacklist', 'inbox', 'hot_leads', 'instances', 'ai_replies', 'automation_audit', 'email_templates', 'email_events', 'email_lists', 'email_ab_tests', 'resource_packs', 'whatsapp_templates'].includes(name);
            fs.writeFileSync(file, isArray ? '[]' : '{}');
        }
        let data = JSON.parse(fs.readFileSync(file, 'utf8'));
        
        // Defensive type guard to prevent serialization errors (e.g. conversations loaded as array)
        const expectArray = ['blacklist', 'inbox', 'hot_leads', 'instances', 'ai_replies', 'automation_audit', 'email_templates', 'email_events', 'email_lists', 'email_ab_tests', 'resource_packs', 'whatsapp_templates'].includes(name);
        if (expectArray && !Array.isArray(data)) {
            data = [];
        } else if (!expectArray && (Array.isArray(data) || typeof data !== 'object' || data === null)) {
            data = {};
        }
        return data;
    } catch (e) {
        console.error(`[DB Error] Failed reading ${name}:`, e.message);
        return ['blacklist', 'inbox', 'hot_leads', 'instances', 'ai_replies', 'automation_audit', 'email_templates', 'email_events', 'email_lists', 'email_ab_tests', 'resource_packs', 'whatsapp_templates'].includes(name) ? [] : {};
    }
};

const saveDb = (name, data) => {
    fs.writeFileSync(path.join(DB_DIR, `${name}.json`), JSON.stringify(data, null, 2));
};

// Conversation and contact helpers. Evolution can report a device-local label
// (for example "Você") or a stale push name, so display identity is resolved
// once here rather than independently by every screen.
const SELF_CONTACT_LABELS = new Set(['você', 'voce', 'you', 'me', 'myself', 'unknown', 'scholarvault official']);
const AUTOMATED_SENDER_TYPES = new Set(['bot', 'auto_rule', 'mistral', 'guardrail', 'drip', 'system']);
const normalizeJid = value => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.includes('@') ? raw.toLowerCase() : `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
};
function recordLidMapping(lid, phoneJid) {
    if (!lid || !phoneJid) return;
    const cleanLid = normalizeJid(lid);
    const cleanPhone = normalizeJid(phoneJid);
    if (cleanLid.includes('@lid') && cleanPhone.includes('@s.whatsapp.net')) {
        let mappings = getDb('lid_mappings');
        if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) mappings = {};
        if (mappings[cleanLid] !== cleanPhone) {
            mappings[cleanLid] = cleanPhone;
            saveDb('lid_mappings', mappings);
            console.log(`[LID Mapping] Mapped ${cleanLid} -> ${cleanPhone}`);
        }
    }
}
function resolveCanonicalJid(jid, candidateAlt = null) {
    const clean = normalizeJid(jid);
    if (!clean) return '';
    if (candidateAlt && candidateAlt.includes('@s.whatsapp.net')) {
        recordLidMapping(clean, candidateAlt);
        return normalizeJid(candidateAlt);
    }
    if (clean.includes('@lid')) {
        const mappings = getDb('lid_mappings') || {};
        if (mappings[clean]) {
            return mappings[clean];
        }
    }
    return clean;
}
function getLidsForPhone(phoneJid) {
    const cleanPhone = normalizeJid(phoneJid);
    const mappings = getDb('lid_mappings') || {};
    const lids = [];
    for (const [lid, phone] of Object.entries(mappings)) {
        if (normalizeJid(phone) === cleanPhone) {
            lids.push(lid);
        }
    }
    return lids;
}
const isUsableContactName = value => {
    const name = String(value || '').trim();
    return Boolean(name) && !SELF_CONTACT_LABELS.has(name.toLowerCase()) && !/^\d+$/.test(name);
};
const isoFromWhatsAppTimestamp = value => {
    if (value == null) return null;
    const numeric = Number(value);
    const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
function resolveContactIdentity(jid, contacts = getDb('contacts'), candidates = []) {
    const key = resolveCanonicalJid(jid);
    const contact = contacts[key] || contacts[normalizeJid(jid)] || {};
    // A user-confirmed name is always authoritative. The CRM stores this flag
    // when a contact is saved from the conflict review panel.
    if (isUsableContactName(contact.displayNameOverride)) return contact.displayNameOverride.trim();
    if (contact.nameConfirmed === true && isUsableContactName(contact.name)) return contact.name.trim();
    for (const candidate of candidates) if (isUsableContactName(candidate)) return String(candidate).trim();
    if (isUsableContactName(contact.name)) return contact.name.trim();
    return key.split('@')[0] || 'Unknown contact';
}
function canonicalizeInboxRows(rows, contacts = getDb('contacts')) {
    const byJid = new Map();
    for (const source of Array.isArray(rows) ? rows : []) {
        const rawJid = normalizeJid(source.jid);
        if (!rawJid || rawJid.includes('@g.us') || rawJid === 'status@broadcast') continue;
        const jid = resolveCanonicalJid(rawJid, source.remoteJidAlt);
        const row = { ...source, jid };
        const current = byJid.get(jid);
        const rowTime = new Date(row.lastMessageAt || row.timestamp || 0).getTime() || 0;
        const currentTime = current ? (new Date(current.lastMessageAt || current.timestamp || 0).getTime() || 0) : -1;
        if (!current || rowTime >= currentTime) byJid.set(jid, { ...current, ...row, jid });
    }
    return [...byJid.values()]
        .map(row => ({ ...row, name: resolveContactIdentity(row.jid, contacts, [row.name, row.pushName]), lastMessageAt: row.lastMessageAt || row.timestamp }))
        .sort((a, b) => (new Date(b.lastMessageAt || b.timestamp || 0).getTime() || 0) - (new Date(a.lastMessageAt || a.timestamp || 0).getTime() || 0));
}
function upsertConversationIndex(entry, contacts = getDb('contacts')) {
    const canonicalJid = resolveCanonicalJid(entry.jid, entry.remoteJidAlt);
    const inbox = canonicalizeInboxRows(getDb('inbox'), contacts).filter(row => row.jid !== canonicalJid);
    const resolved = {
        ...entry,
        jid: canonicalJid,
        name: resolveContactIdentity(canonicalJid, contacts, [entry.name, entry.pushName]),
        timestamp: entry.timestamp || new Date().toISOString(),
        lastMessageAt: entry.lastMessageAt || entry.timestamp || new Date().toISOString()
    };
    const merged = canonicalizeInboxRows([resolved, ...inbox], contacts);
    saveDb('inbox', merged);
    return merged;
}
function upsertThreadMessage(jid, item) {
    const key = resolveCanonicalJid(jid, item.remoteJidAlt || item.key?.remoteJidAlt);
    const threads = getDb('conversations');
    const items = Array.isArray(threads[key]) ? threads[key] : [];
    const id = item.id || item.messageId;
    const existing = id ? items.findIndex(message => (message.id || message.messageId) === id) : -1;
    if (existing >= 0) items[existing] = { ...items[existing], ...item };
    else items.push(item);
    threads[key] = items
        .sort((a, b) => (new Date(a.timestamp || 0).getTime() || 0) - (new Date(b.timestamp || 0).getTime() || 0))
        .slice(-200);
    saveDb('conversations', threads);
    return threads[key];
}
function logAutomationAudit(origin, jid, outcome, details = {}) {
    const audit = getDb('automation_audit');
    audit.unshift({ id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, origin, jid: normalizeJid(jid), outcome, timestamp: new Date().toISOString(), ...details });
    saveDb('automation_audit', audit.slice(0, 500));
}

function getDefaultInstanceName() {
    const instances = getDb('instances');
    if (Array.isArray(instances) && instances.length > 0) {
        const defaultInst = instances.find(i => i.isDefault);
        if (defaultInst) return defaultInst.name;
        return instances[0].name;
    }
    return 'ScholarVault';
}


// Listmonk has been retired from operations. Its prior local configuration and
// test records are intentionally left untouched for recovery, but new CRM
// workflows use the native Brevo email engine instead.

// Pre-filtering and guardrail check to prevent off-topic, administrative, or hostile queries
function preFilterIncomingMessage(text) {
    const lower = text.toLowerCase().trim();
    
    // 1. Administrative / Database access request hacks
    if (lower.includes('delete') && (lower.includes('message') || lower.includes('database') || lower.includes('record') || lower.includes('data') || lower.includes('history') || lower.includes('chat'))) {
        return {
            prohibited: true,
            reply: "I am the ScholarVault WhatsApp Assistant. I do not have administrative access, backend server control, or database modification capabilities. For any database or data registry requests, please contact our support desk directly at support@scholarvault.in. Your data privacy is important to us, and database modifications can only be processed securely by authenticated administrators."
        };
    }
    
    // 2. Off-topic jokes, roasts, or entertainment requests
    if (lower.includes('roast') || lower.includes('joke') || lower.includes('story') || lower.includes('poem') || lower.includes('song') || lower.includes('stupid') || lower.includes('fool') || lower.includes('idiot')) {
        return {
            prohibited: true,
            reply: "I am a professional assistant dedicated to helping researchers with academic integrity, conference verification, and our verified conference events (ICAHCR 2026 and ISIAI-SGS 2026). I do not engage in off-topic chatter, roasts, jokes, or creative writing. Please let me know if you would like info on paper templates, deadlines, tracks, or registration!"
        };
    }
    
    // 3. Sensitive / Political topics (refined to avoid blocking normal trust score/approval queries)
    if ((lower.includes('politics') || lower.includes('modi') || lower.includes('election') || lower.includes('religion') || lower.includes('political')) ||
        (lower.includes('government') && (lower.includes('bad') || lower.includes('corrupt') || lower.includes('party')))) {
        return {
            prohibited: true,
            reply: "ScholarVault is a neutral, professional academic integrity platform and conference series organizer. I do not discuss political, religious, or sensitive governmental topics. Let me know if you would like information about our verified conference tracks or registration options."
        };
    }

    // 4. Competitor comparison or reference guardrail
    const competitors = ['iferp', 'iaisr', 'allconferencealert', 'conferencealert', 'conference alert', 'competitor'];
    if (competitors.some(comp => lower.includes(comp))) {
        return {
            prohibited: true,
            reply: `Hello! 👋\n\nScholarVault is a verified academic integrity platform and a *Startup India Recognized (DPIIT Certified)* conference organizer (Trust Score: 92/100).\n\nTo protect your research, you can check the independent Trust & Integrity Score of any conference (including third-party events) directly on our official registry at *https://app.scholarvault.in* 🔍\n\nSimply enter the conference domain or acronym there to verify its credentials before submitting your work!\n\nIn the meantime, we would be delighted to share details about our double-blind peer-reviewed conference tracks for our upcoming *ICAHCR 2026* (AI in Healthcare) or *ISIAI-SGS 2026* (Sustainability) events.\n\nWould you like to look at our verified conference tracks or download our official brochure? 📄\n\n— ScholarVault Team`
        };
    }

    // 5. Scopus direct inquiry guardrail
    if (lower.includes('scopus')) {
        return {
            prohibited: true,
            reply: `Hello! 👋\n\nThank you for asking! To maintain absolute clarity and transparency for our researchers:\n\nOur conference proceedings themselves are not Scopus-indexed. However, for selected high-quality papers presented at our events, we actively offer official *Scopus-indexed journal publication pathways*!\n\nWe work closely with our affiliated academic journals to help researchers get their extended work published in Scopus-indexed registries.\n\nWould you like to know more about our journal submission guidelines or our double-blind peer-reviewed conference tracks? 📄\n\n— ScholarVault Team`
        };
    }
    
    return { prohibited: false };
}

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';

function loadKnowledgeBase() {
    try {
        const kbPath = path.join(__dirname, 'database', 'scholarvault_knowledge.json');
        const raw = fs.readFileSync(kbPath, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.error('[Knowledge Base] Error loading:', err.message);
        return null;
    }
}

function buildPromptFromKnowledge(kb) {
    if (!kb) return 'You are a helpful conference assistant for ScholarVault. Answer politely.';

    const lines = [];
    lines.push(`You are ScholarVault's official WhatsApp assistant.`);
    lines.push(`Your goal is to guide users through a multi-stage conversational funnel, starting with profiling their role and interests BEFORE revealing detailed conference info.`);
    lines.push(``);
    lines.push(`*** IMPORTANT ROUTING & COGNITION DIRECTIVE ***`);
    lines.push(`- By default, if the user asks a general question (e.g., about registration, pricing, paper template, deadlines, submission, certificates) without specifying a conference name, ASSUME they are asking about the nearest conference: **ICAHCR 2026 (AI Health)**.`);
    lines.push(`- If the user explicitly mentions sustainability, environmental, climate, plants, agriculture, precision farming, carbon, green computing, or refers to "ISIAI-SGS 2026", route them dynamically to **ISIAI-SGS 2026** details.`);
    lines.push(`- Answer ONLY based on the exact facts provided below. If a question is NOT covered, say: "Great question! Let me connect you with our team — email conferences@scholarvault.in or call +91-86101-00624."`);

    // Organization
    if (kb.organization) {
        const o = kb.organization;
        lines.push('', '=== ABOUT SCHOLARVAULT ===');
        lines.push(`- Tagline: ${o.tagline}`);
        lines.push(`- Problem Statement: ${o.problemStatement}`);
        lines.push(`- Why Founded: ${o.whyFounded}`);
        lines.push(`- Legal Registry: ${o.type}`);
        lines.push(`- MSME Number: ${o.msmeNumber}`);
        lines.push(`- Startup India Recognition: ${o.startupIndiaNumber}`);
        lines.push(`- StartupTN ID: ${o.startupTnId}`);
        lines.push(`- GSTIN: ${o.gstin}`);
        lines.push(`- Headquartered in ${o.hq}`);
        if (o.founder) lines.push(`- Founder & CEO: ${o.founder}${o.founderTitle ? ' (' + o.founderTitle + ')' : ''}`);
        if (o.founderBackground) lines.push(`- Founder Background: ${o.founderBackground}`);
        if (o.foundingStory) lines.push(`- Founding Story & Mission: ${o.foundingStory}`);
        if (o.recognitions?.length) lines.push(`- Recognised by: ${o.recognitions.join(', ')}`);
        if (o.stats) lines.push(`- Stats: Launched in ${o.stats.launchYear}. ${o.stats.researchersInEarlyAccess} researchers in early access, ${o.stats.conferencesAudited} conferences audited`);
        if (o.description) lines.push(`- Description: ${o.description}`);
    }

    // Verification
    if (kb.verification) {
        const v = kb.verification;
        lines.push('', '=== HOW TO VERIFY A CONFERENCE ===');
        lines.push(`- ${v.howToVerify}`);
        lines.push(`- ${v.badgeRules}`);
        if (v.trustTiers?.length) {
            lines.push('- Trust Tiers: ' + v.trustTiers.map(t => `${t.range} = ${t.tier}`).join(', '));
        }
        if (v.freePlan) lines.push(`- Free Plan: ${v.freePlan}`);
        if (v.goldPlan) lines.push(`- Gold Plan: ${v.goldPlan}`);
    }

    // Conferences details
    if (kb.conferences) {
        Object.entries(kb.conferences).forEach(([confId, c]) => {
            lines.push('', `========================================`);
            lines.push(`=== CONFERENCE: ${c.name} (${c.fullName}) ===`);
            lines.push(`========================================`);
            lines.push(`- Short Name: ${c.name}`);
            lines.push(`- Full Name: ${c.fullName}`);
            lines.push(`- Dates: ${c.dates}`);
            lines.push(`- Format: ${c.format}`);
            if (c.trustScore) lines.push(`- ScholarVault Trust Score: ${c.trustScore}`);
            if (c.verifiedDate) lines.push(`- Verification Audit Date: ${c.verifiedDate}`);
            if (c.isFirstConference) lines.push(`- This is ScholarVault's FIRST conference`);
            if (c.contact) {
                lines.push(`- Phone: ${c.contact.phone}`);
                lines.push(`- Email: ${c.contact.email}`);
                lines.push(`- Hours: ${c.contact.hours}`);
            }
            if (c.mission) lines.push(`- Mission: ${c.mission}`);
            if (c.vision) lines.push(`- Vision: ${c.vision}`);

            // Links
            if (c.links) {
                lines.push('', `=== ${c.name} OFFICIAL LINKS REGISTRY ===`);
                Object.entries(c.links).forEach(([key, url]) => {
                    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
                    lines.push(`- ${label} URL: ${url}`);
                });
            }

            // Submission
            if (c.submission) {
                const s = c.submission;
                lines.push('', `=== ${c.name} SUBMISSION PARAMETERS ===`);
                lines.push(`- Deadline: ${s.deadline}`);
                lines.push(`- Acceptable Formats: ${s.formats.join(', ')}`);
                lines.push(`- Maximum Page Length: ${s.maxPages} pages`);
                lines.push(`- Plagiarism Limit: Under ${s.plagiarismLimit} (strict Turnitin check, excluding references)`);
                lines.push(`- Review Type: ${s.reviewType}`);
                lines.push(`- Peer Review Timeline: Approximately ${s.reviewTimeline}`);
                lines.push(`- Camera-Ready Paper Required: ${s.cameraReadyRequired ? 'Yes' : 'No'}`);
            }

            // Important Dates
            if (c.importantDates?.length) {
                lines.push('', `=== ${c.name} IMPORTANT DATES ===`);
                c.importantDates.forEach(d => lines.push(`- ${d.event}: ${d.date}`));
            }

            // Pricing
            if (c.pricing) {
                const p = c.pricing;
                lines.push('', `=== ${c.name} REGISTRATION PRICING ===`);
                if (p.earlyBirdDeadline) lines.push(`- Early Bird Deadline: ${p.earlyBirdDeadline}`);
                if (p.tiers?.length) {
                    p.tiers.forEach(t => {
                        const badge = t.badge ? ` [${t.badge}]` : '';
                        const ebInr = t.inrEarlyBird ? ` (Early Bird: Rs.${t.inrEarlyBird.toLocaleString()})` : '';
                        const ebUsd = t.usdEarlyBird ? ` (Early Bird: $${t.usdEarlyBird})` : '';
                        lines.push(`- ${t.name}${badge}: Rs.${t.inr.toLocaleString()}${ebInr} | $${t.usd}${ebUsd}`);
                    });
                }
                if (p.goldDiscount) lines.push(`- ${p.goldDiscount}`);
                if (p.paymentMethods) lines.push(`- Payment Gateway: ${p.paymentMethods}`);
            }

            // Tracks
            if (c.tracks?.length) {
                lines.push('', `=== ${c.name} RESEARCH TRACKS ===`);
                c.tracks.forEach(t => {
                    lines.push(`- Track: ${t.name}${t.topics?.length ? ' (' + t.topics.join(', ') + ')' : ''}`);
                });
            }

            // Speakers
            if (c.speakers?.length) {
                lines.push('', `=== ${c.name} CONFIRMED SPEAKERS & KEYNOTES ===`);
                c.speakers.forEach(s => {
                    const typeStr = s.type ? `[${s.type}] ` : '';
                    const creds = s.credentials ? `, ${s.credentials}` : '';
                    const titleStr = s.title ? ` - ${s.title}` : '';
                    const affStr = s.affiliation ? ` (${s.affiliation})` : '';
                    const topicStr = s.topic ? ` - Topic: "${s.topic}"` : '';
                    lines.push(`- ${typeStr}${s.name}${creds}${titleStr}${affStr}${topicStr}`);
                });
            }

            // Committee
            if (c.committee?.length) {
                lines.push('', `=== ${c.name} COMMITTEE MEMBERS ===`);
                c.committee.forEach(com => {
                    const creds = com.credentials ? `, ${com.credentials}` : '';
                    const titleStr = com.title ? ` - ${com.title}` : '';
                    const affStr = com.affiliation ? ` (${com.affiliation})` : '';
                    lines.push(`- ${com.name}${creds}${titleStr}${affStr}`);
                });
            }
        });
    }

    // FAQ
    if (kb.faq?.length) {
        lines.push('', '=== FREQUENTLY ASKED QUESTIONS ===');
        kb.faq.forEach(f => lines.push(`Q: ${f.q}\nA: ${f.a}`));
    }

    // Human Escalation Rules
    if (kb.escalation) {
        const esc = kb.escalation;
        lines.push('', '=== HUMAN ESCALATION DESKS ===');
        lines.push(`- Finance/Invoices: ${esc.finance.department} — Phone: ${esc.finance.phone}, Email: ${esc.finance.email}`);
        lines.push(`- Technical/Portal Support: ${esc.technical.department} — Phone: ${esc.technical.phone}, Email: ${esc.technical.email}`);
        lines.push(`- Speaker/Keynote Relations: ${esc.speakerSupport.department} — Phone: ${esc.speakerSupport.phone}, Email: ${esc.speakerSupport.email}`);
    }

    // Safe Recovery Fallbacks
    if (kb.fallbacks) {
        const f = kb.fallbacks;
        lines.push('', '=== SAFE CONVERSATIONAL RECOVERY FALLBACKS ===');
        lines.push(`- If completely unknown query: "${f.unknown}"`);
        lines.push(`- If partial matching context: "${f.partialMatch}"`);
    }

    // Anti-Hallucination Restrictions
    if (kb.restrictions) {
        lines.push('', '=== STRICT ANTI-HALLUCINATION RESTRICTIONS (MANDATORY) ===');
        Object.entries(kb.restrictions).forEach(([key, rule]) => {
            lines.push(`- ${rule}`);
        });
    }

    // Lead Capture Schema
    if (kb.leadCapture) {
        lines.push('', '=== CONVERSATIONAL LEAD CAPTURE SYSTEM ===');
        lines.push(`Proactively and progressively harvest these details: ${kb.leadCapture.collect.join(', ')}`);
        lines.push('Do NOT ask for all details at once. Collect them naturally. When a detail is revealed by the user, output it in the strict JSON tag.');
        lines.push('Tag Output Format: At the VERY END of your reply, output updated details inside <context>{"name": "...", "institution": "...", "role": "...", "email": "...", "country": "..."}</context> tags. Only include keys that you have newly learned.');
    }

    // Languages Preparedness
    if (kb.languages) {
        lines.push('', '=== MULTI-LANGUAGE RULES ===');
        lines.push(`Supported: ${kb.languages.join(', ')}.`);
        lines.push('ALWAYS respond in the language the user is chatting in (English, Tamil, or Hindi) but maintain absolute factual alignment.');
    }

    // Conversation Rules
    if (kb.conversationRules) {
        lines.push('', '=== CONVERSATION BEHAVIOR RULES ===');
        Object.entries(kb.conversationRules).forEach(([key, rule]) => {
            const label = key.replace(/([A-Z])/g, ' $1').toUpperCase();
            lines.push(`${label}: ${rule}`);
        });
    }

    // Dynamic Hooks
    if (kb.dynamicHooks) {
        lines.push('', '=== DYNAMIC ROLE-BASED HOOKS ===');
        lines.push('Use the exact messaging hooks below when responding to a specific role:');
        Object.entries(kb.dynamicHooks).forEach(([role, hook]) => {
            lines.push(`- IF ROLE IS "${role}": ${hook}`);
        });
    }

    // Response Rules
    if (kb.responseRules?.length) {
        lines.push('', '=== STRICT RESPONSE RULES ===');
        kb.responseRules.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
    }

    return lines.join('\n');
}

function getAISettings() {
    const kb = loadKnowledgeBase();
    const dynamicContext = buildPromptFromKnowledge(kb);

    const defaults = {
        enabled: true,
        apiKey: 'T4xvwnfcpNix7tGB5tiiU9oNoR7sxtg7',
        model: 'open-mistral-nemo',
        maxTokens: 600,
        temperature: 0.3,
        businessContext: dynamicContext
    };
    const saved = getDb('settings_ai');
    if (saved && Object.keys(saved).length > 0) {
        // If saved settings exist but no custom businessContext, use dynamic one
        if (!saved.businessContext) {
            return { ...defaults, ...saved, businessContext: dynamicContext };
        }
        return { ...defaults, ...saved };
    }
    return defaults;
}

function getSessionContext(jid) {
    const db = getDb('session_contexts') || {};
    return db[jid] || { stage: 'role_selection', role: null, conferenceInterest: null, intent: null, submissionStage: null, userRole: null, lastIntent: null, institution: null, name: null, country: null, email: null };
}

function saveSessionContext(jid, context) {
    const db = getDb('session_contexts') || {};
    db[jid] = context;
    saveDb('session_contexts', db);
}

async function syncLearnedLeadToContacts(jid, context, pushName) {
    try {
        let contacts = getDb('contacts');
        const digits = jid.split('@')[0];
        
        let contactKey = jid;
        if (!contacts[contactKey] && contacts[digits]) {
            contactKey = digits;
        }
        
        const mappedRole = context.userRole || context.role || '';
        const nameVal = context.name || pushName || 'Contact';
        
        if (contacts[contactKey]) {
            // Update existing contact details with newly captured lead info
            contacts[contactKey].name = nameVal;
            if (context.email) contacts[contactKey].email = context.email;
            if (context.institution) contacts[contactKey].company = context.institution; // company field
            if (context.country) contacts[contactKey].country = context.country;
            if (mappedRole) contacts[contactKey].designation = mappedRole;
            
            saveDb('contacts', contacts);
            console.log(`[CRM Lead Capture] Synced updated lead for ${jid}`);
        } else {
            // Create a new contact lead
            contacts[jid] = {
                jid: jid,
                name: nameVal,
                email: context.email || '',
                company: context.institution || '',
                country: context.country || '',
                designation: mappedRole,
                leadStatus: 'Clean',
                createdAt: new Date().toISOString()
            };
            saveDb('contacts', contacts);
            console.log(`[CRM Lead Capture] Captured NEW lead for ${jid}`);
            
            // Sync to Google Sheets
            await syncLeadToSheet({
                name: nameVal,
                phone: digits,
                keyword: 'AI Lead Capture',
                sentiment: 'Interested',
                message: `Institution: ${context.institution || 'N/A'}, Role: ${mappedRole || 'N/A'}`
            });
        }
    } catch (err) {
        console.error('[CRM Lead Capture] Sync error:', err.message);
    }
}

async function generateAIReply(incomingText, senderJid, senderName) {
    const settings = getAISettings();
    if (!settings.enabled || !settings.apiKey) return null;

    try {
        // Load operational session memory for this JID
        const sessionContext = getSessionContext(senderJid);

        // Build conversation history for context
        const threads = getDb('conversations');
        const history = (threads[senderJid] || []).slice(-5);

        // Prepend user-specific session state to the system prompt
        const stateStr = `\n\n=== CURRENT USER SESSION STATE ===\nYou are chatting with a user who has the following verified context. Refer to them by name if present, and do not repeat questions for details already captured:\n${JSON.stringify(sessionContext, null, 2)}`;
        
        const messages = [{ role: 'system', content: settings.businessContext + stateStr }];
        history.forEach(msg => {
            messages.push({
                role: msg.direction === 'in' ? 'user' : 'assistant',
                content: msg.text
            });
        });
        messages.push({ role: 'user', content: incomingText });

        const response = await axios.post(
            MISTRAL_API_URL,
            {
                model: settings.model,
                messages: messages,
                max_tokens: settings.maxTokens,
                temperature: Math.min(settings.temperature !== undefined ? settings.temperature : 0.1, 0.1)
            },
            {
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        const aiText = response.data?.choices?.[0]?.message?.content || null;
        const tokensUsed = response.data?.usage?.total_tokens || 0;

        let cleanedText = aiText;
        let requiresHandoff = false;

        // Context Tag Parser & Dynamic CRM State Sync
        if (aiText) {
            // Check for handoff/escalate tags
            const handoffRegex = /<(handoff|escalate)>([\s\S]*?)<\/(handoff|escalate)>/i;
            if (handoffRegex.test(aiText)) {
                requiresHandoff = true;
                cleanedText = cleanedText.replace(handoffRegex, '').trim();
            }

            const contextRegex = /<context>([\s\S]*?)<\/context>/i;
            const match = cleanedText.match(contextRegex);
            if (match) {
                try {
                    const parsedUpdate = JSON.parse(match[1].trim());
                    // Merge and save state memory
                    const updatedContext = { ...sessionContext, ...parsedUpdate };
                    if (requiresHandoff) {
                        updatedContext.escalated = true;
                        updatedContext.lastIntent = 'ai_requested_handoff';
                    }
                    saveSessionContext(senderJid, updatedContext);
                    console.log(`[Session State] Captured operational context update for ${senderJid}:`, updatedContext);
                    
                    // CRM Contact & Google Sheet Sync
                    await syncLearnedLeadToContacts(senderJid, updatedContext, senderName);
                } catch (jsonErr) {
                    console.error('[Session State] Failed parsing context block:', jsonErr.message);
                }
                // Strip state tags from final user message
                cleanedText = cleanedText.replace(contextRegex, '').trim();
            } else if (requiresHandoff) {
                const updatedContext = { ...sessionContext, escalated: true, lastIntent: 'ai_requested_handoff' };
                saveSessionContext(senderJid, updatedContext);
                console.log(`[Session State] Flagged handoff request for ${senderJid}`);
            }
            
            logAIReply(senderJid, senderName, incomingText, cleanedText, tokensUsed);
        }

        return cleanedText;
    } catch (err) {
        console.error('[AI Mistral] Error:', err.response?.data?.message || err.message);
        return null;
    }
}

function logAIReply(jid, name, userMessage, aiReply, tokensUsed) {
    let logs = getDb('ai_replies');
    if (!Array.isArray(logs)) logs = [];
    logs.unshift({
        jid, name, userMessage, aiReply, tokensUsed,
        timestamp: new Date().toISOString()
    });
    if (logs.length > 500) logs = logs.slice(0, 500);
    saveDb('ai_replies', logs);
}

// ─── Smart Auto Responder Rules ───
const DEFAULT_AUTO_REPLY_RULES = [
    // ══ HOW TO REGISTER (specific, must be before 'register') ══
    { trigger: 'how to register', reply: `{Sure|Happy to help}! Here's how to register for *AIHealth 2025* 📝\n\n*Step 1:* Visit → https://aihealth.scholarvault.in\n*Step 2:* Click "Register Now"\n*Step 3:* Fill your details (Name, Institute, Email)\n*Step 4:* Complete payment & download confirmation ✅\n\n{Takes less than 5 minutes|Super quick process}!\n\nNeed help at any step? Just reply!\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ MORE DETAILS (specific) ══
    { trigger: 'more details', reply: `{Sure thing|Absolutely}! Here's everything about *AIHealth 2025* 📋\n\n💡 *Topics:*\n• AI & ML in Diagnostics\n• Drug Discovery with Deep Learning\n• Digital Health & Telemedicine\n• Ethics & Governance in AI\n• Clinical Decision Support Systems\n\n🏅 *Organised by ScholarVault* | ✅ Startup India Recognized\n📅 July 18–19, 2025 | Chennai, India\n🔗 https://aihealth.scholarvault.in\n\nAny specific questions? {I'm here|Just ask}!\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ WHO ARE YOU (specific) ══
    { trigger: 'who are you', reply: `{Hello|Hi}! 👋 We are *ScholarVault* — India's leading academic conference platform.\n\n🏅 Startup India Recognized (DPIIT Certified)\n🌍 10,000+ researchers across 30+ countries\n🔒 92/100 Trust & Safety Score\n\nWe invited you to *AIHealth 2025* (July 18–19, Chennai).\n🔗 https://www.scholarvault.in\n\n{Any questions?|Happy to help!}\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'who is this', reply: `{Hi|Hello}! 👋 This is *ScholarVault* — India's leading academic conference organiser.\n\n🏅 Startup India Recognized | 92/100 Trust Score\n🎓 Organising *AIHealth 2025* — July 18–19, Chennai\n🔗 https://www.scholarvault.in\n\n{Any questions?|What would you like to know?}\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ HOW DID YOU GET MY NUMBER ══
    { trigger: 'how did you get my number', reply: `{Completely understand|That's a valid question}! 🙏\n\nYour number is part of our academic research network — compiled from conference registrations and academic institution partnerships.\n\nWe comply with WhatsApp's messaging guidelines. Reply *STOP* anytime to be removed immediately.\n\n{Sorry if this was unexpected|We apologize for any inconvenience}.\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'how do you know', reply: `{Totally fair to ask|Completely understand}! 🙏\n\nYour contact is part of our verified academic research network. Reply *STOP* to be removed immediately from all future messages.\n\n{We respect your privacy|We apologize for any inconvenience}.\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ WHAT IS SCHOLARVAULT ══
    { trigger: 'what is scholarvault', reply: `{Great question|Happy to explain}! 🌟\n\n*ScholarVault* — India's most trusted academic conference platform.\n\n🎯 *What we do:*\n• International research conferences\n• Scopus-indexed paper publication\n• AI-powered paper matching & peer review\n• Connecting researchers globally\n\n🏅 Startup India Recognized (DPIIT)\n🌍 10,000+ researchers | 30+ countries | 🔒 92/100 Trust Score\n\n🔗 https://www.scholarvault.in\n\n{Want to know about our conferences?|Shall I share upcoming events?}\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ GENERAL INTEREST & POSITIVE ══
    { trigger: 'interested', reply: `{Fantastic|Brilliant}! 🌟 Since you're interested:\n\n📌 *AIHealth 2025* — AI in Healthcare Conference\n📅 July 18–19, 2025 | Chennai, India\n\n✅ *You get:*\n• Scopus-indexed paper publication\n• Certificate of Participation\n• Networking with 200+ researchers from 15+ countries\n\n🔗 Register: https://aihealth.scholarvault.in\n\n{Shall I share registration steps?|Would you like the brochure?} Just say the word!\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'yes', reply: `{Great to hear|Wonderful|Excellent}! 🎉\n\n*AIHealth 2025* Full Details:\n📅 July 18–19, 2025\n📍 Chennai, Tamil Nadu, India\n🔗 Register: https://aihealth.scholarvault.in\n\n{We'd love to see you there|Looking forward to having you}! Any questions? {Just ask|We're here}.\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'register', reply: `{Sure|Great choice}! 🎉 Register here:\n🔗 https://aihealth.scholarvault.in\n\n📅 *AIHealth 2025* | July 18–19, 2025 | Chennai\n\n{Takes just 5 minutes|Quick and easy}! Reply if you face any issue.\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'send brochure', reply: `{Sure|Absolutely}! 📄 Full conference kit:\n🔗 https://aihealth.scholarvault.in\n\n{The brochure PDF is available on the website|Download the brochure from the site}.\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'okay', reply: `{Perfect|Wonderful}! 😊 Whenever you're ready:\n🔗 https://aihealth.scholarvault.in\n\n{We're here if you have questions|Just ask anytime}!\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'ok', reply: `{Great|Perfect}! 😊 Visit: https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'thank', reply: `{You're most welcome|It's our pleasure|Anytime}! 😊\n\n{Feel free to reach out anytime|We're always here}.\n🌐 www.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'sure', reply: `{Wonderful|Great}! 😊 Here's the link to get started:\n🔗 https://aihealth.scholarvault.in\n\n{Reach out if you need help|We're here anytime}!\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ CONFERENCE DETAILS ══
    { trigger: 'price', reply: `{Great question|Happy to help}! 💰 *AIHealth 2025 Fees:*\n\n• 🎓 Students: ₹2,500\n• 👨‍🏫 Faculty: ₹3,500\n• 💼 Industry: ₹4,500\n• 🌍 International: $75 USD\n\n✅ Includes Certificate, Kit, Lunch & Networking!\n🔗 https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'fee', reply: `💰 *AIHealth 2025 Registration Fees:*\n\n• 🎓 Students: ₹2,500\n• 👨‍🏫 Faculty: ₹3,500\n• 💼 Industry: ₹4,500\n• 🌍 International: $75 USD\n\n✅ Includes Certificate, Kit & Networking\n🔗 https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'date', reply: `📅 *Conference Date: July 18–19, 2025*\n📍 Chennai, Tamil Nadu, India\n🔗 https://aihealth.scholarvault.in\n\n{Save the date|Mark your calendar}! 📌\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'when', reply: `📅 *AIHealth 2025: July 18–19, 2025*\n📍 Chennai, Tamil Nadu, India\n🔗 https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },

    // ══ HOW TO REGISTER (specific, must be before 'register') ══
    { trigger: 'how to register', reply: `{Sure|Happy to help}! Here's how to register for *AIHealth 2025* 📝\n\n*Step 1:* Visit → https://aihealth.scholarvault.in\n*Step 2:* Click "Register Now"\n*Step 3:* Fill your details (Name, Institute, Email)\n*Step 4:* Complete payment & download confirmation ✅\n\n{Takes less than 5 minutes|Super quick process}!\n\nNeed help at any step? Just reply!\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ MORE DETAILS (specific) ══
    { trigger: 'more details', reply: `{Sure thing|Absolutely}! Here's everything about *AIHealth 2025* 📋\n\n💡 *Topics:*\n• AI & ML in Diagnostics\n• Drug Discovery with Deep Learning\n• Digital Health & Telemedicine\n• Ethics & Governance in AI\n• Clinical Decision Support Systems\n\n🏅 *Organised by ScholarVault* | ✅ Startup India Recognized\n📅 July 18–19, 2025 | Chennai, India\n🔗 https://aihealth.scholarvault.in\n\nAny specific questions? {I'm here|Just ask}!\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ WHO ARE YOU (specific) ══
    { trigger: 'who are you', reply: `{Hello|Hi}! 👋 We are *ScholarVault* — India's leading academic conference platform.\n\n🏅 Startup India Recognized (DPIIT Certified)\n🌍 10,000+ researchers across 30+ countries\n🔒 92/100 Trust & Safety Score\n\nWe invited you to *AIHealth 2025* (July 18–19, Chennai).\n🔗 https://www.scholarvault.in\n\n{Any questions?|Happy to help!}\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'who is this', reply: `{Hi|Hello}! 👋 This is *ScholarVault* — India's leading academic conference organiser.\n\n🏅 Startup India Recognized | 92/100 Trust Score\n🎓 Organising *AIHealth 2025* — July 18–19, Chennai\n🔗 https://www.scholarvault.in\n\n{Any questions?|What would you like to know?}\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ HOW DID YOU GET MY NUMBER ══
    { trigger: 'how did you get my number', reply: `{Completely understand|That's a valid question}! 🙏\n\nYour number is part of our academic research network — compiled from conference registrations and academic institution partnerships.\n\nWe comply with WhatsApp's messaging guidelines. Reply *STOP* anytime to be removed immediately.\n\n{Sorry if this was unexpected|We apologize for any inconvenience}.\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'how do you know', reply: `{Totally fair to ask|Completely understand}! 🙏\n\nYour contact is part of our verified academic research network. Reply *STOP* to be removed immediately from all future messages.\n\n{We respect your privacy|We apologize for any inconvenience}.\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ WHAT IS SCHOLARVAULT ══
    { trigger: 'what is scholarvault', reply: `{Great question|Happy to explain}! 🌟\n\n*ScholarVault* — India's most trusted academic conference platform.\n\n🎯 *What we do:*\n• International research conferences\n• Scopus-indexed paper publication\n• AI-powered paper matching & peer review\n• Connecting researchers globally\n\n🏅 Startup India Recognized (DPIIT)\n🌍 10,000+ researchers | 30+ countries | 🔒 92/100 Trust Score\n\n🔗 https://www.scholarvault.in\n\n{Want to know about our conferences?|Shall I share upcoming events?}\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ GENERAL INTEREST & POSITIVE ══
    { trigger: 'interested', reply: `{Fantastic|Brilliant}! 🌟 Since you're interested:\n\n📌 *AIHealth 2025* — AI in Healthcare Conference\n📅 July 18–19, 2025 | Chennai, India\n\n✅ *You get:*\n• Scopus-indexed paper publication\n• Certificate of Participation\n• Networking with 200+ researchers from 15+ countries\n\n🔗 Register: https://aihealth.scholarvault.in\n\n{Shall I share registration steps?|Would you like the brochure?} Just say the word!\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'yes', reply: `{Great to hear|Wonderful|Excellent}! 🎉\n\n*AIHealth 2025* Full Details:\n📅 July 18–19, 2025\n📍 Chennai, Tamil Nadu, India\n🔗 Register: https://aihealth.scholarvault.in\n\n{We'd love to see you there|Looking forward to having you}! Any questions? {Just ask|We're here}.\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'register', reply: `{Sure|Great choice}! 🎉 Register here:\n🔗 https://aihealth.scholarvault.in\n\n📅 *AIHealth 2025* | July 18–19, 2025 | Chennai\n\n{Takes just 5 minutes|Quick and easy}! Reply if you face any issue.\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'send brochure', reply: `{Sure|Absolutely}! 📄 Full conference kit:\n🔗 https://aihealth.scholarvault.in\n\n{The brochure PDF is available on the website|Download the brochure from the site}.\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'okay', reply: `{Perfect|Wonderful}! 😊 Whenever you're ready:\n🔗 https://aihealth.scholarvault.in\n\n{We're here if you have questions|Just ask anytime}!\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'ok', reply: `{Great|Perfect}! 😊 Visit: https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'thank', reply: `{You're most welcome|It's our pleasure|Anytime}! 😊\n\n{Feel free to reach out anytime|We're always here}.\n🌐 www.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'sure', reply: `{Wonderful|Great}! 😊 Here's the link to get started:\n🔗 https://aihealth.scholarvault.in\n\n{Reach out if you need help|We're here anytime}!\n\n— ScholarVault Team`, delayMinutes: 1 },
    // ══ CONFERENCE DETAILS ══
    { trigger: 'price', reply: `{Great question|Happy to help}! 💰 *AIHealth 2025 Fees:*\n\n• 🎓 Students: ₹2,500\n• 👨‍🏫 Faculty: ₹3,500\n• 💼 Industry: ₹4,500\n• 🌍 International: $75 USD\n\n✅ Includes Certificate, Kit, Lunch & Networking!\n🔗 https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'fee', reply: `💰 *AIHealth 2025 Registration Fees:*\n\n• 🎓 Students: ₹2,500\n• 👨‍🏫 Faculty: ₹3,500\n• 💼 Industry: ₹4,500\n• 🌍 International: $75 USD\n\n✅ Includes Certificate, Kit & Networking\n🔗 https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'date', reply: `📅 *Conference Date: July 18–19, 2025*\n📍 Chennai, Tamil Nadu, India\n🔗 https://aihealth.scholarvault.in\n\n{Save the date|Mark your calendar}! 📌\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'when', reply: `📅 *AIHealth 2025: July 18–19, 2025*\n📍 Chennai, Tamil Nadu, India\n🔗 https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'venue', reply: `📍 *AIHealth 2025 Venue:* Chennai, Tamil Nadu, India\n(Exact address shared upon registration)\n\n✈️ Well-connected by Air, Rail & Road.\n🏨 Partner hotels at special rates.\n🔗 https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'certificate', reply: `🏆 *AIHealth 2025 Certificates:*\n\n📜 Certificate of Participation — all attendees\n📜 Certificate of Presentation — paper presenters\n📜 Best Paper Award — top-ranked papers\n\n✅ Digitally signed & verifiable online.\n🔗 https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'scopus', reply: `📚 *Publication Details:*\n\n✅ Scopus-Indexed publication for selected papers\n✅ Double-blind peer review\n✅ Extended versions eligible for SCI journals\n\n📝 https://aihealth.scholarvault.in\n\n{Submit early for priority review}!\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'deadline', reply: `⏳ *Key Deadlines — AIHealth 2025:*\n\n📝 Abstract & Full Paper: Visit website\n✅ Registration Deadline: *July 10, 2025*\n\n🔗 https://aihealth.scholarvault.in\n\n⚠️ {Don't wait till the last minute|Submit early for priority review}!\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'online', reply: `🌐 *AIHealth 2025 — Event Format:*\n\n✅ *In-Person Mode* — Chennai, India\n✅ *Virtual Mode* — Live-streamed\n\n{Both modes get the same certificate|All participants receive equal recognition}!\n🔗 https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'contact', reply: `📞 *ScholarVault Contact:*\n\n📱 WhatsApp/Phone: +91-86101-00624\n📧 Email: info@scholarvault.in\n🌐 Website: https://www.scholarvault.in\n\n⏰ Mon–Sat, 9 AM – 6 PM IST\n\n— ScholarVault Team`, delayMinutes: 0 },
    // ══ NEGATIVE / NOT INTERESTED ══
    { trigger: 'not interested', reply: `{Absolutely no problem|That's completely fine}! 🙏\n\n{No worries at all|We completely respect that}. Reply *STOP* to be removed from our list.\n\n{Wishing you all the best|Have a wonderful day}!\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'no thanks', reply: `{Absolutely fine|No problem at all}! 😊 {We respect your decision|No worries}.\n\nReply *STOP* to be removed. {Have a great day|Take care}!\n\n— ScholarVault Team`, delayMinutes: 1 },
    { trigger: 'busy', reply: `{No problem|Completely understood}! 😊 Our conference is on *July 18–19, 2025* — {plenty of time to plan|well in advance}.\n\n{Whenever you're free, we're here|No rush}!\n🔗 https://aihealth.scholarvault.in\n\n— ScholarVault Team`, delayMinutes: 2 },
    { trigger: 'wrong number', reply: `{Apologies for the confusion|So sorry}! 🙏 Reply *STOP* and you'll never hear from us again.\n\n{Once again, sincere apologies|Sorry for the trouble}.\n\n— ScholarVault Team`, delayMinutes: 0 },
    // ══ SPAM / SCAM / FAKE ══
    { trigger: 'spam', reply: `{We sincerely apologize|We understand}! 🙏\n\nWe are *ScholarVault* — Startup India Recognized (DPIIT).\n🔗 https://www.scholarvault.in | 📞 +91-86101-00624\n\nReply *STOP* to be removed immediately.\n\n— ScholarVault Team`, delayMinutes: 0 },
    { trigger: 'scam', reply: `{We understand your concern|That's a fair reaction}! 🙏\n\n*ScholarVault*: ✅ DPIIT Certified | ✅ 92/100 Trust Score | ✅ Active since 2022\n🔗 https://www.scholarvault.in | 📞 +91-86101-00624\n\nReply *STOP* to opt out.\n\n— ScholarVault Team`, delayMinutes: 0 },
    { trigger: 'fake', reply: `{We take this seriously|We understand}! 🙏\n\n*ScholarVault*: ✅ Startup India Recognized | ✅ 10,000+ researchers | ✅ 92/100 Trust Score\n🔗 https://www.scholarvault.in | 📞 +91-86101-00624\n\nReply *STOP* to be removed.\n\n— ScholarVault Team`, delayMinutes: 0 },
    // ══ ABUSIVE / LEAVE ALONE ══
    { trigger: 'leave me alone', reply: `{Of course, we sincerely apologize|Absolutely, so sorry}! 🙏 Reply *STOP* to confirm removal.\n\n{Have a peaceful day|Take care}.\n\n— ScholarVault Team`, delayMinutes: 0 }
];

// Load persistent auto-reply rules from DB, fall back to defaults
let autoReplyRules = (() => {
    try {
        const file = path.join(DB_DIR, 'auto_replies.json');
        if (fs.existsSync(file)) {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Array.isArray(saved) && saved.length > 0) return saved;
        }
    } catch(e) {}
    // First run: persist defaults so user can edit them from UI
    fs.writeFileSync(path.join(DB_DIR, 'auto_replies.json'), JSON.stringify(DEFAULT_AUTO_REPLY_RULES, null, 2));
    return DEFAULT_AUTO_REPLY_RULES;
})();

let evolutionProcess = null;

// --- Core Helper Engines ---
function parseSpintax(text) {
    if (!text) return text;
    let parsed = text;
    let matches;
    const regex = /\{([^{}]*)\}/g;
    while ((matches = regex.exec(parsed)) !== null) {
        const options = matches[1].split('|');
        const randomOption = options[Math.floor(Math.random() * options.length)];
        parsed = parsed.substring(0, matches.index) + randomOption + parsed.substring(matches.index + matches[0].length);
        regex.lastIndex = 0; // reset to check for other brackets
    }
    return parsed;
}

// AI may answer only genuinely new inbound activity. Old webhook replays and
// messages sent from the linked WhatsApp mobile app must never restart a bot
// conversation behind an operator's back.
const AI_INBOUND_FRESHNESS_MS = 2 * 60 * 1000;
const MANUAL_HANDOFF_WINDOW_MS = 30 * 60 * 1000;
const RECEIPT_RANK = { ERROR: 0, PENDING: 1, SENT: 2, DELIVERED: 3, READ: 4, PLAYED: 5 };
function normalizeEvolutionReceipt(value) {
    const numeric = { 0: 'ERROR', 1: 'PENDING', 2: 'SENT', 3: 'DELIVERED', 4: 'READ', 5: 'PLAYED' };
    if (Object.prototype.hasOwnProperty.call(numeric, value)) return numeric[value];
    const label = String(value || '').toUpperCase();
    return ({ SERVER_ACK: 'SENT', DELIVERY_ACK: 'DELIVERED', READ: 'READ', PLAYED: 'PLAYED', PENDING: 'PENDING', ERROR: 'ERROR' }[label] || 'PENDING');
}
function strongestEvolutionReceipt(updates) {
    const values = Array.isArray(updates) ? updates : [updates];
    return values.map(item => normalizeEvolutionReceipt(item?.status ?? item)).reduce((best, value) => (RECEIPT_RANK[value] > RECEIPT_RANK[best] ? value : best), 'PENDING');
}

// Restore the last selected Master AI state after a server restart.
const persistedAiSettings = getDb('settings_ai');
globalAiPaused = persistedAiSettings.globalAiPaused === true;

function getSentiment(text) {
    const lower = text.toLowerCase();
    const positive = ['interested', 'price', 'fee', 'how to join', 'registration', 'yes', 'sure', 'ok', 'good', 'great', 'nice'];
    const negative = ['stop', 'unsubscribe', 'remove', 'fraud', 'fake', 'scam', 'don\'t message', 'never', 'wrong number', 'bad'];
    const urgent = ['call me', 'emergency', 'urgent', 'why', 'help', 'now'];

    if (urgent.some(kw => lower.includes(kw))) return 'Urgent';
    if (negative.some(kw => lower.includes(kw))) return 'Negative';
    if (positive.some(kw => lower.includes(kw))) return 'Positive';
    return 'Neutral';
}

async function sendSmartMessageCore(remoteJid, instanceName, textReply, apiKey, buttonsArr, skipDelay = false, senderType = 'bot', pollQuestion = '') {
    // This is the final safety gate for every automated message. It protects
    // delayed callbacks that were scheduled before the Master AI switch was
    // paused. Manual agent replies and explicit campaigns use other types.
    if (globalAiPaused && AUTOMATED_SENDER_TYPES.has(senderType)) {
        console.log(`[Master AI Pause] Blocked automated send to ${remoteJid}`);
        logAutomationAudit(senderType, remoteJid, 'blocked', { reason: 'Master AI is paused' });
        return { success: false, reason: 'Master AI is paused' };
    }
    const blacklist = getDb('blacklist');
    // Normalize JID if needed
    const normalizedJid = remoteJid.includes('@') ? remoteJid : `${remoteJid}@s.whatsapp.net`;
    
    if (blacklist.includes(normalizedJid)) {
        console.log(`[Safety Guard] Blocked sending to Blacklisted number: ${normalizedJid}`);
        return { success: false, reason: 'Blacklisted number' };
    }
    
    const finalMessage = parseSpintax(textReply);
    
    const EVO_API_URL = (process.env.EVO_API_URL || 'http://localhost:8080');
    const key = apiKey || (process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!'); 

    try {
        if (!skipDelay) {
            console.log(`[Sender] Simulating typing for ${normalizedJid}...`);
            try {
                await axios.post(`${EVO_API_URL}/chat/sendPresence/${instanceName}`, {
                    number: normalizedJid,
                    delay: 3000,
                    presence: 'composing'
                }, { headers: { 'apikey': key } });
            } catch (err) {
                console.error(`[Sender] Failed presence post:`, err.message);
            }
            
            await new Promise(r => setTimeout(r, 4000));
        }

        // The pause may have changed while typing was simulated. Check again
        // immediately before any automated message reaches Evolution.
        if (globalAiPaused && AUTOMATED_SENDER_TYPES.has(senderType)) {
            logAutomationAudit(senderType, normalizedJid, 'blocked', { reason: 'Master AI paused during delay' });
            return { success: false, reason: 'Master AI is paused' };
        }

        let sendRes;
        if (buttonsArr && buttonsArr.length > 0) {
            // If pollQuestion is provided AND we have a message, send the text body first, then the poll!
            if (pollQuestion && finalMessage) {
                console.log(`[Sender] Dispatching TEXT body before POLL to ${normalizedJid}...`);
                await axios.post(`${EVO_API_URL}/message/sendText/${instanceName}`, {
                    number: normalizedJid,
                    text: finalMessage
                }, { headers: { 'apikey': key } });
                
                await new Promise(r => setTimeout(r, 1000)); // Small delay between messages
            }

            console.log(`[Sender] Dispatching POLL message to ${normalizedJid}...`);
            sendRes = await axios.post(`${EVO_API_URL}/message/sendPoll/${instanceName}`, {
                number: normalizedJid,
                name: pollQuestion || finalMessage,
                selectableCount: 1,
                values: buttonsArr.map(b => {
                    const str = String(b).trim();
                    if (str.includes('|')) {
                        return str.split('|', 2)[0].trim().substring(0, 30);
                    }
                    return str.substring(0, 30);
                })
            }, { headers: { 'apikey': key } });
        } else {
            console.log(`[Sender] Dispatching TEXT message to ${normalizedJid}...`);
            sendRes = await axios.post(`${EVO_API_URL}/message/sendText/${instanceName}`, {
                number: normalizedJid,
                text: finalMessage
            }, { headers: { 'apikey': key } });
        }
        
        const messageId = sendRes?.data?.key?.id || sendRes?.data?.message?.key?.id || null;

        // Track reply for SLA
        let contacts = getDb('contacts');
        if (contacts[normalizedJid]) {
            contacts[normalizedJid].lastRepliedAt = new Date().toISOString();
            contacts[normalizedJid].slaBreach = false;
            saveDb('contacts', contacts);
        }

        // Track the outbound message in conversations database (ignore system admin alerts)
        if (normalizedJid && !finalMessage.includes("🚨 URGENT:")) {
            const sentAt = new Date().toISOString();
            upsertThreadMessage(normalizedJid, {
                id: messageId,
                fromMe: true,
                direction: 'out',
                text: finalMessage || (pollQuestion ? `Poll: ${pollQuestion}` : ''),
                messageType: buttonsArr && buttonsArr.length > 0 ? 'poll' : 'text',
                pollQuestion: pollQuestion || null,
                pollOptions: buttonsArr && buttonsArr.length > 0 ? buttonsArr : null,
                senderType: senderType,
                status: 'PENDING',
                timestamp: sentAt
            });
            upsertConversationIndex({ jid: normalizedJid, message: finalMessage || `Poll: ${pollQuestion}`, timestamp: sentAt, sentiment: 'Neutral' });
        }
        if (AUTOMATED_SENDER_TYPES.has(senderType)) logAutomationAudit(senderType, normalizedJid, 'sent', { messageId });
        return { success: true, messageId };
    } catch (error) {
        let reason = error?.response?.data?.message?.[0]?.error || error?.response?.data?.error || error?.response?.data?.message || error.message || 'Unknown error';
        if (Array.isArray(reason)) reason = JSON.stringify(reason);
        console.error(`[Sender] Failed to send:`, error?.response?.data || error.message);
        return { success: false, reason: typeof reason === 'string' ? reason : JSON.stringify(reason) };
    }
}

async function sendSmartMessage(remoteJid, instanceName, textReply, apiKey, buttonsArr, skipDelay = false, senderType = 'bot') {
    const result = await sendSmartMessageCore(remoteJid, instanceName, textReply, apiKey, buttonsArr, skipDelay, senderType);
    return result.success;
}

// Send an image media message with a caption via Evolution API
async function sendMediaMessageCore(remoteJid, instanceName, base64Data, caption, fileName, apiKey, skipDelay = false, senderType = 'bot') {
    if (globalAiPaused && AUTOMATED_SENDER_TYPES.has(senderType)) {
        console.log(`[Master AI Pause] Blocked automated media send to ${remoteJid}`);
        logAutomationAudit(senderType, normalizeJid(remoteJid), 'blocked', { reason: 'master_ai_paused', kind: 'media' });
        return { success: false, reason: 'Master AI is paused' };
    }
    const blacklist = getDb('blacklist');
    const normalizedJid = remoteJid.includes('@') ? remoteJid : `${remoteJid}@s.whatsapp.net`;
    
    if (blacklist.includes(normalizedJid)) {
        console.log(`[Safety Guard] Blocked media send to Blacklisted number: ${normalizedJid}`);
        return { success: false, reason: 'Blacklisted number' };
    }

    const finalCaption = parseSpintax(caption || '');
    const EVO_API_URL = (process.env.EVO_API_URL || 'http://localhost:8080');
    const key = apiKey || (process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!');

    try {
        if (!skipDelay) {
            console.log(`[Sender] Simulating typing for ${normalizedJid} (media)...`);
            try {
                await axios.post(`${EVO_API_URL}/chat/sendPresence/${instanceName}`, {
                    number: normalizedJid,
                    delay: 3000,
                    presence: 'composing'
                }, { headers: { 'apikey': key } });
            } catch (err) {
                console.error(`[Sender] Failed presence post:`, err.message);
            }
            await new Promise(r => setTimeout(r, 4000));
            if (globalAiPaused && AUTOMATED_SENDER_TYPES.has(senderType)) {
                logAutomationAudit(senderType, normalizedJid, 'blocked', { reason: 'master_ai_paused_after_delay', kind: 'media' });
                return { success: false, reason: 'Master AI was paused before media was sent' };
            }
        }

        // Browser composers retain files as data URLs. Evolution accepts the
        // raw base64 payload (or an https URL), never the data:image/... prefix.
        const normalizedMedia = String(base64Data || '').startsWith('data:')
            ? String(base64Data).split(';base64,').pop()
            : base64Data;
        if (!normalizedMedia || typeof normalizedMedia !== 'string') {
            return { success: false, reason: 'Attachment has no usable media payload' };
        }

        console.log(`[Sender] Dispatching MEDIA message to ${normalizedJid} (${fileName})...`);
        const isPdf = (fileName || '').toLowerCase().endsWith('.pdf');
        const mediatype = isPdf ? 'document' : 'image';

        const evoResponse = await axios.post(`${EVO_API_URL}/message/sendMedia/${instanceName}`, {
            number: normalizedJid,
            media: normalizedMedia,
            mediatype: mediatype,
            fileName: fileName || 'campaign_poster.png',
            caption: finalCaption
        }, { headers: { 'apikey': key } });

        const apiSuccess = !!evoResponse.data;
        const messageId = evoResponse?.data?.key?.id || evoResponse?.data?.message?.key?.id || null;

        if (apiSuccess) {
            // Save file locally for conversation thread display
            const uploadsDir = path.join(__dirname, 'uploads');
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
            const cleanFileName = (fileName || 'campaign_poster.png').replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const savedFileName = `${Date.now()}-${cleanFileName}`;
            const localFilePath = path.join(uploadsDir, savedFileName);
            const rawMedia = normalizedMedia;
            fs.writeFileSync(localFilePath, Buffer.from(rawMedia, 'base64'));
            const relativeUrl = `/uploads/${savedFileName}`;

            // Track outbound media in conversations
            upsertThreadMessage(normalizedJid, {
                id: messageId,
                fromMe: true,
                direction: 'out',
                text: finalCaption || `Sent image: ${fileName || cleanFileName}`,
                mediaUrl: relativeUrl,
                mediaType: mediatype,
                fileName: fileName || cleanFileName,
                senderType: senderType,
                timestamp: new Date().toISOString()
            });
            upsertConversationIndex({ jid: normalizedJid, message: finalCaption || `Sent image: ${fileName || cleanFileName}`, timestamp: new Date().toISOString(), direction: 'out' });
            if (AUTOMATED_SENDER_TYPES.has(senderType)) logAutomationAudit(senderType, normalizedJid, 'sent', { kind: 'media', messageId });

            // Track reply for SLA
            let contacts = getDb('contacts');
            if (contacts[normalizedJid]) {
                contacts[normalizedJid].lastRepliedAt = new Date().toISOString();
                contacts[normalizedJid].slaBreach = false;
                saveDb('contacts', contacts);
            }
        }

        return { success: apiSuccess, reason: apiSuccess ? null : 'Evolution API rejected media send' };
    } catch (error) {
        let reason = error?.response?.data?.message?.[0]?.error || error?.response?.data?.error || error?.response?.data?.message || error.message || 'Unknown error';
        if (Array.isArray(reason)) reason = JSON.stringify(reason);
        console.error(`[Sender] Failed to send media:`, error?.response?.data || error.message);
        return { success: false, reason: typeof reason === 'string' ? reason : JSON.stringify(reason) };
    }
}

async function sendMediaMessage(remoteJid, instanceName, base64Data, caption, fileName, apiKey, skipDelay = false, senderType = 'bot') {
    const result = await sendMediaMessageCore(remoteJid, instanceName, base64Data, caption, fileName, apiKey, skipDelay, senderType);
    return result.success;
}

// --- API Endpoints: Core Features ---

// Verify if numbers exist on WhatsApp
app.post('/api/contacts/verify-numbers', async (req, res) => {
    try {
        const { numbers, instance } = req.body;
        if (!numbers || !Array.isArray(numbers)) return res.status(400).json({ error: 'Valid numbers array is required' });

        const EVO_API_URL = process.env.EVO_API_URL || 'http://localhost:8080';
        const EVO_API_KEY = process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!';
        const instanceName = instance || getDefaultInstanceName();
        if (!instanceName) return res.status(400).json({ error: 'No active WhatsApp instance available' });

        const response = await axios.post(`${EVO_API_URL}/chat/whatsappNumbers/${instanceName}`, {
            numbers: numbers
        }, { headers: { 'apikey': EVO_API_KEY } });

        res.json({ success: true, results: response.data });
    } catch (error) {
        console.error('[Verify] Error verifying numbers:', error?.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to verify numbers with Evolution API' });
    }
});

app.post('/api/start-evolution', async (req, res) => {
    try {
        const body = req.body || {};
        let instances = getDb('instances');
        if (!Array.isArray(instances)) instances = [];
        const saved = instances.find(item => item.name === body.name) || instances.find(item => item.isDefault) || instances[0];
        const evoUrl = String(body.apiUrl || saved?.apiUrl || process.env.EVO_API_URL || 'http://localhost:8080').replace(/\/$/, '');
        const evoKey = String(body.apiKey || saved?.apiKey || process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!');
        const instanceName = String(body.name || saved?.name || 'ScholarVault').trim();
        if (!instanceName || !evoUrl || !evoKey) return res.status(400).json({ success: false, message: 'Instance name, API URL and API key are required.' });

        const existingIndex = instances.findIndex(item => item.name === instanceName);
        const storedInstance = { ...(existingIndex >= 0 ? instances[existingIndex] : {}), name: instanceName, apiUrl: evoUrl, apiKey: evoKey, addedAt: existingIndex >= 0 ? instances[existingIndex].addedAt : new Date().toISOString(), isDefault: existingIndex >= 0 ? Boolean(instances[existingIndex].isDefault) : instances.length === 0 };
        if (existingIndex >= 0) instances[existingIndex] = storedInstance; else instances.push(storedInstance);
        saveDb('instances', instances);
        
        console.log(`[Cloud Init] Requesting WhatsApp QR Code from ${evoUrl}...`);
        
        // Try to create the instance
        let response = await axios.post(`${evoUrl}/instance/create`, {
            instanceName: instanceName,
            qrcode: true,
            integration: "WHATSAPP-BAILEYS"
        }, {
            headers: { apikey: evoKey },
            validateStatus: () => true
        });

        // If it already exists, just fetch the connect endpoint
        if (response.status === 403 || response.status === 400 || response.data?.error) {
            console.log('[Cloud Init] Instance exists. Fetching connect QR...');
            response = await axios.get(`${evoUrl}/instance/connect/${instanceName}`, {
                headers: { apikey: evoKey },
                validateStatus: () => true
            });
        }

        const rawQr = response.data?.base64 || response.data?.qrcode?.base64 || response.data?.qrcode?.code || response.data?.code || '';
        const qrcode = rawQr && !String(rawQr).startsWith('data:') && !String(rawQr).startsWith('http') ? `data:image/png;base64,${rawQr}` : rawQr;
        if (qrcode) {
            return res.json({ success: true, instanceName, message: 'Scan the QR Code on your screen!', qrcode });
        } else {
            return res.json({ success: true, instanceName, message: 'Instance already connected or processing.', qrcode: null, state: response.data?.instance?.state || response.data?.state || 'processing' });
        }
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/health', async (req, res) => {
    try {
        const instances = getDb('instances');
        const defaultInstName = getDefaultInstanceName();
        let key = (process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!');
        let apiUrl = (process.env.EVO_API_URL || 'http://localhost:8080');
        if (Array.isArray(instances) && instances.length > 0) {
            const inst = instances.find(i => i.name === defaultInstName) || instances[0];
            key = inst.apiKey || key;
            apiUrl = inst.apiUrl || apiUrl;
        }
        const response = await axios.get(`${apiUrl}/instance/connectionState/${defaultInstName}`, { headers: { 'apikey': key } });
        res.json({ success: true, state: response.data?.instance?.state || 'unknown', details: response.data });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Offline', state: 'offline' });
    }
});

// Inbox APIs
app.get('/api/inbox', (req, res) => {
    const inbox = canonicalizeInboxRows(getDb('inbox'));
    const contacts = getDb('contacts');
    // Enrich messages with SLA status and session context escalated status
    const enrichedMessages = inbox.map(m => {
        const sessionContext = getSessionContext(m.jid);
        return {
            ...m,
            name: resolveContactIdentity(m.jid, contacts, [m.name, m.pushName]),
            escalated: sessionContext.escalated === true || m.escalated === true,
            slaBreach: contacts[m.jid]?.slaBreach || false,
            followUpDate: sessionContext.followUpDate || null,
            lastReceivedAt: contacts[m.jid]?.lastReceivedAt || null,
            profilePictureUrl: contacts[m.jid]?.profilePictureUrl || null
        };
    });
    res.json({ success: true, messages: enrichedMessages });
});

// Inspect duplicate/stale records before any repair. `apply: true` is a
// deliberate opt-in action; the CRM calls this endpoint in preview mode first.
app.post('/api/inbox/reconcile', (req, res) => {
    const apply = req.body?.apply === true;
    const contacts = getDb('contacts');
    const current = getDb('inbox');
    const canonical = canonicalizeInboxRows(current, contacts);
    const report = {
        before: current.length,
        after: canonical.length,
        removed: current.length - canonical.length,
        duplicates: current.length - new Set(current.map(row => normalizeJid(row.jid))).size,
        preview: canonical.map(row => ({ jid: row.jid, name: row.name, timestamp: row.lastMessageAt || row.timestamp, message: row.message }))
    };
    if (apply) {
        saveDb('inbox', canonical);
        if (typeof io !== 'undefined' && io) io.emit('messages_update');
    }
    res.json({ success: true, applied: apply, report });
});

// Explicit user-triggered refresh from Evolution. This is intentionally not
// called by page load: it updates local conversation indexes but never sends a
// WhatsApp message.
app.post('/api/inbox/sync', async (req, res) => {
    const result = await syncOfflineMessages();
    if (result?.success === false) return res.status(502).json(result);
    const messages = canonicalizeInboxRows(getDb('inbox'));
    res.json({ success: true, synced: result?.synced || 0, conversations: messages.length, messages });
});

app.delete('/api/inbox/:jid', async (req, res) => {
    const { jid } = req.params;
    if (!jid) return res.status(400).json({ success: false });
    let whatsappDeletionSupported = true;

    try {
        const EVO_API_URL = process.env.EVO_API_URL || 'http://localhost:8080';
        const instName = getDefaultInstanceName();
        const key = process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!';

        await axios.delete(`${EVO_API_URL}/chat/deleteChat/${instName}?number=${encodeURIComponent(jid)}`, { headers: { 'apikey': key } });
    } catch(e) {
        // Evolution API v2 does not expose a whole-chat deletion endpoint. A
        // missing route must not prevent the user from removing their CRM copy.
        if (e.response?.status === 404) {
            whatsappDeletionSupported = false;
            console.warn(`[Inbox] Evolution does not support whole-chat deletion for ${jid}; removing CRM history only.`);
        } else {
            return res.status(502).json({ success: false, message: `WhatsApp could not confirm chat deletion: ${e.response?.data?.message || e.message}` });
        }
    }
    
    // Remove from inbox.json
    let inbox = getDb('inbox');
    inbox = inbox.filter(m => m.jid !== jid);
    saveDb('inbox', inbox);
    
    // Remove from conversations.json (Clear chat history)
    let threads = getDb('conversations');
    delete threads[jid];
    saveDb('conversations', threads);
    
    // Optionally remove from session_contexts
    let sessionContexts = getDb('session_contexts');
    if (sessionContexts[jid]) {
        delete sessionContexts[jid];
        saveDb('session_contexts', sessionContexts);
    }

    res.json({ success: true, whatsappDeletionSupported });
});

// ===== DELETE SINGLE MESSAGE FOR EVERYONE =====
app.delete('/api/inbox/:jid/message/:msgId/everyone', async (req, res) => {
    const { jid, msgId } = req.params;
    if (!jid || !msgId) return res.status(400).json({ success: false });
    
    try {
        const EVO_API_URL = process.env.EVO_API_URL || 'http://localhost:8080';
        const instName = getDefaultInstanceName();
        const key = process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!';
        
        // Evolution API: Delete for Everyone
        await axios.delete(`${EVO_API_URL}/chat/deleteMessageForEveryone/${instName}`, {
            headers: { 'apikey': key },
            // Evolution API v2 expects the original Baileys key fields. Keep
            // number/messageId too for older installs that use those aliases.
            data: {
                remoteJid: jid,
                id: msgId,
                fromMe: true,
                key: { remoteJid: jid, id: msgId, fromMe: true },
                number: jid.replace(/@s\.whatsapp\.net$/i, ''),
                messageId: msgId
            }
        });
        
        // Also remove locally
        let threads = getDb('conversations');
        if (threads[jid]) {
            threads[jid] = threads[jid].filter(m => m.id !== msgId && m.messageId !== msgId);
            saveDb('conversations', threads);
            if (typeof io !== 'undefined' && io) io.emit('messages_update');
        }
        
        res.json({ success: true });
    } catch (e) {
        const detail = e.response?.data?.message || e.response?.data?.error || e.message || 'Evolution rejected the delete request';
        console.error('[Delete for everyone]', detail);
        res.status(e.response?.status || 502).json({ success: false, message: `WhatsApp could not delete this message for everyone: ${detail}` });
    }
});

// ===== DELETE SINGLE MESSAGE FOR ME (Local Only) =====
app.delete('/api/inbox/:jid/message/:msgId/me', async (req, res) => {
    const { jid, msgId } = req.params;
    if (!jid || !msgId) return res.status(400).json({ success: false });
    
    try {
        let threads = getDb('conversations');
        if (threads[jid]) {
            threads[jid] = threads[jid].filter(m => m.id !== msgId && m.messageId !== msgId);
            saveDb('conversations', threads);
            if (typeof io !== 'undefined' && io) io.emit('messages_update');
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// ===== EDIT MESSAGE =====
app.put('/api/inbox/:jid/message/:msgId', async (req, res) => {
    const { jid, msgId } = req.params;
    const { text } = req.body;
    if (!jid || !msgId || !text) return res.status(400).json({ success: false });
    
    try {
        // Just local update for edit in this phase unless Evo supports it natively well
        let threads = getDb('conversations');
        if (threads[jid]) {
            const m = threads[jid].find(m => m.id === msgId || m.messageId === msgId);
            if (m) {
                m.text = text;
                m.status = 'EDITED';
                saveDb('conversations', threads);
                if (typeof io !== 'undefined' && io) io.emit('messages_update');
            }
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/inbox-reply', async (req, res) => {
    const { jid, message, instance } = req.body;
    if (!jid || !message) return res.status(400).json({ success: false });
    const success = await sendSmartMessage(jid, instance || getDefaultInstanceName(), message, null, null, true, 'agent');
    res.json({ success });
});

// ==========================================
// SARVAM VOICE AGENT AUTOMATED WHATSAPP DESK
// ==========================================
app.post('/api/sarvam/send-brochure', async (req, res) => {
    try {
        const rawPhone = req.body?.phone || req.body?.user_identifier || req.body?.caller_id || req.body?.user_id;
        const callerName = req.body?.name || req.body?.caller_name || 'Professor / Researcher';
        
        if (!rawPhone) {
            console.warn('[Sarvam Voice AI] No phone number received in send-brochure request');
            return res.status(400).json({ success: false, error: 'Phone number is required' });
        }

        // Normalize phone number (strip non-digits, guarantee 91 country code for 10-digit Indian numbers)
        let cleanPhone = String(rawPhone).replace(/[^\d]/g, '');
        if (cleanPhone.length === 10) {
            cleanPhone = '91' + cleanPhone;
        }

        const targetJid = `${cleanPhone}@s.whatsapp.net`;
        console.log(`[Sarvam Voice AI] 🚀 Dispatched automated WhatsApp Brochure to ${targetJid} (${callerName})`);

        const brochureMessage = 
`Hello ${callerName}! 👋

Thank you for speaking with our *ScholarVault Academic Desk* helpline.

As requested during your call, here are the official details and materials for *SVRIAS 2026* (*ScholarVault Research Integrity & Academic Summit*):

📅 *Summit Date:* 14 November 2026 (100% Virtual Global Plenary via Zoom)
⚡ *Editorial Review:* Rapid 2–4 Working Days (Rolling Double-Blind Review)
🎓 *Abstract Intake:* 100% Free (₹0 Upfront)
🏆 *Student Grants:* 10 Full (100%) Registration Fee Waivers Available
📚 *Proceedings:* Registered ISBN (978-81-181597-0-4) + Permanent Zenodo DOI (CERN / OpenAIRE)

📌 *Quick Links & Portals:*
👉 *Submit Abstract / Call for Papers:* https://researchintegrity2026.scholarvault.in/submit-paper.html
👉 *Official Summit Portal:* https://researchintegrity2026.scholarvault.in/
👉 *Academic Intelligence Dashboard:* https://app.scholarvault.in/

*ScholarVault Helpline & Support Desk:*
📞 Helpline: 080 6426 1600
💬 WhatsApp: +91 93449 00624
📧 Email: conferences@scholarvault.in

Feel free to reply directly to this WhatsApp message if you have any questions regarding tracks, manuscript formatting, or the 100% Student Fee Waiver Grant!

— *Dr. Radhika & The ScholarVault Academic Team*
🌐 scholarvault.in`;

        const instance = getDefaultInstanceName();
        const success = await sendSmartMessage(targetJid, instance, brochureMessage, null, null, true, 'bot');

        return res.json({
            success: true,
            status: success ? 'sent' : 'queued',
            recipient: cleanPhone,
            message: 'Brochure and summit links dispatched to WhatsApp successfully'
        });
    } catch (err) {
        console.error('[Sarvam Voice AI] Error sending brochure:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Sarvam Post-Call Webhook logger
app.post('/api/sarvam/webhook', async (req, res) => {
    try {
        console.log('[Sarvam Call Webhook] Received call completion event:', JSON.stringify(req.body).slice(0, 300));
        res.json({ received: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// CRM Contacts APIs
app.get('/api/contacts', (req, res) => res.json({ success: true, contacts: getDb('contacts') }));

app.get('/api/contacts/:jid/identity', (req, res) => {
    const jid = normalizeJid(decodeURIComponent(req.params.jid));
    const contacts = getDb('contacts');
    const inbox = canonicalizeInboxRows(getDb('inbox'), contacts).find(row => row.jid === jid);
    const thread = getDb('conversations')[jid] || [];
    const names = [...new Set([contacts[jid]?.displayNameOverride, contacts[jid]?.name, inbox?.name, ...thread.map(item => item.name)].filter(Boolean))];
    res.json({ success: true, jid, resolvedName: resolveContactIdentity(jid, contacts, names), sources: names.map(name => ({ name, usable: isUsableContactName(name) })) });
});

app.post('/api/contacts/:jid/identity', (req, res) => {
    const jid = normalizeJid(decodeURIComponent(req.params.jid));
    const name = String(req.body?.name || '').trim();
    if (!isUsableContactName(name)) return res.status(400).json({ success: false, message: 'Enter a valid contact name' });
    const contacts = getDb('contacts');
    contacts[jid] = { ...(contacts[jid] || { jid }), displayNameOverride: name, name, nameConfirmed: true, identityUpdatedAt: new Date().toISOString() };
    saveDb('contacts', contacts);
    const inbox = canonicalizeInboxRows(getDb('inbox'), contacts);
    saveDb('inbox', inbox);
    if (typeof io !== 'undefined' && io) io.emit('messages_update');
    res.json({ success: true, contact: contacts[jid], resolvedName: name });
});

// --- Duplicate Contact Detection ---
app.get('/api/contacts/duplicates', (req, res) => {
    try {
        const contacts = getDb('contacts');
        const numberGroups = {};
        
        // Group by phone number
        for (const jid in contacts) {
            if (jid.includes('@g.us') || jid.includes('@lid')) continue;
            
            // Extract pure numbers
            const pureNumber = jid.split('@')[0].replace(/\D/g, '');
            if (pureNumber.length > 5) {
                if (!numberGroups[pureNumber]) numberGroups[pureNumber] = [];
                numberGroups[pureNumber].push(contacts[jid]);
            }
        }
        
        const duplicates = Object.values(numberGroups).filter(group => group.length > 1);
        res.json({ success: true, duplicates });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/contacts/merge', (req, res) => {
    try {
        const { primaryJid, duplicateJids } = req.body;
        if (!primaryJid || !duplicateJids || !Array.isArray(duplicateJids)) {
            return res.status(400).json({ success: false, message: 'Invalid payload' });
        }
        
        let contacts = getDb('contacts');
        let convos = getDb('conversations');
        let inbox = getDb('inbox');
        
        const primary = contacts[primaryJid];
        if (!primary) return res.status(404).json({ success: false, message: 'Primary contact not found' });
        
        for (const dupJid of duplicateJids) {
            if (dupJid === primaryJid) continue;
            const dupContact = contacts[dupJid];
            if (!dupContact) continue;
            
            // Merge tags
            if (dupContact.tags) {
                if (!primary.tags) primary.tags = [];
                dupContact.tags.forEach(t => {
                    if (!primary.tags.includes(t)) primary.tags.push(t);
                });
            }
            
            // Merge CRM fields if primary is empty
            ['institution', 'role', 'email', 'country'].forEach(field => {
                if (!primary[field] && dupContact[field]) primary[field] = dupContact[field];
            });
            
            // Merge conversations
            if (convos[dupJid]) {
                if (!convos[primaryJid]) convos[primaryJid] = [];
                convos[primaryJid] = [...convos[primaryJid], ...convos[dupJid]];
                
                // Sort by timestamp and remove duplicate message IDs
                convos[primaryJid].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
                const uniqueMsgs = [];
                const seenIds = new Set();
                convos[primaryJid].forEach(m => {
                    const id = m.id || m.messageId;
                    if (id && !seenIds.has(id)) {
                        seenIds.add(id);
                        uniqueMsgs.push(m);
                    }
                });
                convos[primaryJid] = uniqueMsgs;
                
                delete convos[dupJid];
            }
            
            // Remove duplicate from inbox
            inbox = inbox.filter(m => m.jid !== dupJid);
            
            // Delete duplicate contact
            delete contacts[dupJid];
        }
        
        saveDb('contacts', contacts);
        saveDb('conversations', convos);
        saveDb('inbox', inbox);
        
        res.json({ success: true, message: 'Contacts merged successfully' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// Bulk Upload Contacts
app.post('/api/contacts/bulk', (req, res) => {
    const { contacts: incomingContacts, mode } = req.body;
    // mode: 'replace', 'merge', 'ignore'
    let dbContacts = getDb('contacts');
    
    let addedCount = 0;
    let mergedCount = 0;
    let ignoredCount = 0;

    for (const [jid, incomingData] of Object.entries(incomingContacts)) {
        if (dbContacts[jid]) {
            if (mode === 'replace') {
                dbContacts[jid] = { ...dbContacts[jid], ...incomingData };
                mergedCount++;
            } else if (mode === 'merge') {
                dbContacts[jid].name = incomingData.name || dbContacts[jid].name;
                
                const currentTags = Array.isArray(dbContacts[jid].tags) ? dbContacts[jid].tags : [];
                const incomingTags = Array.isArray(incomingData.tags) ? incomingData.tags : (incomingData.group ? [incomingData.group] : []);
                
                dbContacts[jid].tags = [...new Set([...currentTags, ...incomingTags])];
                mergedCount++;
            } else {
                ignoredCount++; // 'ignore' mode
            }
        } else {
            // new contact
            dbContacts[jid] = {
                jid,
                name: incomingData.name,
                tags: incomingData.group ? [incomingData.group] : [],
                addedAt: new Date().toISOString(),
                leadStatus: 'New'
            };
            addedCount++;
        }
    }
    
    saveDb('contacts', dbContacts);
    res.json({ success: true, addedCount, mergedCount, ignoredCount });
});

app.post('/api/contacts', (req, res) => {
    saveDb('contacts', req.body.contacts);
    res.json({ success: true });
});

// Add a single contact
app.post('/api/contacts/add', (req, res) => {
    const { name, phone, tags, optIn } = req.body;
    if (!name || !phone) return res.status(400).json({ success: false, message: 'Name and phone are required' });

    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
    let contacts = getDb('contacts');
    if (contacts[jid]) return res.status(409).json({ success: false, message: 'Contact already exists', existingContact: contacts[jid], jid: jid });

    contacts[jid] = {
        jid,
        name,
        tags: Array.isArray(tags) ? tags : [],
        optIn: Boolean(optIn),
        optInUpdatedAt: new Date().toISOString(),
        addedAt: new Date().toISOString(),
        leadStatus: 'New'
    };
    saveDb('contacts', contacts);
    res.json({ success: true, jid });
});

// Edit an existing contact
app.put('/api/contacts/:jid', (req, res) => {
    const mode = req.body.mode || 'replace'; // 'replace' or 'merge'
    const jid = decodeURIComponent(req.params.jid);
    const { name, phone, tags } = req.body;
    let contacts = getDb('contacts');

    if (!contacts[jid]) return res.status(404).json({ success: false, message: 'Contact not found' });

    const newJid = phone ? phone.replace(/\D/g, '') + '@s.whatsapp.net' : jid;

    if (newJid !== jid) {
        // Phone number changed — migrate to new JID
        contacts[newJid] = { ...contacts[jid], jid: newJid };
        delete contacts[jid];
    }

    if (name !== undefined) contacts[newJid].name = name;
    if (tags !== undefined) {
        if (mode === 'merge') {
            const currentTags = Array.isArray(contacts[newJid].tags) ? contacts[newJid].tags : [];
            const newTags = Array.isArray(tags) ? tags : [];
            contacts[newJid].tags = [...new Set([...currentTags, ...newTags])];
        } else {
            contacts[newJid].tags = Array.isArray(tags) ? tags : [];
        }
    }

    saveDb('contacts', contacts);
    res.json({ success: true, jid: newJid });
});

app.delete('/api/contacts/:jid', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const contacts = getDb('contacts');
    if (!contacts[jid]) return res.status(404).json({ success: false, message: 'CRM contact not found' });
    delete contacts[jid];
    saveDb('contacts', contacts);
    res.json({ success: true, crmRecordDeleted: true, whatsappAddressBookChanged: false, message: 'CRM record removed. The phone contact and WhatsApp chat were not deleted.' });
});

// Blacklist APIs
app.get('/api/blacklist', (req, res) => res.json({ success: true, blacklist: getDb('blacklist') }));
app.post('/api/blacklist', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone required' });
    const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone.replace(/\D/g,'')}@s.whatsapp.net`;
    let blacklist = getDb('blacklist');
    if (!blacklist.includes(jid)) {
        blacklist.push(jid);
        saveDb('blacklist', blacklist);
    }
    res.json({ success: true, blacklist });
});
app.delete('/api/blacklist', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone required' });
    let blacklist = getDb('blacklist');
    blacklist = blacklist.filter(j => !j.startsWith(phone.replace(/\D/g,'')));
    saveDb('blacklist', blacklist);
    res.json({ success: true, blacklist });
});

// Hot Leads API
app.get('/api/hot-leads', (req, res) => res.json({ success: true, leads: getDb('hot_leads') }));
app.get('/api/hot-leads/csv', (req, res) => {
    const leads = getDb('hot_leads');
    let csv = 'Phone,Name,Keyword,Message,Timestamp\n';
    leads.forEach(l => {
        csv += `"${l.phone}","${l.name || ''}","${l.keyword || ''}","${(l.message||'').replace(/"/g,'""')}","${l.timestamp}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="hot_leads.csv"');
    res.send(csv);
});

// ─── AI Smart Responder API ───
app.get('/api/ai-settings', (req, res) => {
    const settings = getAISettings();
    // Mask API key for security
    const masked = { ...settings, apiKey: settings.apiKey ? '***' + settings.apiKey.slice(-6) : '' };
    res.json({ success: true, settings: masked });
});
app.post('/api/ai-settings', (req, res) => {
    const current = getAISettings();
    const updates = req.body || {};
    // Don't overwrite apiKey if masked value sent
    if (updates.apiKey && updates.apiKey.startsWith('***')) {
        updates.apiKey = current.apiKey;
    }
    const merged = { ...current, ...updates };
    saveDb('settings_ai', merged);
    res.json({ success: true, message: 'AI settings saved.' });
});
app.get('/api/ai-logs', (req, res) => {
    let logs = getDb('ai_replies');
    if (!Array.isArray(logs)) logs = [];
    res.json({ success: true, logs });
});
app.post('/api/ai-test', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.json({ success: false, error: 'No message provided' });
    try {
        const reply = await generateAIReply(message, 'test@test', 'Test User');
        if (reply) {
            res.json({ success: true, reply });
        } else {
            res.json({ success: false, error: 'AI returned no response. Check your API key and provider settings.' });
        }
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ─── AI Chat Summarizer ───
app.post('/api/ai/summarize', async (req, res) => {
    const { jid } = req.body;
    if (!jid) return res.json({ success: false, error: 'No JID provided' });

    try {
        const settings = getAISettings();
        if (!settings.enabled || !settings.apiKey) {
            return res.json({ success: false, error: 'AI is disabled or missing API key.' });
        }

        const threads = getDb('conversations');
        const history = threads[jid] || [];
        if (history.length === 0) {
            return res.json({ success: false, error: 'No conversation history to summarize.' });
        }

        // Get last 20 messages for context
        const recentHistory = history.slice(-20);
        const transcript = recentHistory.map(m => `[${m.direction === 'in' ? 'User' : 'Bot'}]: ${m.text}`).join('\n');

        const systemPrompt = "You are an AI assistant for ScholarVault. Read the following WhatsApp conversation transcript. Provide a concise, 3-bullet-point summary covering: 1) Who the user is (role/institution if known), 2) What they are asking for or want, 3) What action the human agent should take next. Do not include any intro/outro text, just the 3 bullet points starting with a dash.";

        const response = await axios.post(
            'https://api.mistral.ai/v1/chat/completions',
            {
                model: settings.model || 'open-mistral-nemo',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: transcript }
                ],
                temperature: 0.3,
                max_tokens: 300
            },
            {
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const summary = response.data?.choices?.[0]?.message?.content || null;
        if (summary) {
            res.json({ success: true, summary });
        } else {
            res.json({ success: false, error: 'AI returned an empty response.' });
        }
    } catch (err) {
        console.error('[AI Summarizer] Error:', err.response?.data || err.message);
        res.json({ success: false, error: 'Failed to generate summary: ' + err.message });
    }
});
app.get('/api/auto-replies', (req, res) => res.json({ success: true, rules: autoReplyRules }));
app.post('/api/auto-replies', (req, res) => {
    if (req.body && req.body.rules) {
        autoReplyRules = req.body.rules;
        // Persist so rules survive server restarts
        fs.writeFileSync(path.join(DB_DIR, 'auto_replies.json'), JSON.stringify(autoReplyRules, null, 2));
        return res.json({ success: true, message: 'Rules updated & saved.' });
    }
    return res.status(400).json({ success: false });
});

// Evolution has emitted reactions as both an upsert payload and a message update
// across versions. Keep the extraction deliberately tolerant so a mobile reaction
// updates the stored message regardless of its enclosing event shape.
function extractReactionMessage(payload) {
    const candidates = [
        payload?.reactionMessage,
        payload?.message?.reactionMessage,
        payload?.messages?.reactionMessage,
        payload?.update?.reactionMessage,
        payload?.update?.message?.reactionMessage,
        payload?.data?.reactionMessage,
        payload?.data?.message?.reactionMessage
    ];
    return candidates.find(item => item?.key?.id) || null;
}

function applyReactionToConversation(conversations, reactionMessage, fallbackJid) {
    if (!reactionMessage?.key?.id) return false;
    const reactedJid = normalizeJid(reactionMessage.key.remoteJid || fallbackJid);
    let targetThread = conversations[reactedJid] || [];
    let target = targetThread.find(item => (item.id || item.messageId) === reactionMessage.key.id);
    // Reactions often arrive with a device/LID remote JID, while the CRM thread
    // is stored under the phone JID. WhatsApp message IDs are unique enough here,
    // so recover the actual stored thread by ID before treating it as missing.
    if (!target) {
        for (const [threadJid, thread] of Object.entries(conversations)) {
            const candidate = (thread || []).find(item => (item.id || item.messageId) === reactionMessage.key.id);
            if (candidate) {
                target = candidate;
                targetThread = thread;
                break;
            }
        }
    }
    if (!target) {
        console.log(`[Reaction] Target ${reactionMessage.key.id} is not stored locally yet.`);
        return false;
    }
    const emoji = reactionMessage.text ?? reactionMessage.reaction ?? reactionMessage.emoji;
    if (emoji) target.reaction = emoji;
    else delete target.reaction;
    console.log(`[Reaction] Synced ${emoji || 'removed reaction'} for ${reactionMessage.key.id}`);
    return true;
}

// Native WhatsApp poll votes do not arrive as normal text messages. Evolution
// forwards a pollUpdateMessage (sometimes nested inside an array), so extract
// it independently and keep the poll card in sync with the linked phone.
function extractPollUpdates(payload) {
    const found = [];
    const seen = new Set();
    const visit = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return;
        seen.add(value);
        if (value.pollCreationMessageKey && (value.vote || value.selectedOptions || value.pollUpdates)) found.push(value);
        if (value.pollUpdateMessage) visit(value.pollUpdateMessage, depth + 1);
        if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
        else Object.values(value).forEach(item => visit(item, depth + 1));
    };
    visit(payload);
    return found;
}

function decodePollOption(option) {
    if (Buffer.isBuffer(option)) return option.toString('utf8');
    if (option && option.type === 'Buffer' && Array.isArray(option.data)) return Buffer.from(option.data).toString('utf8');
    if (option instanceof Uint8Array) return Buffer.from(option).toString('utf8');
    return String(option ?? '').trim();
}

function applyPollUpdateToConversation(conversations, pollUpdate, fallbackJid) {
    const pollKey = pollUpdate?.pollCreationMessageKey || pollUpdate?.key || {};
    const pollId = pollKey.id || pollUpdate?.pollId || pollUpdate?.messageId;
    const vote = pollUpdate?.vote || pollUpdate;
    const selectedOptions = vote?.selectedOptions || vote?.options || pollUpdate?.selectedOptions || [];
    const selections = (Array.isArray(selectedOptions) ? selectedOptions : [selectedOptions])
        .map(decodePollOption)
        .filter(Boolean);
    if (!pollId || !selections.length) return false;

    let target = null;
    for (const thread of Object.values(conversations)) {
        const candidate = (thread || []).find(item => (item.id || item.messageId) === pollId);
        if (candidate) { target = candidate; break; }
    }
    if (!target || !target.pollQuestion) {
        console.log(`[Poll] Target ${pollId} is not stored locally yet.`);
        return false;
    }

    const voter = normalizeJid(pollUpdate?.key?.participant || pollUpdate?.participant || pollUpdate?.senderJid || fallbackJid || 'unknown');
    const normalizedSelections = selections.map(selection => {
        const match = (target.pollOptions || []).find(option => String(option).trim().toLowerCase() === selection.trim().toLowerCase());
        return match || selection;
    });
    target.pollVoters = { ...(target.pollVoters || {}), [voter]: normalizedSelections };
    const voteCounts = {};
    Object.values(target.pollVoters).flat().forEach(selection => {
        voteCounts[selection] = Number(voteCounts[selection] || 0) + 1;
    });
    target.pollVotes = voteCounts;
    console.log(`[Poll] Synced ${normalizedSelections.join(', ')} for ${pollId}`);
    return true;
}

// --- Webhook Listener ---
app.post(['/webhook', '/webhook/:event'], async (req, res) => {
    res.status(200).send('OK'); // Acknowledge quickly
    const event = req.body || {};
    
    // Fallback: If event.event is not populated in the body, construct it from the URL parameter
    if (!event.event && req.params.event) {
        event.event = req.params.event.replace(/[-.]/g, '_').toUpperCase();
    }
    const eventName = String(event.event || '').replace(/[-.]/g, '_').toUpperCase();
    
    if (eventName === 'MESSAGES_UPDATE' && event.data) {
        try {
            const updates = Array.isArray(event.data) ? event.data : (event.data.messages ? event.data.messages : [event.data]);
            let modified = false;
            let convos = getDb('conversations');
            
            for (const update of updates) {
                const reactionMessage = extractReactionMessage(update);
                if (applyReactionToConversation(convos, reactionMessage, update.key?.remoteJid || update.remoteJid || update.jid)) {
                    modified = true;
                    continue;
                }
                const pollUpdates = extractPollUpdates(update);
                if (pollUpdates.some(pollUpdate => applyPollUpdateToConversation(convos, pollUpdate, update.key?.remoteJid || update.remoteJid || update.jid))) {
                    modified = true;
                    continue;
                }
                const rawStatus = update.update?.status ?? update.status ?? update.message?.status;
                // Evolution/Baileys commonly sends numeric receipts:
                // 1=PENDING, 2=SERVER_ACK (sent), 3=DELIVERY_ACK,
                // 4=READ, 5=PLAYED. Store a single stable UI contract.
                const status = normalizeEvolutionReceipt(rawStatus);
                const messageKey = update.key || update.update?.key || update.message?.key || {};
                const msgId = messageKey.id || update.id || update.messageId;
                const rawJid = messageKey.remoteJid || update.remoteJid || update.jid;
                const altJid = messageKey.remoteJidAlt || update.remoteJidAlt;
                if (rawJid && altJid) recordLidMapping(rawJid, altJid);
                const jid = resolveCanonicalJid(rawJid, altJid);
                
                if (status && msgId && jid && convos[jid]) {
                    const msgIndex = convos[jid].findIndex(m => (m.id === msgId || m.messageId === msgId));
                    if (msgIndex !== -1 && status) {
                        const oldStatus = normalizeEvolutionReceipt(convos[jid][msgIndex].status);
                        if (RECEIPT_RANK[status] >= RECEIPT_RANK[oldStatus]) {
                            convos[jid][msgIndex].status = status;
                            modified = true;
                        }
                    }
                }
            }
            
            if (modified) {
                saveDb('conversations', convos);
            }
            // Always notify the browser. It can refresh the active thread and
            // sidebar even when the message was not previously cached locally.
            if (typeof io !== 'undefined' && io) io.emit('messages_update', updates);
        } catch (err) {
            console.error('[Webhook Messages Update Error]', err.message);
        }
    } else if ((eventName === 'MESSAGES_UPSERT' || eventName === 'SEND_MESSAGE') && event.data) {
        try {
            const messageData = event.data;
            const messages = Array.isArray(messageData.messages) ? messageData.messages : [messageData];
            for (const msg of messages) {

            const senderJid = msg.key ? msg.key.remoteJid : null;
            if (!senderJid || senderJid === 'status@broadcast' || senderJid.includes('@g.us')) continue;
            
            const instanceName = event.instance;
            let incomingText = '';
            let mediatype = null;
            let fileName = null;
            let base64 = null;
            
            if (msg.message?.conversation) {
                incomingText = msg.message.conversation;
            } else if (msg.message?.extendedTextMessage?.text) {
                incomingText = msg.message.extendedTextMessage.text;
            } else if (msg.message?.imageMessage) {
                incomingText = msg.message.imageMessage.caption || '[Sent an Image]';
                mediatype = 'image';
                base64 = msg.message.imageMessage.base64 || null;
            } else if (msg.message?.documentMessage) {
                incomingText = msg.message.documentMessage.caption || `[Sent a Document: ${msg.message.documentMessage.title || 'file'}]`;
                mediatype = 'document';
                fileName = msg.message.documentMessage.title || 'document.pdf';
                base64 = msg.message.documentMessage.base64 || null;
            } else if (msg.message?.audioMessage) {
                incomingText = '[Sent an Audio Message]';
                mediatype = 'audio';
                base64 = msg.message.audioMessage.base64 || null;
            } else if (msg.message?.videoMessage) {
                incomingText = msg.message.videoMessage.caption || '[Sent a Video]';
                mediatype = 'video';
                base64 = msg.message.videoMessage.base64 || null;
            }
            const reactionMessage = extractReactionMessage(msg);
            if (reactionMessage?.key?.id) {
                const threads = getDb('conversations');
                if (applyReactionToConversation(threads, reactionMessage, senderJid)) {
                    saveDb('conversations', threads);
                    if (typeof io !== 'undefined' && io) io.emit('messages_update');
                }
                continue;
            }
            const pollUpdates = extractPollUpdates(msg);
            if (pollUpdates.length) {
                const threads = getDb('conversations');
                if (pollUpdates.some(pollUpdate => applyPollUpdateToConversation(threads, pollUpdate, senderJid))) {
                    saveDb('conversations', threads);
                    if (typeof io !== 'undefined' && io) io.emit('messages_update');
                }
                continue;
            }
            
            if (!incomingText) continue;
            const lowerText = incomingText.toLowerCase().trim();
            console.log(`[Inbox] ${senderJid}: "${incomingText}"`);

            // Fetch base64 data dynamically if not present in the webhook payload
            if (mediatype && !base64) {
                try {
                    console.log(`[Webhook Media Fetch] Fetching base64 media for message ${msg.key.id} from Evolution API...`);
                    const EVO_API_URL = (process.env.EVO_API_URL || 'http://localhost:8080');
                    const instName = instanceName || getDefaultInstanceName();
                    const key = (process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!');
                    
                    const fetchRes = await axios.post(`${EVO_API_URL}/chat/getBase64FromMediaMessage/${instName}`, {
                        message: {
                            key: msg.key
                        }
                    }, { headers: { 'apikey': key }, timeout: 10000 });
                    
                    if (fetchRes.data && fetchRes.data.base64) {
                        base64 = fetchRes.data.base64;
                    }
                } catch (fetchErr) {
                    console.error('[Webhook Media Fetch] Failed fetching base64 media:', fetchErr.message);
                }
            }

            // Save media locally if fetched/available
            let relativeUrl = null;
            if (base64) {
                try {
                    let base64Content = base64;
                    if (base64.startsWith('data:')) {
                        const parts = base64.split(';base64,');
                        base64Content = parts[1];
                    }
                    const buffer = Buffer.from(base64Content, 'base64');
                    
                    const uploadsDir = path.join(__dirname, 'uploads');
                    if (!fs.existsSync(uploadsDir)) {
                        fs.mkdirSync(uploadsDir, { recursive: true });
                    }
                    
                    const cleanFile = (fileName || (mediatype === 'image' ? 'photo.png' : 'document.pdf')).replace(/[^a-zA-Z0-9.\-_]/g, '_');
                    const savedFile = `in-${Date.now()}-${cleanFile}`;
                    const localPath = path.join(uploadsDir, savedFile);
                    
                    fs.writeFileSync(localPath, buffer);
                    relativeUrl = `/uploads/${savedFile}`;
                    console.log(`[Webhook Media Save] Saved incoming ${mediatype} to ${relativeUrl}`);
                } catch (saveErr) {
                    console.error('[Webhook Media Save] Failed saving incoming file:', saveErr.message);
                }
            }

            // --- Feature: SLA & Sentiment Analysis ---
            const sentiment = getSentiment(incomingText);
            
            // --- Feature: Live Inbox ---
            const remoteJidAlt = msg.key?.remoteJidAlt;
            if (senderJid && remoteJidAlt) recordLidMapping(senderJid, remoteJidAlt);
            const normalizedSenderJid = resolveCanonicalJid(senderJid, remoteJidAlt);
            let contacts = getDb('contacts');
            const sourceTimestamp = isoFromWhatsAppTimestamp(msg.messageTimestamp || msg.message?.messageTimestamp) || new Date().toISOString();
            const msgId = msg.key?.id || null;
            const fromMe = msg.key?.fromMe ?? false;
            const existingThread = getDb('conversations')[normalizedSenderJid] || [];
            const knownMessage = Boolean(msgId && existingThread.some(item => (item.id || item.messageId) === msgId));
            const resolvedName = resolveContactIdentity(normalizedSenderJid, contacts, [msg.pushName, msg.message?.extendedTextMessage?.contextInfo?.participantName]);
            upsertConversationIndex({
                jid: normalizedSenderJid,
                name: resolvedName,
                pushName: msg.pushName || null,
                message: incomingText,
                sentiment,
                timestamp: sourceTimestamp,
                lastMessageAt: sourceTimestamp
            }, contacts);

            // --- Feature: Contact Tracking (SLA) ---
            if (!contacts[normalizedSenderJid]) contacts[normalizedSenderJid] = { jid: normalizedSenderJid, name: resolvedName };
            
            contacts[normalizedSenderJid].lastReceivedAt = sourceTimestamp;
            contacts[normalizedSenderJid].sentiment = sentiment;
            contacts[normalizedSenderJid].slaBreach = false; // Reset on new message
            
            if (!contacts[normalizedSenderJid].leadStatus || contacts[normalizedSenderJid].leadStatus === 'Messaged') {
                contacts[normalizedSenderJid].leadStatus = 'Replied';
                contacts[normalizedSenderJid].statusUpdatedAt = sourceTimestamp;
            }
            saveDb('contacts', contacts);

            // --- Feature: Conversation Thread Storage ---
            // Some Evolution installs surface a poll response as the chosen
            // option text rather than a decoded poll-update object. Associate
            // that response with the newest matching poll so the CRM can show
            // the vote on the poll card instead of a misleading loose bubble.
            let pollResponseTo = null;
            if (!fromMe) {
                const conversations = getDb('conversations');
                const thread = Array.isArray(conversations[normalizedSenderJid]) ? conversations[normalizedSenderJid] : [];
                const selected = String(incomingText || '').trim().toLowerCase();
                const poll = [...thread].reverse().find(item => item.fromMe && item.pollQuestion && Array.isArray(item.pollOptions) && item.pollOptions.some(option => String(option).trim().toLowerCase() === selected));
                if (poll) {
                    const option = poll.pollOptions.find(value => String(value).trim().toLowerCase() === selected);
                    poll.pollVotes = { ...(poll.pollVotes || {}), [option]: Number(poll.pollVotes?.[option] || 0) + 1 };
                    pollResponseTo = poll.id || poll.messageId || 'poll';
                    conversations[normalizedSenderJid] = thread;
                    saveDb('conversations', conversations);
                }
            }

            const threadItem = { 
                id: msgId,
                fromMe: fromMe,
                direction: fromMe ? 'out' : 'in', 
                text: incomingText, 
                messageType: mediatype || (msg.message ? Object.keys(msg.message)[0] : 'text'),
                name: fromMe ? 'Me' : resolvedName,
                sentiment: sentiment, 
                status: fromMe ? 'PENDING' : null,
                timestamp: sourceTimestamp
            };
            if (pollResponseTo) threadItem.pollResponseTo = pollResponseTo;
            if (relativeUrl) {
                threadItem.mediaUrl = relativeUrl;
                threadItem.mediaType = mediatype;
                threadItem.fileName = fileName || (mediatype === 'image' ? 'photo.png' : 'document.pdf');
            }
            
            upsertThreadMessage(normalizedSenderJid, threadItem);

            // An outbound webhook which did not match a message generated by
            // this server was written from the linked mobile WhatsApp app.
            // Pause the chat for 30 minutes so AI cannot interrupt a human.
            if (fromMe && !knownMessage) {
                const manualSession = getSessionContext(normalizedSenderJid);
                manualSession.escalated = true;
                manualSession.lastIntent = 'mobile_manual_message';
                manualSession.manualHoldUntil = new Date(Date.now() + MANUAL_HANDOFF_WINDOW_MS).toISOString();
                saveSessionContext(normalizedSenderJid, manualSession);
                console.log(`[Human Handoff] Mobile message detected for ${normalizedSenderJid}; AI paused for 30 minutes.`);
            }

            // Emit update to UI
            if (typeof io !== 'undefined' && io) {
                io.emit('messages_update');
                io.emit('new_message', { jid: normalizedSenderJid, message: threadItem });
            }

            // --- Feature: Send-Time Analytics ---
            const replyHour = new Date().getHours();
            let sendTimeStats = getDb('send_time_stats');
            if (!sendTimeStats.hours) sendTimeStats.hours = {};
            sendTimeStats.hours[replyHour] = (sendTimeStats.hours[replyHour] || 0) + 1;
            saveDb('send_time_stats', sendTimeStats);

            // Outgoing messages are stored and broadcast above, but must not
            // trigger lead scoring, blacklisting, or an automated reply.
            if (!fromMe) {
            // --- Feature: Hot Leads & Auto-Sync ---
            const HOT_KEYWORDS = ['pricing', 'price', 'cost', 'fee', 'registration', 'register', 'interested', 'details', 'info', 'enroll', 'join', 'how much', 'apply', 'collaborate', 'collaboration', 'partner', 'partnership', 'mou', 'tie up'];
            const matchedKeyword = HOT_KEYWORDS.find(kw => lowerText.includes(kw));
            
            if (matchedKeyword || sentiment === 'Positive') {
                let hotLeads = getDb('hot_leads');
                const alreadyTagged = hotLeads.find(l => l.phone === normalizedSenderJid);
                if (!alreadyTagged) {
                    const newLead = {
                        phone: normalizedSenderJid,
                        name: msg.pushName || 'Unknown',
                        keyword: matchedKeyword || 'Sentiment',
                        sentiment: sentiment,
                        message: incomingText,
                        timestamp: new Date().toISOString()
                    };
                    hotLeads.unshift(newLead);
                    saveDb('hot_leads', hotLeads);
                    console.log(`[🔥 Hot Lead] Tagged ${normalizedSenderJid}`);
                    
                    // AUTO-SYNC TO GOOGLE SHEETS
                    syncLeadToSheet(newLead);
                }
            }

            // --- Feature: Auto-Blacklisting ---
            if (['stop', 'unsubscribe', 'optout', 'remove'].includes(lowerText)) {
                let blacklist = getDb('blacklist');
                if (!blacklist.includes(normalizedSenderJid)) {
                    blacklist.push(normalizedSenderJid);
                    saveDb('blacklist', blacklist);
                    console.log(`[Blacklist] System auto-banned ${normalizedSenderJid} per user request.`);
                    
                    // Reply confirming removal
                    await sendSmartMessage(normalizedSenderJid, instanceName, "You have been successfully removed from our list. You will not receive any more automated messages.", event.apikey);
                }
                continue; // Do not allow this item to trigger additional automation.
            }

            // --- Feature: Live Inbox Escalation Scan & Handoff Lock ---
            if (globalAiPaused) {
                console.log(`[Master AI Pause] Global AI is paused. Ignoring automated response for ${normalizedSenderJid}`);
                continue;
            }

            const currentSession = getSessionContext(normalizedSenderJid);
            const messageAge = Date.now() - new Date(sourceTimestamp).getTime();
            if (knownMessage || !Number.isFinite(messageAge) || messageAge > AI_INBOUND_FRESHNESS_MS) {
                logAutomationAudit('webhook', normalizedSenderJid, 'blocked', { reason: knownMessage ? 'Duplicate webhook message' : 'Inbound message is outside the AI freshness window', messageId: msgId });
                console.log(`[AI Safety] Ignoring ${knownMessage ? 'duplicate' : 'old'} inbound message for ${normalizedSenderJid}.`);
                continue;
            }
            if (currentSession.manualHoldUntil && new Date(currentSession.manualHoldUntil).getTime() > Date.now()) {
                logAutomationAudit('webhook', normalizedSenderJid, 'blocked', { reason: 'Recent mobile/manual conversation hold', until: currentSession.manualHoldUntil, messageId: msgId });
                console.log(`[Human Handoff] Recent human activity blocks AI for ${normalizedSenderJid} until ${currentSession.manualHoldUntil}.`);
                continue;
            }
            if (currentSession.escalated === true && !lowerText.includes('re-enable ai')) {
                console.log(`[Human Handoff] Conversation with ${normalizedSenderJid} is escalated. Skipping automated responder.`);
                continue;
            }
            
            // Re-enable AI command (for testing/ops convenience)
            if (lowerText.includes('re-enable ai')) {
                currentSession.escalated = false;
                saveSessionContext(normalizedSenderJid, currentSession);
                console.log(`[Human Handoff Lock] Re-enabled AI automated responder for ${normalizedSenderJid}`);
            }

            const kb = loadKnowledgeBase();
            const escTriggers = kb?.escalation?.priorityTriggers || [];
            const matchedEscalation = escTriggers.find(trig => {
                // strict match priority triggers in sentence
                return lowerText.includes(trig.toLowerCase());
            });
            
            if (matchedEscalation) {
                console.log(`[🚨 Escalation Trigger] "${matchedEscalation}" matched! Halting automation for human takeover.`);
                
                // Flag in inbox logs
                let inboxDb = getDb('inbox');
                const jidMatch = inboxDb.findIndex(m => m.jid === normalizedSenderJid);
                if (jidMatch !== -1) {
                    inboxDb[jidMatch].escalated = true;
                    inboxDb[jidMatch].escalationTrigger = matchedEscalation;
                    inboxDb[jidMatch].escalationTime = new Date().toISOString();
                    saveDb('inbox', inboxDb);
                }
                
                // Flag in session state context memory
                currentSession.escalated = true;
                currentSession.lastIntent = 'human_escalation';
                saveSessionContext(normalizedSenderJid, currentSession);
                
                // Dispatch recovery handoff message
                const handoffText = kb?.fallbacks?.handoff || "Connecting you with our support operations team. A manager will reply directly shortly.";
                const escalationDeskStr = `\n\nDirect Contacts:\n📞 Phone: ${kb.escalation.finance.phone} (${kb.escalation.finance.department})\n✉️ Email: ${kb.escalation.finance.email}`;
                
                await sendSmartMessage(normalizedSenderJid, instanceName, handoffText + escalationDeskStr + "\n\n— ScholarVault Team", event.apikey);

                // Dispatch WhatsApp push alert to Shyam (admin)
                const adminJid = "918610100624@s.whatsapp.net";
                const cleanPhone = normalizedSenderJid.replace('@s.whatsapp.net', '');
                const formattedPhone = (cleanPhone.startsWith('91') && cleanPhone.length === 12) 
                    ? `+${cleanPhone.slice(0, 2)}-${cleanPhone.slice(2, 7)}-${cleanPhone.slice(7)}` 
                    : `+${cleanPhone}`;
                const senderName = msg.pushName || 'Researcher';
                const alertMsg = `🚨 URGENT: Shyam, ${senderName} (${formattedPhone}) is requesting human assistance regarding ${matchedEscalation || 'manual escalation'}! View chat here: http://localhost:3000`;
                console.log(`[Admin Alert] Dispatching priority handoff WhatsApp push notification to Shyam...`);
                await sendSmartMessage(adminJid, instanceName, alertMsg, event.apikey);

                continue; // Keep processing any other messages in this webhook batch.
            }

            // --- Feature: Smart Auto Responder Routing (AI-First) ---
            const aiSettings = getAISettings();
            
            // Check if there is a strict exact trigger match first (for commands like help, human, menu)
            const sortedRules = [...autoReplyRules].sort((a, b) => b.trigger.length - a.trigger.length);
            const matchedRule = sortedRules.find(r => {
                const trig = r.trigger.trim().toLowerCase();
                const text = lowerText.trim();
                return text === trig || text === `/${trig}`;
            });

            if (matchedRule) {
                const delaySec = (matchedRule.delayMinutes || 0) * 60 * 1000;
                console.log(`[Auto-Reply] Strict Trigger Match "${matchedRule.trigger}" → delay ${matchedRule.delayMinutes}min`);
                setTimeout(async () => {
                    if (globalAiPaused) return;
                    await sendSmartMessage(normalizedSenderJid, instanceName, matchedRule.reply, event.apikey);
                }, delaySec);
            } else if (aiSettings.enabled) {
                // Pre-filtering check to prevent toxic, administrative, or off-topic hallucinations
                const filterResult = preFilterIncomingMessage(incomingText);
                if (filterResult.prohibited) {
                    console.log(`[🚨 Guardrail Intercept] Blocked off-topic/administrative query: "${incomingText}". Sending static safe response.`);
                    
                    // Auto-flag escalation for human safety if user is demanding system changes or showing hostile behavior
                    if (lowerText.includes('delete') || lowerText.includes('stupid') || lowerText.includes('idiot') || lowerText.includes('roast')) {
                        console.log(`[🚨 Guardrail Auto-Escalate] Hostile or data-modification intent detected. Flagging JID for human takeover.`);
                        currentSession.escalated = true;
                        currentSession.lastIntent = 'hostile_guardrail';
                        saveSessionContext(normalizedSenderJid, currentSession);
                        
                        let inboxDb = getDb('inbox');
                        const jidMatch = inboxDb.findIndex(m => m.jid === normalizedSenderJid);
                        if (jidMatch !== -1) {
                            inboxDb[jidMatch].escalated = true;
                            inboxDb[jidMatch].escalationTrigger = 'hostile_guardrail_intercept';
                            inboxDb[jidMatch].escalationTime = new Date().toISOString();
                            saveDb('inbox', inboxDb);
                        }
                    }

                    const delaySec = (Math.floor(Math.random() * 2) + 1) * 1000; // 1-2 second realistic human delay
                    setTimeout(async () => {
                        if (globalAiPaused) return;
                        await sendSmartMessage(normalizedSenderJid, instanceName, filterResult.reply + "\n\n— ScholarVault Team", event.apikey);
                    }, delaySec);
                    continue; // Skip AI for this item only.
                }

                // Conversational query: Route directly to Mistral AI
                console.log(`[AI Routing] Directing conversational query "${incomingText}" to Mistral AI...`);
                const aiDelay = (Math.floor(Math.random() * 3) + 2) * 1000; // 2-4 second human-like delay
                setTimeout(async () => {
                    if (globalAiPaused) return;
                    try {
                        const aiReply = await generateAIReply(incomingText, normalizedSenderJid, msg.pushName || 'Friend');
                        if (aiReply) {
                            await sendSmartMessage(normalizedSenderJid, instanceName, aiReply, event.apikey);
                            console.log(`[AI Routing] Sent AI reply to ${normalizedSenderJid}`);

                            // Check if the conversation was just escalated during this AI turn
                            const updatedSession = getSessionContext(normalizedSenderJid);
                            if (updatedSession.escalated === true && updatedSession.lastIntent === 'ai_requested_handoff') {
                                // 1. Flag in inbox database as escalated
                                let inboxDb = getDb('inbox');
                                const jidMatch = inboxDb.findIndex(m => m.jid === normalizedSenderJid);
                                if (jidMatch !== -1) {
                                    inboxDb[jidMatch].escalated = true;
                                    inboxDb[jidMatch].escalationTrigger = 'ai_requested_handoff';
                                    inboxDb[jidMatch].escalationTime = new Date().toISOString();
                                    saveDb('inbox', inboxDb);
                                }

                                // 2. Send immediate push WhatsApp alert to Shyam (admin)
                                const adminJid = "918610100624@s.whatsapp.net";
                                const cleanPhone = normalizedSenderJid.replace('@s.whatsapp.net', '');
                                const formattedPhone = (cleanPhone.startsWith('91') && cleanPhone.length === 12) 
                                    ? `+${cleanPhone.slice(0, 2)}-${cleanPhone.slice(2, 7)}-${cleanPhone.slice(7)}` 
                                    : `+${cleanPhone}`;
                                const senderName = msg.pushName || 'Researcher';
                                const alertMsg = `🚨 URGENT: Shyam, ${senderName} (${formattedPhone}) is requesting human assistance regarding AI handoff! View chat here: http://localhost:3000`;
                                console.log(`[Admin Alert] Dispatching WhatsApp push notification to Shyam...`);
                                await sendSmartMessage(adminJid, instanceName, alertMsg, event.apikey);
                            }
                        } else {
                            console.log(`[AI Routing] No AI reply generated for ${normalizedSenderJid}`);
                        }
                    } catch (aiErr) {
                        console.error('[AI Routing] Error:', aiErr.message);
                    }
                }, aiDelay);
            } else {
                // Backwards compatibility: If AI is disabled, fall back to old broad substring keyword matching
                const broadMatch = sortedRules.find(r => lowerText.includes(r.trigger.toLowerCase()));
                if (broadMatch) {
                    const delaySec = (broadMatch.delayMinutes || 0) * 60 * 1000;
                    console.log(`[Auto-Reply Fallback] Substring Match "${broadMatch.trigger}" → delay ${broadMatch.delayMinutes}min`);
                    setTimeout(async () => {
                        if (globalAiPaused) return;
                        await sendSmartMessage(normalizedSenderJid, instanceName, broadMatch.reply, event.apikey);
                    }, delaySec);
                }
            }
            }
            }
        } catch (err) {
            console.error('[Webhook Error]', err.message);
        }
    }
});

// --- Campaign Scheduler & Drip Engine ---
// One WhatsApp instance must send campaigns serially. Starting every due
// campaign at once causes overlapping presence/sends and makes cancellation
// unpredictable. The earliest scheduled campaign therefore owns the queue.
let campaignSchedulerBusy = false;
function isCampaignQuietNow(quietHours) {
    const start = String(quietHours?.start || '');
    const end = String(quietHours?.end || '');
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start === end) return false;
    const minutes = new Date().getHours() * 60 + new Date().getMinutes();
    const toMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
    const startMinutes = toMinutes(start), endMinutes = toMinutes(end);
    return startMinutes < endMinutes ? minutes >= startMinutes && minutes < endMinutes : minutes >= startMinutes || minutes < endMinutes;
}
function campaignDailyCount(campaignId) {
    const usage = getDb('campaign_daily_usage');
    const day = new Date().toISOString().slice(0, 10);
    return Number(usage[`${campaignId}:${day}`]?.sent || 0);
}
function recordCampaignDailySend(campaignId) {
    const usage = getDb('campaign_daily_usage');
    const day = new Date().toISOString().slice(0, 10);
    const key = `${campaignId}:${day}`;
    usage[key] = { sent: Number(usage[key]?.sent || 0) + 1, updatedAt: new Date().toISOString() };
    saveDb('campaign_daily_usage', usage);
}
setInterval(async () => {
    if (campaignSchedulerBusy) return;
    campaignSchedulerBusy = true;
    try {
        const now = Date.now();
        // 1. Check Scheduled Campaigns
        let campaigns = getDb('campaigns');
        const activeCampaign = Object.values(campaigns).some(campaign => campaign.status === 'processing' || campaign.status === 'running');
        if (!activeCampaign) {
            const next = Object.entries(campaigns)
                .filter(([, campaign]) => campaign.status === 'scheduled' && Number(campaign.scheduledFor || 0) <= now && !isCampaignQuietNow(campaign.quietHours))
                .sort(([, a], [, b]) => Number(a.scheduledFor || 0) - Number(b.scheduledFor || 0) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0];
            if (next) {
                const [campId, camp] = next;
                console.log(`[Campaign Queue] Starting: ${camp.name}`);
                campaigns[campId] = { ...camp, status: 'processing', startedAt: new Date().toISOString() };
                saveDb('campaigns', campaigns);
                if (typeof io !== 'undefined' && io) io.emit('campaign_update', { id: campId, status: 'processing', name: camp.name });
                // Do not await the long-running campaign. Its processing state
                // prevents the next queue item from beginning prematurely.
                processBulkCampaign(campId, campaigns[campId]).catch(error => console.error(`[Campaign Queue] ${camp.name} failed:`, error.message));
            }
        }

        // 2. Check Drip Follow-ups
        let dripState = getDb('drip_state');
        let dripUpdated = false;
        
        for (let jid in dripState) {
            let userDrip = dripState[jid];
            if (userDrip.pendingFollowups && userDrip.pendingFollowups.length > 0) {
                let nextFollowup = userDrip.pendingFollowups[0];
                if (nextFollowup.scheduledFor <= now) {
                    // Keep the follow-up queued while Master AI is paused;
                    // do not silently send it or discard it.
                    if (globalAiPaused) {
                        console.log(`[Master AI Pause] Drip follow-up held for ${jid}`);
                        continue;
                    }
                    // --- Smart Drip: Skip if prospect already replied ---
                    const replyTimes = getDb('reply_times');
                    const lastReply = replyTimes[jid] || 0;
                    const campaignSentAt = userDrip.campaignSentAt || 0;
                    if (lastReply > campaignSentAt) {
                        console.log(`[Cron] Drip SKIPPED for ${jid} — they already replied after the campaign.`);
                        userDrip.pendingFollowups = []; // Cancel all remaining follow-ups
                        dripUpdated = true;
                        continue;
                    }
                    console.log(`[Cron] Executing Drip Follow-up for ${jid}`);
                    // Send message with buttons if preserved
                    await sendSmartMessage(jid, nextFollowup.instance, nextFollowup.message, null, nextFollowup.buttons, false, 'bot');
                    
                    // Remove the executed followup
                    userDrip.pendingFollowups.shift();
                    
                    // If no more follow-ups, delete state, else save
                    if (userDrip.pendingFollowups.length === 0) {
                        delete dripState[jid];
                    }
                    dripUpdated = true;
                }
            }
        }
        if (dripUpdated) saveDb('drip_state', dripState);

    } catch (err) {
        console.error('[Cron Error]', err.message);
    } finally {
        campaignSchedulerBusy = false;
    }
}, 5000);

// --- SLA Monitor Task (runs every 5 mins) ---
setInterval(() => {
    try {
        console.log('[SLA Monitor] Checking for breaches...');
        let contacts = getDb('contacts');
        let updated = false;
        const now = Date.now();
        const BREACH_LIMIT_MS = 4 * 60 * 60 * 1000; // 4 Hours

        for (let jid in contacts) {
            const c = contacts[jid];
            if (c.lastReceivedAt && (!c.lastRepliedAt || new Date(c.lastRepliedAt) < new Date(c.lastReceivedAt))) {
                const waitTime = now - new Date(c.lastReceivedAt).getTime();
                if (waitTime > BREACH_LIMIT_MS && !c.slaBreach) {
                    c.slaBreach = true;
                    updated = true;
                    console.log(`[SLA BREACH] ${jid} has been waiting for ${Math.round(waitTime/3600000)} hours.`);
                }
            }
        }
        if (updated) saveDb('contacts', contacts);
    } catch (e) { console.error('[SLA Monitor Error]', e.message); }
}, 300000);

async function processBulkCampaign(campId, campData) {
    const { contacts, messageTemplate, instanceName, apiKey, delayBetweenMs, dripFollowups, mediaBase64, mediaFileName } = campData;
    // Scheduled work must not depend on a browser-only value. Older queued
    // campaigns lacked instanceName and later attempted to send via /undefined.
    const resolvedInstanceName = instanceName || getDefaultInstanceName();
    if (!resolvedInstanceName) {
        console.error(`[Campaign] Cannot start ${campData.name}: no WhatsApp instance is configured.`);
        return;
    }
    const activeAttachments = Array.isArray(campData.attachments) && campData.attachments.length > 0
        ? campData.attachments
        : (mediaBase64 ? [{ base64: mediaBase64, name: mediaFileName || 'campaign_poster.png' }] : []);
    let sentCount = 0;
    let failedCount = 0;
    let details = [];
    let dailyLimitReached = false;

    const hasMedia = activeAttachments.length > 0;
    if (hasMedia) {
        console.log(`[Campaign] Image attached: ${mediaFileName || 'poster'} — will send as media+caption`);
    }

    for (let contact of contacts) {
        // Re-read the campaign state between recipients. A stop request is
        // therefore honoured before the next contact is contacted, even while
        // a long-running campaign is already in progress.
        const liveCampaign = getDb('campaigns')[campId];
        if (!liveCampaign || liveCampaign.status === 'stopped') {
            console.log(`[Campaign] Stopped ${campData.name} before the next recipient.`);
            break;
        }
        const dailyLimit = Math.max(0, Number(campData.dailyLimit || 0));
        if (dailyLimit && campaignDailyCount(campId) >= dailyLimit) {
            dailyLimitReached = true;
            console.log(`[Campaign] Daily limit reached for ${campData.name}; pausing remaining recipients.`);
            break;
        }
        let targetJid = contact.jid || contact.phone;
        if (!targetJid) continue;

        // NEW: Safety check for non-numeric prefixes (prevents email@s.whatsapp.net failures)
        if (targetJid.includes('@')) {
            const prefix = targetJid.split('@')[0];
            if (isNaN(prefix) && !prefix.startsWith('status')) { // Skip non-numeric prefixes, allowing system JIDs like 'status' if needed
                console.log(`[Sender] Skipping invalid JID (non-numeric): ${targetJid}`);
                failedCount++;
                details.push({ phone: targetJid, name: contact.name || '-', status: 'failed', reason: 'Invalid JID Format (non-numeric)' });
                continue;
            }
        }
        
        const personalizedMessage = messageTemplate.replace('{{name}}', contact.name || 'Friend');
        let sentResult;

        const mediaOrder = campData.mediaOrder || 'caption';
        if (hasMedia) {
            let chainFailed = false;
            if (mediaOrder === 'media_first') {
                for (let i=0; i < activeAttachments.length; i++) {
                    sentResult = await sendMediaMessageCore(targetJid, resolvedInstanceName, activeAttachments[i].base64, '', activeAttachments[i].name, apiKey, true, 'campaign');
                    if (!sentResult.success) { chainFailed = true; break; }
                }
                if (!chainFailed) {
                    const pollOpts = campData.buttons || campData.pollOptions;
                    sentResult = await sendSmartMessageCore(targetJid, resolvedInstanceName, personalizedMessage, apiKey, pollOpts || [], true, 'campaign', campData.pollQuestion);
                }
            } else if (mediaOrder === 'text_first') {
                sentResult = await sendSmartMessageCore(targetJid, resolvedInstanceName, personalizedMessage, apiKey, [], false, 'campaign', '');
                chainFailed = !sentResult.success;
                for (let i=0; i < activeAttachments.length && !chainFailed; i++) {
                    sentResult = await sendMediaMessageCore(targetJid, resolvedInstanceName, activeAttachments[i].base64, '', activeAttachments[i].name, apiKey, true, 'campaign');
                    if (!sentResult.success) chainFailed = true;
                }
                const pollOpts = campData.buttons || campData.pollOptions;
                if (!chainFailed && pollOpts && pollOpts.length > 0) {
                    sentResult = await sendSmartMessageCore(targetJid, resolvedInstanceName, '', apiKey, pollOpts, true, 'campaign', campData.pollQuestion);
                }
            } else {
                for (let i=0; i < activeAttachments.length; i++) {
                    const cap = (i === 0) ? personalizedMessage : '';
                    sentResult = await sendMediaMessageCore(targetJid, resolvedInstanceName, activeAttachments[i].base64, cap, activeAttachments[i].name, apiKey, true, 'campaign');
                    if (!sentResult.success) { chainFailed = true; break; }
                }
                const pollOpts = campData.buttons || campData.pollOptions;
                if (!chainFailed && pollOpts && pollOpts.length > 0) {
                    sentResult = await sendSmartMessageCore(targetJid, resolvedInstanceName, '', apiKey, pollOpts, true, 'campaign', campData.pollQuestion);
                }
            }
            if (chainFailed) console.warn(`[Campaign] Delivery chain stopped before poll for ${targetJid}: ${sentResult?.reason || 'media send failed'}`);
        } else {
            const pollOpts = campData.buttons || campData.pollOptions;
            sentResult = await sendSmartMessageCore(targetJid, resolvedInstanceName, personalizedMessage, apiKey, pollOpts || [], false, 'campaign', campData.pollQuestion);
        }
        
        const isSuccess = sentResult && sentResult.success;
        if (isSuccess) {
            sentCount++;
            if (dailyLimit) recordCampaignDailySend(campId);
            details.push({ phone: targetJid, name: contact.name || '-', status: 'sent', reason: '' });
            // Auto-update lead status to Messaged in pipeline
            let contactsDb = getDb('contacts');
            const normalizedJid = targetJid.includes('@') ? targetJid : `${targetJid}@s.whatsapp.net`;
            if (!contactsDb[normalizedJid]) contactsDb[normalizedJid] = { jid: normalizedJid, name: contact.name || 'Friend' };
            if (!contactsDb[normalizedJid].leadStatus || contactsDb[normalizedJid].leadStatus === 'New') {
                contactsDb[normalizedJid].leadStatus = 'Messaged';
                contactsDb[normalizedJid].statusUpdatedAt = new Date().toISOString();
                saveDb('contacts', contactsDb);
            }
            
            // Register Drip Follow-ups if configured
            if (dripFollowups && dripFollowups.length > 0) {
                let dripState = getDb('drip_state');
                dripState[contact.jid] = {
                    instance: resolvedInstanceName,
                    campaignSentAt: Date.now(), // Used by Smart Drip reply check
                    pendingFollowups: dripFollowups.map(drip => ({
                        message: drip.message.replace('{{name}}', contact.name || 'Friend'),
                        scheduledFor: Date.now() + (drip.delayHours * 3600 * 1000),
                        instance: resolvedInstanceName,
                        buttons: drip.buttons || []
                    }))
                };
                saveDb('drip_state', dripState);
            }
        } else {
            failedCount++;
            details.push({ phone: targetJid, name: contact.name || '-', status: 'failed', reason: sentResult ? sentResult.reason : 'Failed locally' });
        }
        let liveCamps = getDb('campaigns');
        if (liveCamps[campId]) {
            liveCamps[campId].status = 'running';
            liveCamps[campId].sentCount = sentCount;
            liveCamps[campId].failedCount = failedCount;
            saveDb('campaigns', liveCamps);
            if (typeof io !== 'undefined' && io) io.emit('campaign_update', { id: campId, status: 'running', sentCount, failedCount, total: contacts.length });
        }
        // Delay between batch messages
        await new Promise(r => setTimeout(r, delayBetweenMs || 5000));
    }

    let campaigns = getDb('campaigns');
    if (campaigns[campId]) {
        const wasStopped = campaigns[campId].status === 'stopped';
        campaigns[campId].status = wasStopped ? 'stopped' : dailyLimitReached ? 'paused_limit' : 'completed';
        campaigns[campId].sentCount = sentCount;
        campaigns[campId].failedCount = failedCount;
        campaigns[campId].details = details;
        if (dailyLimitReached) campaigns[campId].pauseReason = `Daily sending limit of ${campData.dailyLimit} reached`;
        if (!wasStopped && !dailyLimitReached) campaigns[campId].completedAt = new Date().toISOString();
        saveDb('campaigns', campaigns);
        console.log(`[Campaign] Finished ${campData.name}: ${sentCount} sent, ${failedCount} failed.`);
        if (typeof io !== 'undefined' && io) io.emit('campaign_update', { id: campId, status: campaigns[campId].status, sentCount, failedCount, total: contacts.length });
    }
}

// Campaign API
app.post('/api/campaigns', (req, res) => {
    let campaigns = getDb('campaigns');
    const campId = 'camp_' + Date.now();
    
    // Check if scheduled immediately or future
    const scheduledFor = req.body.scheduledFor || Date.now();
    
    campaigns[campId] = {
        ...req.body,
        name: req.body.name || 'Unnamed Campaign',
        status: 'scheduled',
        createdAt: new Date().toISOString(),
        scheduledFor: scheduledFor,
        // Persist the resolved instance so scheduled and immediate work share
        // the same Evolution connection context.
        instanceName: req.body.instanceName || getDefaultInstanceName()
    };
    saveDb('campaigns', campaigns);
    if (typeof io !== 'undefined' && io) io.emit('campaign_update', { id: campId, status: 'scheduled', name: campaigns[campId].name });
    res.json({ success: true, message: 'Campaign Queued', campId });
});
app.get('/api/campaigns', (req, res) => res.json({ success: true, campaigns: getDb('campaigns') }));
app.post('/api/campaigns/preflight', (req, res) => {
    const supplied = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    const contactsDb = getDb('contacts');
    const blacklist = new Set(getDb('blacklist').map(normalizeJid));
    const campaigns = getDb('campaigns');
    const duplicateDays = Math.min(365, Math.max(0, Number(req.body?.duplicateWindowDays || 30)));
    const duplicateCutoff = Date.now() - duplicateDays * 86400000;
    const requireOptIn = Boolean(req.body?.requireOptIn);
    const skipRecent = Boolean(req.body?.skipRecentRecipients);
    const recentRecipients = new Set();
    for (const campaign of Object.values(campaigns)) {
        if (new Date(campaign.createdAt || 0).getTime() < duplicateCutoff) continue;
        for (const recipient of Array.isArray(campaign.contacts) ? campaign.contacts : []) {
            const jid = normalizeJid(recipient.jid || recipient.phone);
            if (jid) recentRecipients.add(jid);
        }
    }
    const seen = new Set();
    const summary = { supplied: supplied.length, eligible: [], invalid: [], blacklisted: [], duplicateInList: [], recentlyMessaged: [], noRecordedOptIn: [], unverified: [] };
    for (const candidate of supplied) {
        const jid = normalizeJid(candidate?.jid || candidate?.phone);
        const phone = jid.split('@')[0];
        if (!jid || !/^\d{8,15}$/.test(phone)) { summary.invalid.push(candidate?.phone || candidate?.jid || 'Unknown'); continue; }
        if (seen.has(jid)) { summary.duplicateInList.push(jid); continue; }
        seen.add(jid);
        if (candidate && candidate.valid === false) { summary.invalid.push(jid); continue; }
        if (!candidate || candidate.valid !== true) summary.unverified.push(jid);
        const contact = contactsDb[jid] || {};
        const optedIn = contact.optIn === true || contact.optedIn === true || String(contact.optInStatus || '').toLowerCase() === 'opted_in';
        if (blacklist.has(jid)) { summary.blacklisted.push(jid); continue; }
        if (requireOptIn && !optedIn) { summary.noRecordedOptIn.push(jid); continue; }
        if (recentRecipients.has(jid)) {
            summary.recentlyMessaged.push(jid);
            if (skipRecent) continue;
        }
        summary.eligible.push({ ...candidate, jid, phone, name: candidate?.name || contact.name || '' });
    }
    const delaySeconds = Math.max(3, Number(req.body?.delayBetweenMs || 5000) / 1000);
    const estimatedSeconds = Math.max(0, summary.eligible.length - 1) * delaySeconds;
    const dailyLimit = Math.max(0, Number(req.body?.dailyLimit || 0));
    res.json({
        success: true,
        eligibleContacts: summary.eligible,
        counts: {
            supplied: summary.supplied, eligible: summary.eligible.length, invalid: summary.invalid.length,
            blacklisted: summary.blacklisted.length, duplicateInList: summary.duplicateInList.length,
            recentlyMessaged: summary.recentlyMessaged.length, noRecordedOptIn: summary.noRecordedOptIn.length,
            unverified: summary.unverified.length
        },
        samples: { recentlyMessaged: summary.recentlyMessaged.slice(0, 5), blacklisted: summary.blacklisted.slice(0, 5), noRecordedOptIn: summary.noRecordedOptIn.slice(0, 5) },
        estimatedSeconds, dailyLimit, quietHours: req.body?.quietHours || null
    });
});
app.post('/api/campaigns/:campId/stop', (req, res) => {
    const campaigns = getDb('campaigns');
    const campaign = campaigns[req.params.campId];
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
    if (campaign.status === 'completed') return res.status(409).json({ success: false, message: 'Completed campaigns cannot be stopped' });
    campaign.status = 'stopped';
    campaign.stoppedAt = new Date().toISOString();
    campaign.stopReason = 'Stopped by operator';
    saveDb('campaigns', campaigns);
    if (typeof io !== 'undefined' && io) io.emit('campaign_update', { id: req.params.campId, status: 'stopped' });
    res.json({ success: true, message: 'Campaign stopped. No additional recipients will be contacted.' });
});
app.delete('/api/campaigns', (req, res) => {
    saveDb('campaigns', {});
    res.json({ success: true, message: 'Campaigns cleared' });
});

// ═══════════════════════════════════════════════════════════
// PHASE 1: CONTACT TAGS
// ═══════════════════════════════════════════════════════════
app.post('/api/contacts/:jid/tag', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const { tag } = req.body;
    if (!tag) return res.status(400).json({ success: false });
    let contacts = getDb('contacts');
    if (!contacts[jid]) contacts[jid] = { jid };
    if (!Array.isArray(contacts[jid].tags)) contacts[jid].tags = [];
    if (!contacts[jid].tags.includes(tag)) contacts[jid].tags.push(tag);
    saveDb('contacts', contacts);
    res.json({ success: true, contact: contacts[jid] });
});
app.delete('/api/contacts/:jid/tag', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const { tag } = req.body;
    let contacts = getDb('contacts');
    if (contacts[jid] && Array.isArray(contacts[jid].tags)) {
        contacts[jid].tags = contacts[jid].tags.filter(t => t !== tag);
        saveDb('contacts', contacts);
    }
    res.json({ success: true });
});

// Update profile details dynamically from the Live Inbox CRM panel
app.post('/api/contacts/:jid/profile', async (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const { email, institution, role, country, optIn } = req.body;
    
    try {
        const sessionContext = getSessionContext(jid);
        if (email !== undefined) sessionContext.email = email;
        if (institution !== undefined) sessionContext.institution = institution;
        if (role !== undefined) sessionContext.role = role;
        if (country !== undefined) sessionContext.country = country;
        saveSessionContext(jid, sessionContext);

        // Also sync to contacts DB
        let contacts = getDb('contacts');
        if (!contacts[jid]) contacts[jid] = { jid };
        if (email !== undefined) contacts[jid].email = email;
        if (institution !== undefined) contacts[jid].institution = institution;
        if (role !== undefined) contacts[jid].role = role;
        if (country !== undefined) contacts[jid].country = country;
        if (optIn !== undefined) {
            contacts[jid].optIn = Boolean(optIn);
            contacts[jid].optInUpdatedAt = new Date().toISOString();
        }
        saveDb('contacts', contacts);

        // Sync to Sheets
        await syncLearnedLeadToContacts(jid, sessionContext, contacts[jid].name || 'Researcher');
        
        console.log(`[CRM Profile API] Updated context for ${jid}:`, sessionContext);
        res.json({ success: true, context: sessionContext });
    } catch (err) {
        console.error('[CRM Profile API] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Follow-up Reminders ───
app.post('/api/contacts/:jid/followup', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const { followUpDate } = req.body;
    try {
        const sessionContext = getSessionContext(jid);
        if (followUpDate) {
            sessionContext.followUpDate = followUpDate;
        } else {
            delete sessionContext.followUpDate;
        }
        saveSessionContext(jid, sessionContext);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Local sales workspace metadata. These fields belong to the CRM only and are
// never sent to WhatsApp or copied back into a contact's WhatsApp profile.
function serializeContactWorkspace(context = {}, contact = {}) {
    return {
        priority: context.priority || contact.priority || 'Warm',
        leadSource: context.leadSource || contact.leadSource || '',
        interests: Array.isArray(context.interests) ? context.interests : (Array.isArray(contact.interests) ? contact.interests : []),
        nextAction: context.nextAction || '',
        followUpAt: context.followUpAt || context.followUpDate || contact.followUpDate || '',
        followUpDate: context.followUpDate || context.followUpAt || contact.followUpDate || '',
        notes: Array.isArray(context.crmNotes) ? context.crmNotes : (Array.isArray(context.notes) ? context.notes : []),
        crmNotes: Array.isArray(context.crmNotes) ? context.crmNotes : (Array.isArray(context.notes) ? context.notes : []),
        timeline: Array.isArray(context.timeline) ? context.timeline : []
    };
}
app.get('/api/contacts/:jid/workspace', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const context = getSessionContext(jid);
    const contacts = getDb('contacts');
    const contact = contacts[jid] || {};
    res.json({ success: true, workspace: serializeContactWorkspace(context, contact) });
});

app.post('/api/contacts/:jid/workspace', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const body = req.body || {};
    const context = getSessionContext(jid);
    const contacts = getDb('contacts');
    if (!contacts[jid]) contacts[jid] = { jid };
    if (body.followUpAt !== undefined) body.followUpDate = body.followUpAt;
    for (const field of ['priority', 'leadSource', 'nextAction', 'followUpDate']) {
        if (body[field] !== undefined) context[field] = String(body[field] || '');
    }
    if (body.interests !== undefined) context.interests = Array.isArray(body.interests) ? body.interests.map(String).filter(Boolean) : [];
    if (body.note && String(body.note).trim()) {
        context.crmNotes = Array.isArray(context.crmNotes) ? context.crmNotes : [];
        context.crmNotes.unshift({ id: `note_${Date.now()}`, text: String(body.note).trim(), createdAt: new Date().toISOString(), private: true });
    }
    context.timeline = Array.isArray(context.timeline) ? context.timeline : [];
    context.timeline.unshift({ id: `activity_${Date.now()}`, type: body.note ? 'private_note' : 'crm_update', label: body.note ? 'Private note added' : 'CRM workspace updated', createdAt: new Date().toISOString() });
    context.timeline = context.timeline.slice(0, 250);
    context.followUpAt = context.followUpDate || '';
    Object.assign(contacts[jid], { priority: context.priority, leadSource: context.leadSource, interests: context.interests, followUpDate: context.followUpDate, nextAction: context.nextAction });
    saveSessionContext(jid, context); saveDb('contacts', contacts);
    res.json({ success: true, workspace: serializeContactWorkspace(context, contacts[jid]) });
});

// CRM-only cleanup actions. These intentionally do not call Evolution: notes and
// follow-ups are private CRM metadata, not WhatsApp messages or contact records.
app.delete('/api/contacts/:jid/followup', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const context = getSessionContext(jid);
    const contacts = getDb('contacts');
    context.followUpDate = '';
    context.followUpAt = '';
    context.timeline = Array.isArray(context.timeline) ? context.timeline : [];
    context.timeline.unshift({ id: `activity_${Date.now()}`, type: 'followup_removed', label: 'Follow-up removed', createdAt: new Date().toISOString() });
    context.timeline = context.timeline.slice(0, 250);
    if (contacts[jid]) {
        contacts[jid].followUpDate = '';
        contacts[jid].followUpAt = '';
    }
    saveSessionContext(jid, context);
    saveDb('contacts', contacts);
    res.json({ success: true, workspace: serializeContactWorkspace(context, contacts[jid] || {}) });
});

app.delete('/api/contacts/:jid/notes/:noteId', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const noteId = decodeURIComponent(req.params.noteId);
    const context = getSessionContext(jid);
    const contacts = getDb('contacts');
    const notes = Array.isArray(context.crmNotes) ? context.crmNotes : (Array.isArray(context.notes) ? context.notes : []);
    const remaining = notes.filter(note => String(note?.id || '') !== String(noteId));
    if (remaining.length === notes.length) return res.status(404).json({ success: false, message: 'Private note not found' });
    context.crmNotes = remaining;
    context.timeline = Array.isArray(context.timeline) ? context.timeline : [];
    context.timeline.unshift({ id: `activity_${Date.now()}`, type: 'private_note_removed', label: 'Private note removed', createdAt: new Date().toISOString() });
    context.timeline = context.timeline.slice(0, 250);
    saveSessionContext(jid, context);
    saveDb('contacts', contacts);
    res.json({ success: true, workspace: serializeContactWorkspace(context, contacts[jid] || {}) });
});

app.get('/api/contacts/due-today', (req, res) => {
    const contexts = getDb('session_contexts');
    const now = new Date(); now.setHours(23, 59, 59, 999);
    const contacts = getDb('contacts');
    const due = Object.entries(contexts).filter(([, value]) => value?.followUpDate && new Date(value.followUpDate).getTime() <= now.getTime()).map(([jid, value]) => ({ jid, name: contacts[jid]?.displayNameOverride || contacts[jid]?.name || jid.split('@')[0], ...serializeContactWorkspace(value, contacts[jid] || {}) }));
    res.json({ success: true, due });
});

app.get('/api/contacts/follow-ups', (req, res) => {
    const contexts = getDb('session_contexts');
    const contacts = getDb('contacts');
    const now = Date.now();
    const followUps = Object.entries(contexts).filter(([, value]) => value?.followUpDate).map(([jid, value]) => {
        const followUpAt = value.followUpDate;
        const timestamp = new Date(followUpAt).getTime();
        return { jid, name: contacts[jid]?.displayNameOverride || contacts[jid]?.name || jid.split('@')[0], ...serializeContactWorkspace(value, contacts[jid] || {}), overdue: Number.isFinite(timestamp) && timestamp < now };
    }).sort((a, b) => new Date(a.followUpAt) - new Date(b.followUpAt));
    res.json({ success: true, followUps });
});

app.get('/api/resource-packs', (req, res) => {
    const stored = getDb('resource_packs');
    const packs = Array.isArray(stored)
        ? stored
        : Object.entries(stored || {}).map(([id, value]) => ({ id, ...(value || {}) }));
    res.json({ success: true, packs });
});
app.post('/api/resource-packs', (req, res) => {
    const body = req.body || {}; const stored = getDb('resource_packs');
    let packs = Array.isArray(stored) ? stored : Object.entries(stored || {}).map(([id, value]) => ({ id, ...(value || {}) }));
    const pack = { id: body.id || `pack_${Date.now()}`, name: String(body.name || 'Untitled pack').trim(), brochure: String(body.brochure || body.brochureLink || ''), brochureLink: String(body.brochureLink || body.brochure || ''), registrationLink: String(body.registrationLink || ''), cfpReminder: String(body.cfpReminder || body.cfpLink || ''), cfpLink: String(body.cfpLink || body.cfpReminder || ''), paymentLink: String(body.paymentLink || ''), brochureMessage: String(body.brochureMessage || ''), registrationMessage: String(body.registrationMessage || ''), drafts: body.drafts && typeof body.drafts === 'object' ? body.drafts : {}, updatedAt: new Date().toISOString() };
    const index = packs.findIndex(item => item.id === pack.id); if (index >= 0) packs[index] = pack; else packs.unshift(pack);
    saveDb('resource_packs', packs); res.json({ success: true, pack });
});
app.delete('/api/resource-packs/:id', (req, res) => {
    const stored = getDb('resource_packs');
    const packs = Array.isArray(stored) ? stored : Object.entries(stored || {}).map(([id, value]) => ({ id, ...(value || {}) }));
    saveDb('resource_packs', packs.filter(pack => pack.id !== req.params.id)); res.json({ success: true });
});

app.get('/api/whatsapp/templates', (req, res) => {
    let templates = getDb('whatsapp_templates');
    if (!Array.isArray(templates) || templates.length === 0) {
        templates = [
            {
                id: 'wa_svrias_cfp_story',
                name: 'SVRIAS 2026 — Call for Papers (Anti-Paper-Mill Story)',
                body: `{Dear|Respected|Hello} {{name}},\n\n{Have you ever attended an academic conference organized by an anonymous association, only to discover later that your paper was un-indexed or associated with a predatory paper-mill?|Every year, thousands of researchers lose their hard-earned publication funds to unverified conference networks promising fake indexing.}\n\nAt *ScholarVault*, we are changing that. As a *DPIIT-recognized academic integrity initiative*, we verify conferences using our *18-point SCVS forensic audit* to ensure genuine peer review and legitimate DOI archival.\n\nWe are officially inviting you to submit your abstract to *SVRIAS 2026* (*ScholarVault Research Integrity & Academic Summit*):\n\n📅 *Theme:* Research Integrity in the Age of Generative AI & Responsible Governance\n🌐 *Format:* 100% Virtual / Online (Attend globally without travel barriers)\n⚡ *Review:* Rapid 2–4 Day Editorial Peer-Review\n🎓 *Student Grants:* 10 Full (100%) Registration Fee Waivers Available\n\n📌 *Submit Abstract / Call for Papers:* https://researchintegrity2026.scholarvault.in/call-for-papers.html\n\n{Would you like me to send the official Call for Papers brochure?|Let me know if you are interested in presenting or reviewing!}\n\n— *ScholarVault Conference Desk*\n🌐 www.scholarvault.in`,
                message: `{Dear|Respected|Hello} {{name}},\n\n{Have you ever attended an academic conference organized by an anonymous association, only to discover later that your paper was un-indexed or associated with a predatory paper-mill?|Every year, thousands of researchers lose their hard-earned publication funds to unverified conference networks promising fake indexing.}\n\nAt *ScholarVault*, we are changing that. As a *DPIIT-recognized academic integrity initiative*, we verify conferences using our *18-point SCVS forensic audit* to ensure genuine peer review and legitimate DOI archival.\n\nWe are officially inviting you to submit your abstract to *SVRIAS 2026* (*ScholarVault Research Integrity & Academic Summit*):\n\n📅 *Theme:* Research Integrity in the Age of Generative AI & Responsible Governance\n🌐 *Format:* 100% Virtual / Online (Attend globally without travel barriers)\n⚡ *Review:* Rapid 2–4 Day Editorial Peer-Review\n🎓 *Student Grants:* 10 Full (100%) Registration Fee Waivers Available\n\n📌 *Submit Abstract / Call for Papers:* https://researchintegrity2026.scholarvault.in/call-for-papers.html\n\n{Would you like me to send the official Call for Papers brochure?|Let me know if you are interested in presenting or reviewing!}\n\n— *ScholarVault Conference Desk*\n🌐 www.scholarvault.in`,
                updatedAt: new Date().toISOString()
            }
        ];
        saveDb('whatsapp_templates', templates);
    }
    res.json({ success: true, templates });
});
app.post('/api/whatsapp/templates', (req, res) => {
    const body = req.body || {};
    let templates = getDb('whatsapp_templates');
    if (!Array.isArray(templates)) templates = [];
    const text = String(body.body || body.message || body.text || '').trim();
    const template = {
        id: body.id || `wa_tpl_${Date.now()}`,
        name: String(body.name || 'Untitled template').trim(),
        body: text,
        message: text,
        updatedAt: new Date().toISOString()
    };
    const index = templates.findIndex(t => t.id === template.id);
    if (index >= 0) templates[index] = template;
    else templates.unshift(template);
    saveDb('whatsapp_templates', templates);
    res.json({ success: true, template });
});
app.delete('/api/whatsapp/templates/:id', (req, res) => {
    let templates = getDb('whatsapp_templates');
    if (!Array.isArray(templates)) templates = [];
    saveDb('whatsapp_templates', templates.filter(t => t.id !== req.params.id));
    res.json({ success: true });
});


// ═══════════════════════════════════════════════════════════
// PHASE 1: CONVERSATION THREADS (Enriched)
// ═══════════════════════════════════════════════════════════
app.get('/api/inbox/:jid/thread', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    let threads = getDb('conversations');
    const sessionContext = getSessionContext(jid);
    
    // Enrich inbox data with current escalation status
    let inboxDb = getDb('inbox');
    const jidMatch = inboxDb.find(m => m.jid === jid);
    const escalated = sessionContext.escalated === true || (jidMatch && jidMatch.escalated === true);
    
    // Auto-seed: If thread is empty but we have an inbox record, import it as the first message
    if ((!threads[jid] || threads[jid].length === 0) && jidMatch) {
        threads[jid] = [{
            direction: 'in',
            text: jidMatch.message,
            name: jidMatch.name || 'Researcher',
            sentiment: jidMatch.sentiment || 'Neutral',
            timestamp: jidMatch.timestamp || new Date().toISOString()
        }];
        saveDb('conversations', threads);
    }
    
    // Do not make opening a chat (or sending a reply) wait for Evolution's
    // history endpoint. It can take 5–12 seconds even when the local thread is
    // already current. Refresh receipts/reactions in the background instead.
    if (req.query.refresh !== '0') {
        refreshEvolutionThreadMeta(jid)
            .then(changed => { if (changed && typeof io !== 'undefined' && io) io.emit('receipts_updated', { jid }); })
            .catch(() => { /* Existing local copy stays available offline. */ });
    }
    res.json({ 
        success: true, 
        thread: threads[jid] || [], 
        context: { ...sessionContext, jid, name: resolveContactIdentity(jid, getDb('contacts'), [jidMatch?.name]), escalated }
    });
});

// Reply via thread (also logs outgoing message)

// Reply with Poll via Live Inbox
app.post('/api/inbox/:jid/poll', async (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const { question, name, options, selectableCount, instance } = req.body;
    const pollQuestion = question || name;
    if (!pollQuestion || !Array.isArray(options) || options.length < 2) return res.status(400).json({ success: false, message: 'Question and at least two options are required' });
    
    // sendSmartMessageCore(remoteJid, instanceName, text, apiKey, buttons = [], skipDelay = false, senderType = 'bot', pollQuestion = '')
    const result = await sendSmartMessageCore(jid, instance || getDefaultInstanceName(), '', null, options, true, 'agent', pollQuestion);
    const success = result && result.success === true;

    if (success) {
        let inboxDb = getDb('inbox');
        const contacts = getDb('contacts');
        const existingIdx = inboxDb.findIndex(m => m.jid === jid);
        const pollMsg = 'You sent a poll: ' + pollQuestion;
        if (existingIdx !== -1) {
            inboxDb[existingIdx].message = pollMsg;
            inboxDb[existingIdx].timestamp = new Date().toISOString();
        } else {
            inboxDb.unshift({
                jid,
                name: contacts[jid]?.name || jid.split('@')[0],
                message: pollMsg,
                timestamp: new Date().toISOString(),
                sentiment: 'Neutral'
            });
        }
        saveDb('inbox', canonicalizeInboxRows(inboxDb, contacts));
        res.json({ success: true, message: 'Poll sent' });
    } else {
        res.status(500).json({ success: false, message: 'Failed to send poll' });
    }
});

app.post('/api/inbox/:jid/reply', async (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    // A malformed or headerless request must be rejected cleanly rather than
    // crashing the route and leaving the CRM composer in a failed state.
    const { message, instance } = req.body || {};
    if (!message) return res.status(400).json({ success: false, message: 'Message is required' });
    // A manual reply must be exactly-once from the operator's perspective.
    // Browsers can retry a request after a slow tunnel response, and two tabs
    // may be open to the same CRM. Never let either situation create a second
    // WhatsApp message.
    const idempotencyKey = String(req.get('X-Idempotency-Key') || '').trim();
    const replyFingerprint = `${normalizeJid(jid)}|${String(message).trim()}`;
    const now = Date.now();
    if (!global.manualReplyDedupe) global.manualReplyDedupe = new Map();
    for (const [key, value] of global.manualReplyDedupe) {
        if (now - value.createdAt > 60 * 1000) global.manualReplyDedupe.delete(key);
    }
    const dedupeKey = idempotencyKey || replyFingerprint;
    const existingReply = global.manualReplyDedupe.get(dedupeKey)
        || global.manualReplyDedupe.get(`fingerprint:${replyFingerprint}`);
    if (existingReply) {
        return res.json({ success: true, duplicate: true, messageId: existingReply.messageId || null });
    }
    // Reserve the request before calling Evolution, so concurrent duplicate
    // clicks cannot race each other.
    const reservation = { createdAt: now, messageId: null };
    global.manualReplyDedupe.set(dedupeKey, reservation);
    global.manualReplyDedupe.set(`fingerprint:${replyFingerprint}`, reservation);
    
    // We pass skipDelay = true and senderType = 'agent' so manual replies are sent instantly and logged automatically in sendSmartMessage
    const result = await sendSmartMessageCore(jid, instance || getDefaultInstanceName(), message, null, null, true, 'agent');
    const success = result.success === true;
    reservation.messageId = result.messageId || null;
    if (!success) {
        global.manualReplyDedupe.delete(dedupeKey);
        global.manualReplyDedupe.delete(`fingerprint:${replyFingerprint}`);
    }

    // Update inbox so outbound messages appear in the chat list sidebar
    if (success) {
        let inboxDb = getDb('inbox');
        const contacts = getDb('contacts');
        const existingIdx = inboxDb.findIndex(m => m.jid === jid);
        if (existingIdx !== -1) {
            inboxDb[existingIdx].message = 'You: ' + message;
            inboxDb[existingIdx].timestamp = new Date().toISOString();
        } else {
            inboxDb.unshift({
                jid,
                name: contacts[jid]?.name || jid.split('@')[0],
                message: 'You: ' + message,
                timestamp: new Date().toISOString(),
                sentiment: 'Neutral'
            });
        }
        saveDb('inbox', canonicalizeInboxRows(inboxDb, contacts));
    }

    res.json({ success, messageId: result.messageId || null, reason: result.reason || null });
});

// Send media via thread (handles base64 data URIs and saves file locally)

// --- Send Voice Note ---
app.post('/api/chat/send-audio', async (req, res) => {
    try {
        const { jid, base64 } = req.body;
        if (!jid || !base64) return res.status(400).json({ success: false, message: 'Missing jid or base64 audio data' });

        console.log(`[PTT] Sending voice note to ${jid}`);
        const EVO_API_URL = (process.env.EVO_API_URL || 'http://localhost:8080');
        const EVO_API_KEY = (process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!');
        
        // Strip any data URI prefix if present (e.g. data:audio/mp3;base64, or data:audio/webm;codecs=opus;base64,)
        const b64Data = base64.includes(',') ? base64.split(',')[1] : base64;

        const evoPayload = {
            number: jid.split('@')[0],
            options: {
                delay: 1200,
                presence: 'recording',
                encoding: true
            },
            audioMessage: {
                audio: b64Data
            },
            audio: b64Data // pure base64 without prefix
        };

        const evoRes = await axios.post(
            `${EVO_API_URL}/message/sendWhatsAppAudio/ScholarVault`,
            evoPayload,
            { headers: { 'apikey': EVO_API_KEY, 'Content-Type': 'application/json' } }
        );

        if (evoRes.data && evoRes.data.key) {
            // Save to conversations
            let convos = getDb('conversations');
            if (!convos[jid]) convos[jid] = [];
            convos[jid].push({
                id: evoRes.data.key.id,
                messageId: evoRes.data.key.id,
                direction: 'out',
                text: '🎤 Voice Note',
                mediaType: 'audio',
                mediaUrl: base64,
                timestamp: new Date().toISOString(),
                status: 'PENDING',
                senderType: 'agent'
            });
            saveDb('conversations', convos);

            // Update inbox
            let inbox = getDb('inbox');
            const inboxIdx = inbox.findIndex(m => m.jid === jid);
            if (inboxIdx !== -1) {
                inbox[inboxIdx].message = '🎤 Voice Note';
                inbox[inboxIdx].timestamp = new Date().toISOString();
                const item = inbox.splice(inboxIdx, 1)[0];
                inbox.unshift(item);
                saveDb('inbox', inbox);
            }

            res.json({ success: true, messageId: evoRes.data.key.id });
        } else {
            console.error('[PTT] Evolution API Error:', evoRes.data);
            res.status(500).json({ success: false, message: 'Failed to send voice note via Evolution API' });
        }
    } catch (e) {
        console.error('[PTT Error]', e.response ? e.response.data : e.message);
        res.status(500).json({ success: false, message: e.response ? JSON.stringify(e.response.data) : e.message });
    }
});

app.post('/api/inbox/:jid/media', async (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const { media, mediatype, fileName, caption, instance } = req.body;
    
    if (!media || !mediatype) {
        return res.status(400).json({ success: false, message: 'Media and mediatype are required.' });
    }
    
    try {
        let base64Data = media;
        if (media.startsWith('data:')) {
            const parts = media.split(';base64,');
            base64Data = parts[1];
        }
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Ensure local uploads directory exists
        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        
        const cleanFileName = (fileName || (mediatype === 'image' ? 'photo.png' : 'document.pdf')).replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const savedFileName = `${Date.now()}-${cleanFileName}`;
        const localFilePath = path.join(uploadsDir, savedFileName);
        
        // Write the file locally
        fs.writeFileSync(localFilePath, buffer);
        const relativeUrl = `/uploads/${savedFileName}`;
        
        // Forward to Evolution API
        const EVO_API_URL = (process.env.EVO_API_URL || 'http://localhost:8080');
        const instName = instance || getDefaultInstanceName();
        const key = (process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!');
        let apiSuccess = false;
        
        console.log(`[Sender] Dispatching base64 media message to ${jid} via Evolution API...`);
        const evoResponse = await axios.post(`${EVO_API_URL}/message/sendMedia/${instName}`, {
            number: jid,
            media: base64Data, // Evolution API expects pure base64 string without data URI scheme prefix
            mediatype: mediatype,
            fileName: fileName || cleanFileName,
            caption: caption || ''
        }, { headers: { 'apikey': key } });
        
        apiSuccess = !!evoResponse.data;
        const msgId = evoResponse?.data?.key?.id || evoResponse?.data?.message?.key?.id || null;
        
        if (apiSuccess) {
            let threads = getDb('conversations');
            if (!threads[jid]) threads[jid] = [];
            threads[jid].push({
                id: msgId,
                fromMe: true,
                direction: 'out',
                text: caption || `Sent ${mediatype}: ${fileName || cleanFileName}`,
                mediaUrl: relativeUrl,
                mediaType: mediatype,
                fileName: fileName || cleanFileName,
                senderType: 'agent',
                timestamp: new Date().toISOString()
            });
            saveDb('conversations', threads);
            
            // Track reply for SLA
            let contacts = getDb('contacts');
            if (contacts[jid]) {
                contacts[jid].lastRepliedAt = new Date().toISOString();
                contacts[jid].slaBreach = false;
                saveDb('contacts', contacts);
            }
        }
        
        res.json({ success: apiSuccess, mediaUrl: relativeUrl });
    } catch (err) {
        console.error('[Inbox Media API] Error:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Send manual emoji reaction via Evolution API (R1: Milestone 1)
app.post('/message/sendReaction/:instance', async (req, res) => {
    try {
        const instanceName = req.params.instance || getDefaultInstanceName();
        let { jid, messageId, reaction, fromMe } = req.body;

        // Support nested payload structure (reactionMessage) or flat structure
        if (req.body && req.body.reactionMessage && req.body.reactionMessage.key) {
            jid = req.body.reactionMessage.key.remoteJid;
            messageId = req.body.reactionMessage.key.id;
            fromMe = req.body.reactionMessage.key.fromMe;
            reaction = req.body.reactionMessage.reaction;
        }

        if (!jid || !messageId || reaction === undefined) {
            return res.status(400).json({ success: false, message: 'jid, messageId, and reaction parameters are required.' });
        }

        const EVO_API_URL = process.env.EVO_API_URL || 'http://localhost:8080';
        const key = process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!';

        console.log(`[Reaction API] Dispatching reaction "${reaction}" for message ID ${messageId} to ${jid} via ${instanceName}...`);

        let evoResponse = null;
        try {
            evoResponse = await axios.post(
                `${EVO_API_URL}/message/sendReaction/${instanceName}`,
                {
                    reactionMessage: {
                        key: {
                            remoteJid: jid,
                            fromMe: fromMe ?? true,
                            id: messageId
                        },
                        reaction: reaction
                    }
                },
                { headers: { 'apikey': key, 'Content-Type': 'application/json' } }
            );
        } catch (evoErr) {
            console.warn('[Reaction API] Evolution API request warning:', evoErr.response?.data || evoErr.message);
        }

        // Update local data persistence store (conversations.json)
        let threads = getDb('conversations');
        if (threads[jid]) {
            const msgIndex = threads[jid].findIndex(m => m.id === messageId || m.messageId === messageId);
            if (msgIndex !== -1) {
                if (reaction) {
                    threads[jid][msgIndex].reaction = reaction;
                } else {
                    delete threads[jid][msgIndex].reaction;
                }
                saveDb('conversations', threads);
            }
        }

        if (typeof io !== 'undefined' && io) {
            io.emit('messages_update');
        }

        res.json({ success: true, data: evoResponse?.data || { status: 'OK' } });
    } catch (err) {
        console.error('[Reaction API Error]', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.response?.data || err.message });
    }
});

// Toggle escalation/handoff state manually
app.post('/api/inbox/:jid/escalate', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const { escalated } = req.body;
    
    if (escalated === undefined) {
        return res.status(400).json({ success: false, message: 'escalated flag is required.' });
    }
    
    try {
        const currentSession = getSessionContext(jid);
        currentSession.escalated = escalated === true;
        currentSession.lastIntent = escalated ? 'manual_takeover' : 'manual_resolve';
        if (!escalated) {
            currentSession.aiEnabledAt = new Date().toISOString();
            delete currentSession.manualHoldUntil;
        }
        saveSessionContext(jid, currentSession);
        
        // Also update standard inbox DB
        let inboxDb = getDb('inbox');
        const jidMatch = inboxDb.findIndex(m => m.jid === jid);
        if (jidMatch !== -1) {
            inboxDb[jidMatch].escalated = escalated === true;
            inboxDb[jidMatch].escalationTrigger = escalated ? 'manual_takeover' : 'manual_resolve';
            inboxDb[jidMatch].escalationTime = escalated ? new Date().toISOString() : null;
            saveDb('inbox', inboxDb);
        }
        
        console.log(`[Manual Escalation] Toggle set to ${escalated} for ${jid}`);
        res.json({ success: true, session: currentSession, globalAiPaused, message: !escalated && globalAiPaused ? 'Chat AI is ready, but Global AI is paused so no automated message can be sent.' : undefined });
    } catch (err) {
        console.error('[Inbox Escalation API] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════
// PHASE 1: NON-RESPONDER EXTRACTOR
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// PHASE 2: ADVANCED ANALYTICS (Consolidated)
app.get('/api/analytics/funnel', (req, res) => {
    try {
        const contacts = getDb('contacts');
        const allContacts = Object.values(contacts);
        const campaigns = getDb('campaigns');
        
        let sent = 0;
        Object.values(campaigns).forEach(c => { sent += (c.contacts || []).length; });

        const replied = allContacts.filter(c => c.lastReceivedAt).length;
        const interested = allContacts.filter(c => c.sentiment === 'Positive' || c.leadStatus === 'Interested').length;

        const byCampaign = Object.values(campaigns).map(c => ({
            name: c.name,
            sent: (c.contacts || []).length,
            replied: allContacts.filter(con => con.lastReceivedAt && (con.campaignId === c.id || c.contacts.some(cc => cc.phone === con.phone))).length,
            interested: allContacts.filter(con => (con.sentiment === 'Positive' || con.leadStatus === 'Interested') && (con.campaignId === c.id || c.contacts.some(cc => cc.phone === con.phone))).length,
            date: c.createdAt
        }));

        res.json({ success: true, funnel: { sent, replied, interested }, byCampaign });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/analytics/send-time', (req, res) => {
    res.json({ success: true, stats: getDb('send_time_stats') });
});
app.get('/api/analytics/sla', (req, res) => {
    const contacts = getDb('contacts');
    const allContacts = Object.values(contacts);
    const breaches = allContacts.filter(c => c.slaBreach);
    const healthy = allContacts.filter(c => c.lastReceivedAt && !c.slaBreach);
    res.json({ success: true, count: breaches.length, healthyCount: healthy.length, breaches });
});

app.get('/api/analytics/sentiment', (req, res) => {
    try {
        const contacts = getDb('contacts');
        const stats = { Positive: 0, Negative: 0, Neutral: 0, Urgent: 0 };
        Object.values(contacts).forEach(c => {
            const s = c.sentiment || 'Neutral';
            if (stats[s] !== undefined) stats[s]++;
            else stats['Neutral']++;
        });
        res.json({ success: true, stats });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/campaigns/:campId/non-responders', (req, res) => {
    const { campId } = req.params;
    const campaigns = getDb('campaigns');
    const camp = campaigns[campId];
    if (!camp) return res.status(404).json({ success: false, message: 'Campaign not found' });
    const inbox = getDb('inbox');
    const repliersSet = new Set(inbox.map(m => m.jid));
    const nonResponders = (camp.contacts || []).filter(c => {
        const jid = (c.jid || `${c.phone}@s.whatsapp.net`);
        return !repliersSet.has(jid);
    });
    res.json({ success: true, total: (camp.contacts || []).length, nonResponders, count: nonResponders.length });
});
app.get('/api/campaigns/:campId/non-responders/csv', (req, res) => {
    const { campId } = req.params;
    const campaigns = getDb('campaigns');
    const camp = campaigns[campId];
    if (!camp) return res.status(404).json({ success: false });
    const inbox = getDb('inbox');
    const repliersSet = new Set(inbox.map(m => m.jid));
    const nonResponders = (camp.contacts || []).filter(c => !repliersSet.has(c.jid || `${c.phone}@s.whatsapp.net`));
    let csv = 'Phone,Name\n';
    nonResponders.forEach(c => { csv += `"${c.phone || c.jid}","${c.name || ''}"\n`; });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="non_responders_${campId}.csv"`);
    res.send(csv);
});

// ═══════════════════════════════════════════════════════════
// PHASE 1: WHATSAPP NUMBER VALIDATOR
// ═══════════════════════════════════════════════════════════
app.post('/api/validate-numbers', async (req, res) => {
    const { phones, instanceName, apiKey } = req.body;
    if (!phones || !phones.length) return res.status(400).json({ success: false });
    
    const instances = getDb('instances');
    const defaultInstName = getDefaultInstanceName();
    const targetInstanceName = instanceName || defaultInstName;
    
    let key = apiKey || (process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!');
    let EVO_API_URL = (process.env.EVO_API_URL || 'http://localhost:8080');
    if (Array.isArray(instances) && instances.length > 0) {
        const inst = instances.find(i => i.name === targetInstanceName) || instances[0];
        key = apiKey || inst.apiKey || key;
        EVO_API_URL = inst.apiUrl || EVO_API_URL;
    }
    
    try {
        const response = await axios.post(`${EVO_API_URL}/chat/whatsappNumbers/${targetInstanceName}`,
            { numbers: phones }, { headers: { 'apikey': key } });
        const results = response.data || [];
        const valid = results.filter(r => r.exists).map(r => r.jid || r.number);
        const invalid = results.filter(r => !r.exists).map(r => r.number);
        res.json({ success: true, valid, invalid, results });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// PHASE 2: ENGAGEMENT FUNNEL ANALYTICS
// ═══════════════════════════════════════════════════════════
app.get('/api/analytics/funnel', (req, res) => {
    const campaigns = getDb('campaigns');
    const inbox = getDb('inbox');
    const repliersSet = new Set(inbox.map(m => m.jid));
    const hotLeads = getDb('hot_leads');
    const hotSet = new Set(hotLeads.map(l => l.phone));
    let totalSent = 0, totalReplied = 0, totalInterested = 0;
    const byCampaign = [];
    Object.entries(campaigns).forEach(([id, c]) => {
        const sent = c.sentCount || 0;
        const contacts = c.contacts || [];
        const replied = contacts.filter(ct => repliersSet.has(ct.jid || `${ct.phone}@s.whatsapp.net`)).length;
        const interested = contacts.filter(ct => hotSet.has(ct.jid || `${ct.phone}@s.whatsapp.net`)).length;
        totalSent += sent; totalReplied += replied; totalInterested += interested;
        if (sent > 0) byCampaign.push({ id, name: c.name, sent, replied, interested, date: c.createdAt });
    });
    res.json({ success: true, funnel: { sent: totalSent, replied: totalReplied, interested: totalInterested }, byCampaign });
});
app.get('/api/analytics/send-time', (req, res) => {
    const stats = getDb('send_time_stats');
    res.json({ success: true, stats });
});

// ═══════════════════════════════════════════════════════════
// PHASE 2: LEAD STATUS PIPELINE
// ═══════════════════════════════════════════════════════════
app.get('/api/pipeline', (req, res) => {
    const contacts = getDb('contacts') || {};
    const pipeline = { New: [], Messaged: [], Replied: [], Interested: [], Registered: [], Attended: [] };
    Object.entries(contacts).forEach(([jid, value]) => {
        const c = { jid, ...(value || {}) };
        const status = c.leadStatus || 'New';
        if (pipeline[status]) pipeline[status].push(c);
        else pipeline['New'].push(c);
    });
    res.json({ success: true, pipeline });
});
app.post('/api/contacts/:jid/status', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const { status } = req.body || {};
    const valid = ['New','Messaged','Replied','Interested','Registered','Attended'];
    if (!valid.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
    let contacts = getDb('contacts');
    if (!contacts[jid]) contacts[jid] = { jid };
    contacts[jid].leadStatus = status;
    contacts[jid].statusUpdatedAt = new Date().toISOString();
    saveDb('contacts', contacts);
    res.json({ success: true });
});
app.get('/api/pipeline/csv', (req, res) => {
    const contacts = getDb('contacts') || {};
    let csv = 'Name,Phone,Status,Tags,Updated\n';
    Object.entries(contacts).forEach(([jid, value]) => {
        const c = { jid, ...(value || {}) };
        const phone = c.jid ? c.jid.split('@')[0] : c.phone || '';
        csv += `"${c.name||''}","${phone}","${c.leadStatus||'New'}","${(c.tags||[]).join(';')}","${c.statusUpdatedAt||''}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="pipeline.csv"');
    res.send(csv);
});

// ═══════════════════════════════════════════════════════════
// PHASE 3: A/B TEMPLATE TESTING
// ═══════════════════════════════════════════════════════════
app.post('/api/ab-test', (req, res) => {
    const { name, contacts, templateA, templateB, splitRatio, instanceName, apiKey } = req.body;
    if (!templateA || !templateB || !contacts || !contacts.length)
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    const split = Math.floor(contacts.length * ((splitRatio || 50) / 100));
    const groupA = contacts.slice(0, split);
    const groupB = contacts.slice(split);
    const testId = 'ab_' + Date.now();
    const now = Date.now();
    // Create two campaigns
    let campaigns = getDb('campaigns');
    const campIdA = testId + '_A';
    const campIdB = testId + '_B';
    campaigns[campIdA] = { name: `${name} [A]`, status: 'scheduled', scheduledFor: now, messageTemplate: templateA, contacts: groupA, instanceName, apiKey, abTestId: testId, abVariant: 'A', createdAt: new Date().toISOString() };
    campaigns[campIdB] = { name: `${name} [B]`, status: 'scheduled', scheduledFor: now, messageTemplate: templateB, contacts: groupB, instanceName, apiKey, abTestId: testId, abVariant: 'B', createdAt: new Date().toISOString() };
    saveDb('campaigns', campaigns);
    // Store test record
    let abTests = getDb('ab_tests');
    abTests[testId] = { id: testId, name, templateA, templateB, splitRatio: splitRatio || 50, campIdA, campIdB, createdAt: new Date().toISOString(), winnerDeclaredAt: null, winner: null, declareAfterMs: 24 * 3600 * 1000 };
    saveDb('ab_tests', abTests);
    res.json({ success: true, testId, campIdA, campIdB });
});
app.get('/api/ab-tests', (req, res) => {
    const abTests = getDb('ab_tests');
    const campaigns = getDb('campaigns');
    const inbox = getDb('inbox');
    const repliersSet = new Set(inbox.map(m => m.jid));
    const results = Object.values(abTests).map(t => {
        const campA = campaigns[t.campIdA] || {};
        const campB = campaigns[t.campIdB] || {};
        const repliedA = (campA.contacts || []).filter(c => repliersSet.has(c.jid || `${c.phone}@s.whatsapp.net`)).length;
        const repliedB = (campB.contacts || []).filter(c => repliersSet.has(c.jid || `${c.phone}@s.whatsapp.net`)).length;
        const rateA = campA.sentCount ? ((repliedA / campA.sentCount) * 100).toFixed(1) : 0;
        const rateB = campB.sentCount ? ((repliedB / campB.sentCount) * 100).toFixed(1) : 0;
        let winner = t.winner;
        if (!winner && (Date.now() - new Date(t.createdAt).getTime() > t.declareAfterMs)) {
            winner = rateA >= rateB ? 'A' : 'B';
        }
        return { ...t, sentA: campA.sentCount || 0, sentB: campB.sentCount || 0, repliedA, repliedB, rateA, rateB, winner };
    });
    res.json({ success: true, tests: results });
});

// ═══════════════════════════════════════════════════════════
// PHASE 3: MULTI-INSTANCE MANAGER
// ═══════════════════════════════════════════════════════════
app.get('/api/instances', async (req, res) => {
    let instances = getDb('instances');
    if (!Array.isArray(instances)) instances = [];
    
    // Programmatically assign the first instance as default if none is marked
    if (instances.length > 0 && !instances.some(i => i.isDefault)) {
        instances[0].isDefault = true;
    }

    // Check live status for each
    const withStatus = await Promise.all(instances.map(async inst => {
        try {
            const r = await axios.get(`${inst.apiUrl}/instance/connectionState/${inst.name}`, { headers: { 'apikey': inst.apiKey }, timeout: 3000 });
            return { name: inst.name, apiUrl: inst.apiUrl, addedAt: inst.addedAt, isDefault: Boolean(inst.isDefault), keyConfigured: Boolean(inst.apiKey), status: r.data?.instance?.state || 'unknown' };
        } catch (err) { 
            return { name: inst.name, apiUrl: inst.apiUrl, addedAt: inst.addedAt, isDefault: Boolean(inst.isDefault), keyConfigured: Boolean(inst.apiKey), status: 'offline' }; 
        }
    }));
    res.json({ success: true, instances: withStatus });
});
app.post('/api/instances', (req, res) => {
    const { name, apiUrl, apiKey } = req.body || {};
    if (!name || !apiUrl) return res.status(400).json({ success: false, message: 'Instance name and API URL are required.' });
    let instances = getDb('instances');
    if (!Array.isArray(instances)) instances = [];
    const index = instances.findIndex(i => i.name === name);
    if (index >= 0) instances[index] = { ...instances[index], name, apiUrl, apiKey: apiKey || instances[index].apiKey };
    else {
        if (!apiKey) return res.status(400).json({ success: false, message: 'API key is required for a new instance.' });
        instances.push({ name, apiUrl, apiKey, addedAt: new Date().toISOString(), isDefault: instances.length === 0 });
    }
    saveDb('instances', instances);
    res.json({ success: true });
});
app.delete('/api/instances/:name', (req, res) => {
    let instances = getDb('instances');
    if (!Array.isArray(instances)) instances = [];
    instances = instances.filter(i => i.name !== req.params.name);
    saveDb('instances', instances);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// PHASE 4: LISTMONK INTEGRATION
// ═══════════════════════════════════════════════════════════

if (false) { // Retired Listmonk integration; preserved only as local source history.
app.get('/api/settings/listmonk', (req, res) => {
    const s = getDb('settings_listmonk');
    res.json({ success: true, settings: s || { url: 'https://listmonk.scholarvault.in', username: 'Sam' } });
});

app.post('/api/settings/listmonk', (req, res) => {
    const { url, username, password } = req.body;
    saveDb('settings_listmonk', { url, username, password });
    LISTMONK_URL = url;
    LISTMONK_AUTH = { username, password };
    res.json({ success: true });
});

app.get('/api/listmonk/lists', async (req, res) => {
    try {
        console.log(`[Listmonk] Fetching lists from ${LISTMONK_URL}...`);
        const r = await axios.get(`${LISTMONK_URL}/api/lists?per_page=100`, { 
            auth: LISTMONK_AUTH,
            timeout: 5000 
        });
        console.log(`[Listmonk] Successfully fetched ${r.data?.data?.results?.length || 0} lists.`);
        res.json({ success: true, lists: r.data?.data?.results || [] });
    } catch (e) { 
        console.error(`[Listmonk Error] ${e.message}`);
        if (e.response) {
            console.error(`[Listmonk Detail] Status: ${e.response.status}, Data:`, e.response.data);
        }
        res.json({ success: false, message: e.message, lists: [] }); 
    }
});
app.get('/api/listmonk/subscribers/:listId', async (req, res) => {
    try {
        const r = await axios.get(`${LISTMONK_URL}/api/subscribers?list_id=${req.params.listId}&per_page=500`, { auth: LISTMONK_AUTH });
        res.json({ success: true, subscribers: r.data?.data?.results || [] });
    } catch (e) { res.json({ success: false, message: e.message, subscribers: [] }); }
});
app.post('/api/listmonk/send-email', async (req, res) => {
    const { listId, templateId, subject, campaignName } = req.body;
    try {
        const r = await axios.post(`${LISTMONK_URL}/api/campaigns`, {
            name: campaignName || 'ScholarVault Campaign',
            subject: subject || 'Important Update from ScholarVault',
            lists: [parseInt(listId)],
            template_id: parseInt(templateId) || 1,
            type: 'regular',
            content_type: 'richtext',
            status: 'scheduled',
            send_at: new Date(Date.now() + 30000).toISOString()
        }, { auth: LISTMONK_AUTH });
        res.json({ success: true, campaign: r.data });
    } catch (e) { res.json({ success: false, message: e.message }); }
});
app.post('/api/unified-campaign', async (req, res) => {
    const { name, listId, contacts: manualContacts, whatsappTemplate, emailSubject, emailBody, emailTemplateId, instanceName, apiKey } = req.body;
    const results = { whatsapp: null, email: null };
    
    try {
        let finalContacts = [];

        if (manualContacts && manualContacts.length > 0) {
            console.log(`[Unified] Syncing ${manualContacts.length} manual contacts to Listmonk List ${listId}...`);
            // Step 1: Sync to Listmonk
            await Promise.allSettled(manualContacts.map(async (c) => {
                console.log(`[Unified] Syncing contact: ${c.email}`);
                try {
                    await axios.post(`${LISTMONK_URL}/api/subscribers`, {
                        email: c.email,
                        name: c.name,
                        status: 'enabled',
                        lists: [parseInt(listId)],
                        attribs: { phone: c.phone }
                    }, { auth: LISTMONK_AUTH, timeout: 5000 });
                    console.log(`[Unified] Created new subscriber: ${c.email}`);
                } catch (err) {
                    if (err.response?.status === 409) {
                        console.log(`[Unified] Subscriber ${c.email} exists, fetching ID...`);
                        try {
                            // Try multiple search formats for maximum compatibility
                            const search = await axios.get(`${LISTMONK_URL}/api/subscribers?query=email='${c.email}'`, { auth: LISTMONK_AUTH });
                            const sub = search.data?.data?.results?.[0];
                            
                            if (sub) {
                                console.log(`[Unified] Found existing sub ID: ${sub.id}. Updating lists...`);
                                const existingLists = (sub.lists || []).map(l => l.id);
                                const newLists = Array.from(new Set([...existingLists, parseInt(listId)]));
                                
                                await axios.put(`${LISTMONK_URL}/api/subscribers/${sub.id}`, {
                                    lists: newLists,
                                    attribs: { ...sub.attribs, phone: c.phone }
                                }, { auth: LISTMONK_AUTH });
                                console.log(`[Unified] Successfully added ${c.email} to list ${listId}`);
                            } else {
                                console.warn(`[Unified] Could not find subscriber ${c.email} via search, even after 409.`);
                            }
                        } catch (inner) {
                            console.error(`[Unified] Failed to update existing sub ${c.email}:`, inner.message);
                        }
                    } else {
                        console.error(`[Unified] Listmonk Error for ${c.email}:`, err.response?.data || err.message);
                    }
                }
            }));
            finalContacts = manualContacts;
        } else {
            // Step 1: Get existing Listmonk subscribers
            console.log(`[Unified] Fetching subscribers from Listmonk List ${listId}...`);
            const subRes = await axios.get(`${LISTMONK_URL}/api/subscribers?list_id=${listId}&per_page=1000`, { auth: LISTMONK_AUTH });
            const subscribers = subRes.data?.data?.results || [];
            
            // Filter only those who have a phone number in attributes (FIXED: removed email prefix fallback)
            finalContacts = subscribers
                .map(s => ({ 
                    phone: (s.attribs?.phone || '').toString().replace(/[^0-9]/g, ''), 
                    name: s.name || 'Friend' 
                }))
                .filter(c => c.phone && c.phone.length >= 10);
            
            console.log(`[Unified] Found ${finalContacts.length} subscribers with valid phone numbers in List ${listId}`);
        }

        if (finalContacts.length > 0) {
            // Step 2: Create WhatsApp campaign
            let campaigns = getDb('campaigns');
            const campId = 'unified_' + Date.now();
            const instances = getDb('instances');
            const defaultInstName = getDefaultInstanceName();
            const targetInstanceName = instanceName || defaultInstName;
            
            let targetApiKey = apiKey;
            if (!targetApiKey && Array.isArray(instances)) {
                const inst = instances.find(i => i.name === targetInstanceName);
                if (inst) targetApiKey = inst.apiKey;
            }
            if (!targetApiKey) targetApiKey = (process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!');

            campaigns[campId] = { 
                name: `${name} [WA]`, 
                status: 'scheduled', 
                scheduledFor: Date.now(), 
                messageTemplate: whatsappTemplate, 
                contacts: finalContacts, 
                instanceName: targetInstanceName, 
                apiKey: targetApiKey, 
                createdAt: new Date().toISOString() 
            };
            saveDb('campaigns', campaigns);
            results.whatsapp = { campId, contacts: finalContacts.length };
        }

        // Step 3: Trigger Listmonk email campaign
        console.log(`[Unified] Creating Listmonk Email Campaign for List ${listId}...`);
        const emailRes = await axios.post(`${LISTMONK_URL}/api/campaigns`, {
            name: `${name} [Email]`, 
            subject: emailSubject || name,
            lists: [parseInt(listId)], 
            template_id: parseInt(emailTemplateId) || 1,
            body: emailBody,
            type: 'regular', 
            content_type: 'richtext'
        }, { auth: LISTMONK_AUTH });
        
        const campIdListmonk = emailRes.data?.data?.id;
        if (campIdListmonk) {
            console.log(`[Unified] Scheduling Listmonk Campaign ${campIdListmonk}...`);
            try {
                // Changing from 'scheduled' to 'running' for immediate delivery
                await axios.put(`${LISTMONK_URL}/api/campaigns/${campIdListmonk}/status`, {
                    status: 'running'
                }, { auth: LISTMONK_AUTH });
            } catch (schedErr) {
                console.error(`[Unified] Failed to schedule campaign ${campIdListmonk}:`, schedErr.response?.data || schedErr.message);
                results.emailError = schedErr.response?.data?.message || schedErr.message;
            }
        }
        
        results.email = emailRes.data;
        res.json({ success: true, results });

    } catch (e) {
        console.error('[Unified Campaign Error]', e.message);
        res.json({ success: false, message: e.message, results });
    }
});

// ─── Initialize SendPulse Bulk Engine ───
}
setupEmailEngine(app, getDb, saveDb);

// Local-only multi-channel journeys. These are explicitly launched campaigns:
// email is sent first, then WhatsApp is attempted only for contacts that have
// not sent a WhatsApp reply after the email stage. No public webhook is needed.
let multiChannelWorkerBusy = false;
async function processMultiChannelJourneys() {
    if (multiChannelWorkerBusy) return;
    multiChannelWorkerBusy = true;
    try {
        const journeys = getDb('multichannel_campaigns') || {};
        const emailCampaigns = getDb('email_campaigns') || {};
        const conversations = getDb('conversations') || {};
        const instanceName = getDefaultInstanceName();
        const apiKey = process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!';
        let changed = false;
        for (const journey of Object.values(journeys)) {
            if (!journey || ['cancelled', 'completed'].includes(journey.status)) continue;
            const emailCampaign = emailCampaigns[journey.emailCampaignId];
            if (!emailCampaign || !['completed', 'cancelled'].includes(emailCampaign.status)) continue;
            if (emailCampaign.status === 'cancelled') { journey.status = 'cancelled'; changed = true; continue; }
            const emailStageAt = journey.emailStageAt || emailCampaign.completedAt || emailCampaign.createdAt;
            journey.emailStageAt = emailStageAt;
            const dueAt = new Date(emailStageAt).getTime() + Math.max(0, Number(journey.delayHours || 24)) * 3600000;
            if (Date.now() < dueAt) { journey.status = 'waiting_for_reply'; changed = true; continue; }
            const completed = new Set(journey.completedJids || []);
            const skipped = new Set(journey.skippedJids || []);
            for (const recipient of journey.contacts || []) {
                const jid = recipient.jid || (String(recipient.phone || '').replace(/\D/g, '') + '@s.whatsapp.net');
                if (!jid || completed.has(jid) || skipped.has(jid)) continue;
                const thread = Array.isArray(conversations[jid]) ? conversations[jid] : [];
                const replied = thread.some(message => !message.fromMe && new Date(message.timestamp || message.createdAt || 0).getTime() >= new Date(emailStageAt).getTime());
                if (replied) { skipped.add(jid); continue; }
                const text = String(journey.whatsappMessage || '').replace(/{{name}}/gi, recipient.name || 'there');
                if (!text.trim()) { skipped.add(jid); continue; }
                const result = await sendSmartMessageCore(jid, instanceName, text, apiKey, [], true, 'campaign');
                if (result?.success) completed.add(jid);
            }
            journey.completedJids = [...completed];
            journey.skippedJids = [...skipped];
            journey.status = completed.size + skipped.size >= (journey.contacts || []).length ? 'completed' : 'sending_whatsapp_followup';
            journey.updatedAt = new Date().toISOString();
            changed = true;
        }
        if (changed) saveDb('multichannel_campaigns', journeys);
    } catch (error) {
        console.error('[Multi-channel] Journey worker failed:', error.message);
    } finally { multiChannelWorkerBusy = false; }
}
setInterval(processMultiChannelJourneys, 60000);
app.post('/api/multichannel/campaigns/:id/cancel', (req, res) => {
    const journeys = getDb('multichannel_campaigns') || {};
    const journey = journeys[req.params.id];
    if (!journey) return res.status(404).json({ success: false, message: 'Journey not found.' });
    journey.status = 'cancelled'; journey.cancelledAt = new Date().toISOString();
    saveDb('multichannel_campaigns', journeys);
    res.json({ success: true, journey });
});
setupSendPulse(app, getDb, saveDb);

async function autoStartEvolution() {
    // Evolution API startup is handled by START_SCHOLARVAULT.bat
    try {
        const axios = require('axios');
        await axios.get((process.env.EVO_API_URL || 'http://localhost:8080'), { timeout: 2000 });
        console.log('[Auto-Start] Evolution API is active on port 8080.');
    } catch (_) {
        console.log('[Auto-Start] Evolution API is initializing or managed by launcher.');
    }
}

async function fetchContactProfilePicture(jid) {
    try {
        const EVO_API_URL = (process.env.EVO_API_URL || 'http://localhost:8080');
        const instName = getDefaultInstanceName();
        const key = (process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!');

        const number = String(jid || '').split('@')[0].replace(/\D/g, '');
        const res = await axios.post(`${EVO_API_URL}/chat/fetchProfilePictureUrl/${instName}`, {
            number
        }, {
            headers: { 'apikey': key }
        });

        const profilePictureUrl = res.data?.profilePictureUrl || res.data?.data?.profilePictureUrl;
        if (profilePictureUrl) {
            let contacts = getDb('contacts');
            if (!contacts[jid]) contacts[jid] = { jid: jid };
            contacts[jid].profilePictureUrl = profilePictureUrl;
            saveDb('contacts', contacts);
            return profilePictureUrl;
        }
    } catch (e) {
        // Ignored
    }
    return null;
}

app.get('/api/contacts/:jid/profile-picture', async (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const url = await fetchContactProfilePicture(jid);
    res.json({ success: Boolean(url), profilePictureUrl: url || null });
});

function extractEvolutionHistoryMessage(record) {
    const payload = record?.message?.message || record?.message;
    if (!payload || typeof payload !== 'object') return null;
    const key = record.key || payload.key || {};
    let text = '';
    let mediaType = null;
    let fileName = null;
    let base64 = null;
    if (payload.conversation) text = payload.conversation;
    else if (payload.extendedTextMessage?.text) text = payload.extendedTextMessage.text;
    else if (payload.imageMessage) { text = payload.imageMessage.caption || '[Image]'; mediaType = 'image'; base64 = payload.imageMessage.base64 || null; }
    else if (payload.videoMessage) { text = payload.videoMessage.caption || '[Video]'; mediaType = 'video'; base64 = payload.videoMessage.base64 || null; }
    else if (payload.audioMessage) { text = '[Voice note]'; mediaType = 'audio'; base64 = payload.audioMessage.base64 || null; }
    else if (payload.documentMessage) { text = payload.documentMessage.caption || `[Document: ${payload.documentMessage.fileName || payload.documentMessage.title || 'file'}]`; mediaType = 'document'; fileName = payload.documentMessage.fileName || payload.documentMessage.title || 'document'; base64 = payload.documentMessage.base64 || null; }
    if (!text && !mediaType) return null;
    return { key, text, mediaType, fileName, base64 };
}

async function importEvolutionHistoryForJid(jid, instanceName, apiKey, limit = 100) {
    const canonicalJid = resolveCanonicalJid(jid);
    const targetJids = new Set([canonicalJid, jid]);
    getLidsForPhone(canonicalJid).forEach(l => targetJids.add(l));
    const EVO_API_URL = process.env.EVO_API_URL || 'http://localhost:8080';
    
    let imported = 0;
    let unavailable = 0;
    let recordsCount = 0;

    for (const queryJid of targetJids) {
        try {
            const response = await axios.post(`${EVO_API_URL}/chat/findMessages/${instanceName}`, {
                where: { key: { remoteJid: queryJid } }, page: 1, limit: Math.min(Math.max(Number(limit) || 100, 1), 250)
            }, { headers: { apikey: apiKey }, timeout: 30000 });
            const messageSet = response.data?.messages || response.data || {};
            const records = Array.isArray(messageSet.records) ? messageSet.records : (Array.isArray(messageSet) ? messageSet : []);
            recordsCount += records.length;
            
            for (const record of records) {
                if (record.key?.remoteJidAlt && queryJid.includes('@lid')) {
                    recordLidMapping(queryJid, record.key.remoteJidAlt);
                }
                const parsed = extractEvolutionHistoryMessage(record);
                if (!parsed) { unavailable++; continue; }
                const sourceTimestamp = isoFromWhatsAppTimestamp(record.messageTimestamp || parsed.key?.messageTimestamp) || new Date().toISOString();
                let mediaUrl = null;
                let base64 = parsed.base64;
                if (parsed.mediaType && !base64 && parsed.key?.id) {
                    try {
                        const mediaResponse = await axios.post(`${EVO_API_URL}/chat/getBase64FromMediaMessage/${instanceName}`, { message: { key: parsed.key } }, { headers: { apikey: apiKey }, timeout: 15000 });
                        base64 = mediaResponse.data?.base64 || null;
                    } catch (_) { /* Keep the message even if Evolution no longer has the media blob. */ }
                }
                if (base64) {
                    try {
                        const uploadsDir = path.join(__dirname, 'uploads');
                        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
                        const extension = parsed.mediaType === 'image' ? '.png' : parsed.mediaType === 'video' ? '.mp4' : parsed.mediaType === 'audio' ? '.ogg' : '';
                        const cleanName = (parsed.fileName || `history-${parsed.key?.id || Date.now()}${extension}`).replace(/[^a-zA-Z0-9._-]/g, '_');
                        const target = `${Date.now()}-${cleanName}`;
                        fs.writeFileSync(path.join(uploadsDir, target), Buffer.from(String(base64).replace(/^data:[^,]+,/, ''), 'base64'));
                        mediaUrl = `/uploads/${target}`;
                    } catch (_) { /* Thread text still remains available if local media caching fails. */ }
                }
                upsertThreadMessage(canonicalJid, {
                    id: parsed.key?.id || record.id,
                    messageId: parsed.key?.id || record.id,
                    fromMe: Boolean(parsed.key?.fromMe),
                    direction: parsed.key?.fromMe ? 'out' : 'in',
                    text: parsed.text,
                    messageType: parsed.mediaType || record.messageType || 'text',
                    mediaType: parsed.mediaType,
                    mediaUrl,
                    fileName: parsed.fileName,
                    name: parsed.key?.fromMe ? 'Me' : resolveContactIdentity(canonicalJid, getDb('contacts'), [record.pushName]),
                    status: strongestEvolutionReceipt(record.MessageUpdate || record.messageUpdate || record.update?.status || record.status || []),
                    timestamp: sourceTimestamp
                });
                imported++;
            }
        } catch (err) {
            console.warn(`[History Sync] Error querying ${queryJid}:`, err.message);
        }
    }
    return { records: recordsCount, imported, unavailable };
}

// Refresh only receipt/reaction metadata when an operator opens a thread.
// Evolution's MessageUpdate history is not chronological, so keep the highest
// observed state; a later SERVER_ACK must never overwrite READ.
async function refreshEvolutionThreadMeta(jid) {
    const instanceName = getDefaultInstanceName();
    const apiKey = process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!';
    const EVO_API_URL = process.env.EVO_API_URL || 'http://localhost:8080';
    const canonicalJid = resolveCanonicalJid(jid);
    const targetJids = new Set([canonicalJid, jid]);
    getLidsForPhone(canonicalJid).forEach(l => targetJids.add(l));
    
    const threads = getDb('conversations');
    const thread = threads[canonicalJid] || [];
    let changed = false;

    for (const targetJid of targetJids) {
        try {
            const response = await axios.post(`${EVO_API_URL}/chat/findMessages/${instanceName}`, { where: { key: { remoteJid: targetJid } }, page: 1, limit: 100 }, { headers: { apikey: apiKey }, timeout: 12000 });
            const messageSet = response.data?.messages || response.data || {};
            const records = Array.isArray(messageSet.records) ? messageSet.records : (Array.isArray(messageSet) ? messageSet : []);
            
            for (const record of records) {
                if (record.key?.remoteJidAlt && targetJid.includes('@lid')) {
                    recordLidMapping(targetJid, record.key.remoteJidAlt);
                }
                const payload = record.message || record.messages || {};
                const reaction = extractReactionMessage(record) || extractReactionMessage(payload);
                if (reaction?.key?.id) {
                    if (applyReactionToConversation(threads, reaction, canonicalJid)) changed = true;
                    continue;
                }
                const messageId = record.key?.id || record.message?.key?.id || record.id;
                const target = thread.find(item => (item.id || item.messageId) === messageId);
                if (target) {
                    const received = strongestEvolutionReceipt(
                        record.MessageUpdate || record.messageUpdate || record.update?.status || record.status || record.message?.status || []
                    );
                    const current = normalizeEvolutionReceipt(target.status);
                    if (RECEIPT_RANK[received] > RECEIPT_RANK[current]) { target.status = received; changed = true; }
                } else {
                    const parsed = extractEvolutionHistoryMessage(record);
                    if (parsed) {
                        const sourceTimestamp = isoFromWhatsAppTimestamp(record.messageTimestamp || parsed.key?.messageTimestamp) || new Date().toISOString();
                        thread.push({
                            id: messageId,
                            messageId: messageId,
                            fromMe: Boolean(parsed.key?.fromMe),
                            direction: parsed.key?.fromMe ? 'out' : 'in',
                            text: parsed.text,
                            messageType: parsed.mediaType || record.messageType || 'text',
                            mediaType: parsed.mediaType,
                            mediaUrl: null,
                            fileName: parsed.fileName,
                            name: parsed.key?.fromMe ? 'Me' : resolveContactIdentity(canonicalJid, getDb('contacts'), [record.pushName]),
                            status: strongestEvolutionReceipt(record.MessageUpdate || record.messageUpdate || record.update?.status || record.status || []),
                            timestamp: sourceTimestamp
                        });
                        changed = true;
                    }
                }
            }
        } catch (_) {}
    }
    
    if (changed) {
        thread.sort((a, b) => (new Date(a.timestamp || 0).getTime() || 0) - (new Date(b.timestamp || 0).getTime() || 0));
        threads[canonicalJid] = thread;
        saveDb('conversations', threads);
        
        // Update inbox snippet so sidebar stays in sync
        const lastMsg = thread[thread.length - 1];
        if (lastMsg) {
            let inbox = getDb('inbox');
            const inIdx = inbox.findIndex(m => m.jid === canonicalJid);
            if (inIdx >= 0) {
                inbox[inIdx].message = lastMsg.text || (lastMsg.mediaType ? `[${lastMsg.mediaType}]` : inbox[inIdx].message);
                inbox[inIdx].lastMessageAt = lastMsg.timestamp;
                inbox[inIdx].timestamp = lastMsg.timestamp;
                saveDb('inbox', canonicalizeInboxRows(inbox));
            }
        }
    }
    return changed;
}

app.post('/api/inbox/history-sync', async (req, res) => {
    try {
        const instanceName = getDefaultInstanceName();
        const apiKey = process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!';
        const requested = Array.isArray(req.body?.jids) ? req.body.jids : [];
        const jids = (requested.length ? requested : canonicalizeInboxRows(getDb('inbox')).map(item => item.jid))
            .map(normalizeJid).filter(Boolean).filter(jid => !jid.includes('@g.us')).slice(0, 100);
        let records = 0, imported = 0, unavailable = 0;
        for (const jid of jids) {
            const result = await importEvolutionHistoryForJid(jid, instanceName, apiKey, req.body?.limit || 100);
            records += result.records; imported += result.imported; unavailable += result.unavailable;
        }
        res.json({ success: true, chats: jids.length, records, imported, unavailable, message: unavailable ? 'Some Evolution records have no stored payload, so their original text/media cannot be recovered from this instance.' : 'Stored WhatsApp history imported.' });
    } catch (error) {
        res.status(502).json({ success: false, message: error.response?.data?.message || error.message || 'WhatsApp history sync failed' });
    }
});

async function syncOfflineMessages() {
    try {
        console.log('[Offline Sync] Starting sync process for missed messages...');
        const axios = require('axios');
        const EVO_API_URL = (process.env.EVO_API_URL || 'http://localhost:8080');
        const instName = getDefaultInstanceName();
        const key = (process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!');
        
        let inbox = getDb('inbox');
        let contacts = getDb('contacts');
        
        // Ensure Evolution API is up before syncing
        await axios.get(`${EVO_API_URL}`, { timeout: 3000 });
        
        // Fetch all recent chats from phone
        const chatsRes = await axios.post(`${EVO_API_URL}/chat/findChats/${instName}`, {}, { headers: { 'apikey': key } });
        const chats = chatsRes.data || [];
        
        let syncCount = 0;
        let contactsModified = false;
        
        for (const chat of chats) {
            const rawJid = normalizeJid(chat.remoteJid);
            if (!rawJid || rawJid.includes('@g.us') || rawJid === 'status@broadcast') continue;
            
            // Check for LID mapping from chat's last message or resolve from known mappings
            const altJid = chat.lastMessage?.key?.remoteJidAlt;
            if (rawJid.includes('@lid') && altJid && altJid.includes('@s.whatsapp.net')) {
                recordLidMapping(rawJid, altJid);
            } else if (rawJid.includes('@lid') && !resolveCanonicalJid(rawJid).includes('@s.whatsapp.net')) {
                // Try quick lookup of recent messages to uncover remoteJidAlt
                try {
                    const msgCheck = await axios.post(`${EVO_API_URL}/chat/findMessages/${instName}`, {
                        where: { key: { remoteJid: rawJid } }, limit: 5
                    }, { headers: { apikey: key }, timeout: 4000 });
                    const records = msgCheck.data?.messages?.records || msgCheck.data?.records || msgCheck.data || [];
                    for (const r of records) {
                        if (r.key?.remoteJidAlt && r.key.remoteJidAlt.includes('@s.whatsapp.net')) {
                            recordLidMapping(rawJid, r.key.remoteJidAlt);
                            break;
                        }
                    }
                } catch (_) {}
            }
            
            const jid = resolveCanonicalJid(rawJid, altJid);
            
            // Extract best name
            let name = chat.pushName || jid.split('@')[0];
            if (chat.lastMessage && chat.lastMessage.pushName && chat.lastMessage.pushName !== 'Você') {
                name = chat.lastMessage.pushName;
            }
            name = resolveContactIdentity(jid, contacts, [chat.lastMessage?.pushName, chat.pushName, name]);
            
            // Ensure we have profile picture
            if (!contacts[jid]) {
                contacts[jid] = { jid: jid };
                contactsModified = true;
            }
            if (chat.profilePicUrl && contacts[jid].profilePictureUrl !== chat.profilePicUrl) {
                contacts[jid].profilePictureUrl = chat.profilePicUrl;
                contactsModified = true;
            } else if (!contacts[jid].profilePictureUrl) {
                const picUrl = await fetchContactProfilePicture(jid);
                if (picUrl) {
                    contacts[jid].profilePictureUrl = picUrl;
                    contactsModified = true;
                }
            }
            
            // Reconcile both new and existing chats
            const inInbox = inbox.find(m => m.jid === jid);
            if (chat.lastMessage) {
                let text = 'Media/System Message';
                let mediatype = null;
                if (chat.lastMessage.message) {
                    const msgObj = chat.lastMessage.message;
                    if (msgObj.conversation) text = msgObj.conversation;
                    else if (msgObj.extendedTextMessage) text = msgObj.extendedTextMessage.text;
                    else if (msgObj.imageMessage) { text = '📷 Image: ' + (msgObj.imageMessage.caption || ''); mediatype = 'image'; }
                    else if (msgObj.videoMessage) { text = '🎥 Video: ' + (msgObj.videoMessage.caption || ''); mediatype = 'video'; }
                    else if (msgObj.audioMessage) { text = '🎤 Voice/Audio Message'; mediatype = 'audio'; }
                    else if (msgObj.documentMessage) { text = '📄 Document: ' + (msgObj.documentMessage.fileName || ''); mediatype = 'document'; }
                }
                
                const timestamp = isoFromWhatsAppTimestamp(chat.lastMessage.messageTimestamp) || chat.updatedAt || new Date().toISOString();
                const oldTime = new Date(inInbox?.lastMessageAt || inInbox?.timestamp || 0).getTime() || 0;
                const newTime = new Date(timestamp).getTime() || 0;
                
                // Backfill the message into conversations thread
                const msgId = chat.lastMessage.key?.id || chat.lastMessage.id;
                if (msgId) {
                    upsertThreadMessage(jid, {
                        id: msgId,
                        messageId: msgId,
                        fromMe: Boolean(chat.lastMessage.key?.fromMe),
                        direction: chat.lastMessage.key?.fromMe ? 'out' : 'in',
                        text: text,
                        messageType: mediatype || 'text',
                        mediaType: mediatype,
                        name: chat.lastMessage.key?.fromMe ? 'Me' : name,
                        status: strongestEvolutionReceipt(chat.lastMessage.MessageUpdate || chat.lastMessage.update?.status || chat.lastMessage.status || []),
                        timestamp
                    });
                }
                
                if (!inInbox || newTime >= oldTime) {
                    inbox = inbox.filter(m => m.jid !== jid);
                    inbox.push({
                        jid: jid,
                        name: name,
                        message: text,
                        sentiment: 'Neutral',
                        timestamp,
                        lastMessageAt: timestamp
                    });
                    syncCount++;
                }
            }
        }
        
        if (contactsModified) saveDb('contacts', contacts);
        
        if (syncCount > 0) {
            saveDb('inbox', canonicalizeInboxRows(inbox, contacts));
            if (typeof io !== 'undefined' && io) io.emit('sync_complete', { count: syncCount });
        }
        console.log(`[Offline Sync] Complete! Backfilled ${syncCount} chats.`);
        return { success: true, synced: syncCount };
    } catch (e) {
        console.error('[Offline Sync] Failed to sync messages:', e.message);
        return { success: false, message: e.message };
    }
}

io.on('connection', (socket) => {
    console.log('[WebSocket] Client connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('[WebSocket] Client disconnected:', socket.id);
    });
});

// Keep the receipt webhook enabled without replacing the user's URL or the
// already-working inbound events. Delivery/read ticks cannot update if
// Evolution is not subscribed to MESSAGES_UPDATE.
async function ensureEvolutionReceiptWebhook() {
    try {
        const instanceName = getDefaultInstanceName();
        const apiUrl = process.env.EVO_API_URL || 'http://localhost:8080';
        const apiKey = process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!';
        const headers = { apikey: apiKey };
        const current = await axios.get(`${apiUrl}/webhook/find/${instanceName}`, { headers, timeout: 5000 });
        const webhook = current.data || {};
        const events = [...new Set([...(Array.isArray(webhook.events) ? webhook.events : []), 'MESSAGES_UPDATE'])];
        if (events.length === (webhook.events || []).length) return;
        await axios.post(`${apiUrl}/webhook/set/${instanceName}`, { webhook: {
            url: webhook.url || `http://localhost:${PORT}/webhook`,
            enabled: webhook.enabled !== false,
            events,
            webhookByEvents: webhook.webhookByEvents === true,
            webhookBase64: webhook.webhookBase64 !== false
        } }, { headers, timeout: 5000 });
        console.log('[Webhook] Enabled MESSAGES_UPDATE for sent/delivered/read receipts.');
    } catch (error) {
        console.warn('[Webhook] Could not verify receipt events:', error.response?.data?.message || error.message);
    }
}

server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 ScholarVault Campaign Command Center`);
    console.log(`=========================================`);
    console.log(`Dashboard available at: http://localhost:${PORT}`);
    console.log(`Webhook listener ACTIVE on port ${PORT}`);
    setTimeout(ensureEvolutionReceiptWebhook, 1200);
    
    // Wait for Evolution API and then sync offline messages
    setTimeout(() => {
        autoStartEvolution();
        setTimeout(syncOfflineMessages, 5000);
    }, 3000);
});
