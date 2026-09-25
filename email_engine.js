const axios = require('axios');

// Native email delivery for ScholarVault CRM. Brevo is the primary provider;
// SendPulse remains available as a separately configured fallback queue.
module.exports = function setupEmailEngine(app, getDb, saveDb, options = {}) {
    const BREVO_API = 'https://api.brevo.com/v3';
    let workerBusy = false;

    const nowIso = () => new Date().toISOString();
    const emailOk = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
    const id = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const getSettings = () => ({ ...(getDb('settings_brevo') || {}), apiKey: process.env.BREVO_API_KEY || (getDb('settings_brevo') || {}).apiKey || '' });
    const getCampaigns = () => getDb('email_campaigns') || {};
    const getTemplates = () => { const value = getDb('email_templates'); return Array.isArray(value) ? value : []; };
    const getEvents = () => { const value = getDb('email_events'); return Array.isArray(value) ? value : []; };
    const getContacts = () => getDb('contacts') || {};
    const getLists = () => { const value = getDb('email_lists'); return Array.isArray(value) ? value : []; };
    const contactKeyForEmail = email => `email:${encodeURIComponent(String(email || '').trim().toLowerCase())}`;
    const normalPhone = value => String(value || '').replace(/\D/g, '');
    const addActivity = (contact, type, label) => {
        contact.emailActivity = Array.isArray(contact.emailActivity) ? contact.emailActivity : [];
        contact.emailActivity.unshift({ id: id('emailact'), type, label, createdAt: nowIso() });
        contact.emailActivity = contact.emailActivity.slice(0, 100);
    };

    function importEmailContacts(rows = [], { listId = '', merge = true } = {}) {
        const contacts = getContacts(); let added = 0, merged = 0, skipped = 0;
        for (const row of rows) {
            const email = String(row?.email || '').trim().toLowerCase();
            if (!emailOk(email)) { skipped++; continue; }
            const phone = normalPhone(row.phone);
            const jid = phone.length >= 10 ? `${phone}@s.whatsapp.net` : '';
            const existingKey = jid && contacts[jid] ? jid : Object.keys(contacts).find(key => String(contacts[key]?.email || '').toLowerCase() === email) || contactKeyForEmail(email);
            const previous = contacts[existingKey];
            if (previous && !merge) { skipped++; continue; }
            const next = previous || { jid: jid || existingKey, channel: jid ? 'WhatsApp + Email' : 'Email only', createdAt: nowIso() };
            if (!previous) added++; else merged++;
            if (!next.email) next.email = email;
            if (row.name && (!next.name || /^unknown|contact$/i.test(next.name))) next.name = String(row.name).trim();
            if (jid && !next.phone) next.phone = phone;
            if (row.country && !next.country) next.country = String(row.country).trim();
            if (row.leadSource && !next.leadSource) next.leadSource = String(row.leadSource).trim();
            if (row.optIn !== undefined) { next.emailOptIn = Boolean(row.optIn); next.optIn = Boolean(row.optIn); }
            next.emailStatus = String(row.emailStatus || next.emailStatus || 'subscribed').toLowerCase();
            next.tags = [...new Set([...(Array.isArray(next.tags) ? next.tags : []), ...(Array.isArray(row.tags) ? row.tags : String(row.tags || '').split(/[|,]/).map(x => x.trim()).filter(Boolean))])];
            next.emailLists = [...new Set([...(Array.isArray(next.emailLists) ? next.emailLists : []), ...(listId ? [listId] : [])])];
            addActivity(next, previous ? 'email_merged' : 'email_imported', previous ? 'Email contact merged' : 'Email contact imported');
            contacts[existingKey] = next;
            if (jid && existingKey !== jid) { contacts[jid] = next; delete contacts[existingKey]; }
        }
        saveDb('contacts', contacts); return { added, merged, skipped, contacts };
    }

    function safeSettings() {
        const s = getSettings();
        return {
            configured: Boolean(s.apiKey),
            apiKey: s.apiKey ? `${s.apiKey.slice(0, 6)}…` : '',
            senderName: s.senderName || 'ScholarVault',
            senderEmail: s.senderEmail || '',
            dailyLimit: Math.max(1, Number(s.dailyLimit || 300)),
            webhookUrl: s.webhookUrl || ''
        };
    }

    function applyContactEmailStatus(contact, event) {
        const type = String(event.event || event.type || '').toLowerCase();
        if (['unsubscribed', 'unsubscribe', 'spam'].includes(type)) {
            contact.emailStatus = 'unsubscribed';
            contact.emailOptIn = false;
        } else if (['hard_bounce', 'soft_bounce', 'bounce'].includes(type)) {
            contact.emailStatus = type === 'soft_bounce' ? 'bounced' : 'invalid';
        } else if (type === 'delivered') contact.emailStatus = contact.emailStatus || 'subscribed';
        contact.emailStatusUpdatedAt = nowIso();
    }

    function eligibleAudience(candidates, { recentDays = 30, requireOptIn = true } = {}) {
        const contacts = getContacts();
        const seen = new Set();
        const result = { eligible: [], invalid: [], unsubscribed: [], duplicate: [], recent: [], missingOptIn: [] };
        const recentMs = Math.max(0, Number(recentDays)) * 86400000;
        const campaigns = Object.values(getCampaigns());
        for (const raw of candidates || []) {
            const email = String(raw?.email || '').trim().toLowerCase();
            if (!emailOk(email)) { result.invalid.push(raw?.email || 'Unknown'); continue; }
            if (seen.has(email)) { result.duplicate.push(email); continue; }
            seen.add(email);
            const contact = raw.jid ? contacts[raw.jid] : Object.values(contacts).find(c => String(c.email || '').toLowerCase() === email) || {};
            const optIn = raw.emailOptIn === true || contact.emailOptIn === true || contact.optIn === true;
            const status = String(raw.emailStatus || contact.emailStatus || '').toLowerCase();
            if (['unsubscribed', 'bounced', 'invalid', 'suppressed', 'spam'].includes(status)) { result.unsubscribed.push(email); continue; }
            if (requireOptIn && !optIn) { result.missingOptIn.push(email); continue; }
            const recentlySent = campaigns.some(c => Array.isArray(c.audience) && c.audience.some(a => a.email === email) && new Date(c.createdAt || 0).getTime() > Date.now() - recentMs);
            if (recentlySent) result.recent.push(email);
            result.eligible.push({
                email,
                name: raw.name || contact.name || 'Researcher',
                jid: raw.jid || contact.jid || '',
                phone: raw.phone || contact.phone || '',
                country: raw.country || contact.country || '',
                tags: raw.tags || contact.tags || [],
                emailOptIn: optIn
            });
        }
        return result;
    }

    function htmlFor(contact, html) {
        return String(html || '')
            .replace(/{{\s*name\s*}}/gi, contact.name || 'Researcher')
            .replace(/{{\s*email\s*}}/gi, contact.email || '');
    }

    function emailHtmlFor(contact, source) {
        const merged = htmlFor(contact, source);
        // The composer accepts both HTML and normal multi-line writing. Convert
        // ordinary text into safe HTML so the preview and delivered email keep
        // the author’s paragraph breaks.
        if (/<\/?[a-z][^>]*>/i.test(merged)) return merged;
        return merged.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
    }

    async function sendBrevo(contact, campaign) {
        const s = getSettings();
        if (!s.apiKey) throw new Error('Brevo API key is not configured. Add it in Email settings.');
        if (!emailOk(campaign.senderEmail || s.senderEmail)) throw new Error('Choose a verified Brevo sender before sending.');
        const payload = {
            sender: { name: campaign.senderName || s.senderName || 'ScholarVault', email: campaign.senderEmail || s.senderEmail },
            to: [{ email: contact.email, name: contact.name || 'Researcher' }],
            subject: htmlFor(contact, campaign.subject),
            htmlContent: emailHtmlFor(contact, campaign.htmlBody),
            textContent: htmlFor(contact, campaign.textBody || campaign.htmlBody.replace(/<[^>]*>/g, ' ')),
            tags: ['scholarvault-crm', campaign.id]
        };
        const response = await axios.post(`${BREVO_API}/smtp/email`, payload, { headers: { 'api-key': s.apiKey }, timeout: 30000 });
        return response.data;
    }

    async function processEmailCampaigns() {
        if (workerBusy) return;
        workerBusy = true;
        try {
            const campaigns = getCampaigns();
            const settings = getSettings();
            const limit = Math.max(1, Number(settings.dailyLimit || 300));
            const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
            const sentToday = Object.values(campaigns).reduce((count, campaign) => count + (campaign.delivery || []).filter(d => ['accepted','sent'].includes(d.status) && new Date(d.sentAt || 0) >= dayStart).length, 0);
            let remaining = Math.max(0, limit - sentToday);
            for (const campaign of Object.values(campaigns).sort((a, b) => new Date(a.scheduledFor || a.createdAt) - new Date(b.scheduledFor || b.createdAt))) {
                if (!['queued', 'sending'].includes(campaign.status) || new Date(campaign.scheduledFor || 0).getTime() > Date.now()) continue;
                if (!remaining) { campaign.status = 'paused'; campaign.pauseReason = 'Brevo daily capacity reached'; continue; }
                campaign.status = 'sending';
                campaign.startedAt = campaign.startedAt || nowIso();
                campaign.delivery = Array.isArray(campaign.delivery) ? campaign.delivery : campaign.audience.map(contact => ({ email: contact.email, status: 'pending' }));
                for (const delivery of campaign.delivery) {
                    if (!remaining || campaign.status === 'cancelled' || delivery.status !== 'pending') break;
                    const contact = campaign.audience.find(c => c.email === delivery.email);
                    try {
                        const response = await sendBrevo(contact, campaign);
                        delivery.status = 'accepted'; delivery.sentAt = nowIso(); delivery.providerMessageId = response.messageId || response.messageIds?.[0] || '';
                        remaining--;
                    } catch (error) {
                        delivery.status = 'failed'; delivery.error = error.response?.data?.message || error.response?.data?.code || error.message;
                    }
                }
            const pending = campaign.delivery.some(d => d.status === 'pending');
                if (!pending) { campaign.status = 'completed'; campaign.completedAt = nowIso(); }
                else if (!remaining) { campaign.status = 'paused'; campaign.pauseReason = 'Brevo daily capacity reached'; }
            }
            saveDb('email_campaigns', campaigns);
        } finally { workerBusy = false; }
    }

    app.get('/api/email/settings', (req, res) => res.json({ success: true, settings: safeSettings() }));
    app.get('/api/email/tracking-status', (req, res) => res.json({ success: true, enabled: false, message: 'Local mode records API accepted, sent, failed, and cancelled states. Delivery, opens, clicks, bounces, and unsubscribes require an intentionally configured public Brevo webhook.' }));
    app.get('/api/email/contacts', (req, res) => {
        const q = String(req.query.q || '').toLowerCase(); const status = String(req.query.status || '').toLowerCase(); const listId = String(req.query.list || '');
        const contacts = Object.entries(getContacts()).map(([key, contact]) => ({ key, ...contact })).filter(contact => contact.email && (!q || [contact.name, contact.email, contact.phone, ...(contact.tags || [])].join(' ').toLowerCase().includes(q)) && (!status || String(contact.emailStatus || 'subscribed').toLowerCase() === status) && (!listId || (contact.emailLists || []).includes(listId)));
        res.json({ success: true, contacts, lists: getLists() });
    });
    app.post('/api/email/contacts/import', (req, res) => {
        const body = req.body || {}; const rows = (Array.isArray(body.contacts) ? body.contacts : []).map(row => ({ ...row, email: row.email || row.Email || '', name: row.name || row.Name || '', phone: row.phone || row.Phone || '', country: row.country || row.Country || '', tags: row.tags || row.Tags || '', optIn: row.optIn ?? row.OptIn ?? row['opt-in'], leadSource: row.leadSource || row.LeadSource || '', emailStatus: row.emailStatus || row.EmailStatus || row.Status || '' })); const result = importEmailContacts(rows, { listId: body.listId, merge: body.merge !== false });
        res.json({ success: true, ...result, count: Object.values(result.contacts).filter(c => c.email).length });
    });
    app.post('/api/email/contacts/:key', (req, res) => {
        const key = decodeURIComponent(req.params.key); const contacts = getContacts(); const contact = contacts[key];
        if (!contact) return res.status(404).json({ success: false, message: 'Email contact not found.' });
        const body = req.body || {}; for (const field of ['name','email','phone','country','leadSource','emailStatus','emailOptIn']) if (body[field] !== undefined) contact[field] = field === 'emailOptIn' ? Boolean(body[field]) : String(body[field] || '');
        if (body.tags !== undefined) contact.tags = Array.isArray(body.tags) ? body.tags.filter(Boolean) : [];
        if (body.emailLists !== undefined) contact.emailLists = Array.isArray(body.emailLists) ? body.emailLists.filter(Boolean) : [];
        addActivity(contact, 'email_updated', 'Email contact updated'); saveDb('contacts', contacts); res.json({ success: true, contact });
    });
    app.post('/api/email/contacts/bulk', (req, res) => {
        const body = req.body || {}; const contacts = getContacts(); const keys = Array.isArray(body.keys) ? body.keys : [];
        keys.forEach(key => { const contact = contacts[key]; if (!contact) return; if (body.emailStatus) contact.emailStatus = String(body.emailStatus); if (body.emailOptIn !== undefined) contact.emailOptIn = Boolean(body.emailOptIn); if (body.listId) contact.emailLists = [...new Set([...(contact.emailLists || []), body.listId])]; addActivity(contact, 'email_bulk_updated', 'Email contact bulk updated'); });
        saveDb('contacts', contacts); res.json({ success: true });
    });
    app.get('/api/email/contacts/export', (req, res) => {
        const rows = Object.values(getContacts()).filter(c => c.email).map(c => [c.name || '', c.email || '', c.phone || '', c.country || '', (c.tags || []).join('|'), c.emailOptIn ? 'Yes' : 'No', c.emailStatus || 'subscribed', c.leadSource || '']);
        const quote = value => `"${String(value).replace(/"/g, '""')}"`; const csv = [['Name','Email','Phone','Country','Tags','OptIn','Status','LeadSource'], ...rows].map(row => row.map(quote).join(',')).join('\r\n');
        res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="scholarvault-email-contacts.csv"'); res.send(csv);
    });
    app.get('/api/email/lists', (req, res) => res.json({ success: true, lists: getLists() }));
    app.post('/api/email/lists', (req, res) => { const lists = getLists(); const name = String(req.body?.name || '').trim(); if (!name) return res.status(400).json({ success: false, message: 'List name is required.' }); const list = { id: id('elist'), name, createdAt: nowIso() }; lists.unshift(list); saveDb('email_lists', lists); res.json({ success: true, list }); });
    app.delete('/api/email/lists/:id', (req, res) => { saveDb('email_lists', getLists().filter(list => list.id !== req.params.id)); res.json({ success: true }); });
    app.post('/api/email/settings', (req, res) => {
        const old = getSettings();
        const input = req.body || {};
        const next = {
            ...old,
            apiKey: input.apiKey && !String(input.apiKey).includes('…') ? String(input.apiKey).trim() : old.apiKey,
            senderName: String(input.senderName || old.senderName || 'ScholarVault').trim(),
            senderEmail: String(input.senderEmail || old.senderEmail || '').trim(),
            dailyLimit: Math.max(1, Number(input.dailyLimit || old.dailyLimit || 300)),
            webhookUrl: String(input.webhookUrl || old.webhookUrl || '').trim()
        };
        saveDb('settings_brevo', next);
        res.json({ success: true, settings: safeSettings() });
    });
    app.post('/api/email/test-connection', async (req, res) => {
        try {
            const s = getSettings();
            if (!s.apiKey) throw new Error('Brevo API key is not configured.');
            const response = await axios.get(`${BREVO_API}/account`, { headers: { 'api-key': s.apiKey }, timeout: 15000 });
            res.json({ success: true, account: response.data.email || response.data.companyName || 'Connected' });
        } catch (error) { res.status(400).json({ success: false, message: error.response?.data?.message || error.message }); }
    });
    app.get('/api/email/templates', (req, res) => res.json({ success: true, templates: getTemplates() }));
    app.post('/api/email/templates', (req, res) => {
        const body = req.body || {}; const templates = getTemplates();
        const template = { id: body.id || id('emailtpl'), name: String(body.name || 'Untitled email').trim(), subject: String(body.subject || ''), htmlBody: String(body.htmlBody || ''), textBody: String(body.textBody || ''), updatedAt: nowIso() };
        const index = templates.findIndex(t => t.id === template.id);
        if (index >= 0) templates[index] = template; else templates.unshift(template);
        saveDb('email_templates', templates); res.json({ success: true, template });
    });
    app.delete('/api/email/templates/:id', (req, res) => { saveDb('email_templates', getTemplates().filter(t => t.id !== req.params.id)); res.json({ success: true }); });
    app.post('/api/email/audience/preflight', (req, res) => {
        const body = req.body || {}; const raw = Array.isArray(body.contacts) ? body.contacts : [];
        const report = eligibleAudience(raw, { recentDays: body.recentDays, requireOptIn: body.requireOptIn !== false });
        const s = getSettings(); const daily = Math.max(1, Number(s.dailyLimit || 300));
        res.json({ success: true, eligibleContacts: report.eligible, counts: Object.fromEntries(Object.entries(report).map(([key, value]) => [key, Array.isArray(value) ? value.length : value])), estimatedDays: Math.max(1, Math.ceil(report.eligible.length / daily)), providerCapacity: daily });
    });
    app.post('/api/email/send-test', async (req, res) => {
        try {
            const body = req.body || {}; const contact = { email: body.recipient, name: body.name || 'Test recipient' };
            if (!emailOk(contact.email)) throw new Error('Enter a valid test email address.');
            const response = await sendBrevo(contact, { id: 'test', subject: `[TEST] ${body.subject || ''}`, htmlBody: body.htmlBody || '', textBody: body.textBody || '', senderName: body.senderName, senderEmail: body.senderEmail });
            res.json({ success: true, messageId: response.messageId || '' });
        } catch (error) { res.status(400).json({ success: false, message: error.response?.data?.message || error.message }); }
    });
    app.get('/api/email/campaigns', (req, res) => res.json({ success: true, campaigns: getCampaigns() }));
    app.post('/api/email/campaigns', (req, res) => {
        const body = req.body || {}; const preflight = eligibleAudience(body.contacts || [], { recentDays: body.recentDays, requireOptIn: body.requireOptIn !== false });
        if (!String(body.name || '').trim() || !String(body.subject || '').trim() || !String(body.htmlBody || '').trim()) return res.status(400).json({ success: false, message: 'Campaign name, subject and HTML content are required.' });
        if (!preflight.eligible.length) return res.status(400).json({ success: false, message: 'No eligible opted-in email recipients remain after preflight.' });
        const campaigns = getCampaigns(); const campaign = { id: id('email'), name: body.name.trim(), provider: body.provider || 'brevo', senderName: body.senderName || '', senderEmail: body.senderEmail || '', subject: body.subject, htmlBody: body.htmlBody, textBody: body.textBody || '', audience: preflight.eligible, delivery: preflight.eligible.map(c => ({ email: c.email, status: 'pending' })), scheduledFor: body.scheduledFor || nowIso(), status: 'queued', createdAt: nowIso(), preflight: { counts: Object.fromEntries(Object.entries(preflight).map(([key, value]) => [key, Array.isArray(value) ? value.length : value])) } };
        campaigns[campaign.id] = campaign; saveDb('email_campaigns', campaigns); setImmediate(processEmailCampaigns); res.json({ success: true, campaign });
    });
    app.post('/api/email/campaigns/:id/cancel', (req, res) => {
        const campaigns = getCampaigns(); const campaign = campaigns[req.params.id];
        if (!campaign) return res.status(404).json({ success: false, message: 'Email campaign not found.' });
        campaign.status = 'cancelled'; campaign.cancelledAt = nowIso(); campaign.delivery?.forEach(d => { if (d.status === 'pending') d.status = 'cancelled'; }); saveDb('email_campaigns', campaigns);
        res.json({ success: true });
    });
    app.get('/api/email/ab-tests', (req, res) => res.json({ success: true, tests: getDb('email_ab_tests') }));
    app.post('/api/email/ab-tests', (req, res) => {
        const body = req.body || {}; const variants = Array.isArray(body.variants) ? body.variants.filter(v => String(v.subject || '').trim() && String(v.htmlBody || '').trim()) : [];
        if (!String(body.name || '').trim() || variants.length < 2) return res.status(400).json({ success: false, message: 'Give the experiment a name and two complete variants.' });
        const audience = eligibleAudience(body.contacts || [], { recentDays: body.recentDays, requireOptIn: body.requireOptIn !== false }).eligible;
        if (audience.length < 2) return res.status(400).json({ success: false, message: 'At least two eligible opted-in contacts are required for an email A/B test.' });
        const test = { id: id('emailab'), name: String(body.name).trim(), variants, audience, splitPercent: Math.min(50, Math.max(10, Number(body.splitPercent || 20))), status: 'draft', winner: '', createdAt: nowIso(), notes: 'Local mode tracks API acceptance and failures only. Choose the winner manually until Brevo webhook tracking is enabled.' };
        const tests = getDb('email_ab_tests'); tests.unshift(test); saveDb('email_ab_tests', tests); res.json({ success: true, test });
    });
    app.post('/api/email/ab-tests/:id/winner', (req, res) => {
        const tests = getDb('email_ab_tests'); const test = tests.find(item => item.id === req.params.id); if (!test) return res.status(404).json({ success: false, message: 'Email A/B test not found.' });
        const variantId = String(req.body?.variantId || ''); if (!test.variants.some(v => v.id === variantId)) return res.status(400).json({ success: false, message: 'Choose a valid test variant.' });
        test.winner = variantId; test.status = 'winner_selected'; test.winnerSelectedAt = nowIso(); saveDb('email_ab_tests', tests); res.json({ success: true, test });
    });
    app.post('/api/email/ab-tests/:id/cancel', (req, res) => { const tests = getDb('email_ab_tests'); const test = tests.find(item => item.id === req.params.id); if (!test) return res.status(404).json({ success: false, message: 'Email A/B test not found.' }); test.status = 'cancelled'; test.cancelledAt = nowIso(); saveDb('email_ab_tests', tests); res.json({ success: true }); });
    app.get('/api/multichannel/campaigns', (req, res) => res.json({ success: true, campaigns: getDb('multichannel_campaigns') }));
    app.post('/api/multichannel/campaigns', (req, res) => {
        const body = req.body || {}; const audience = eligibleAudience(body.contacts || [], { recentDays: body.recentDays, requireOptIn: body.requireOptIn !== false }).eligible;
        if (!String(body.name || '').trim() || !String(body.subject || '').trim() || !String(body.htmlBody || '').trim() || !String(body.whatsAppMessage || '').trim()) return res.status(400).json({ success: false, message: 'Campaign name, email content, and WhatsApp follow-up text are required.' });
        if (!audience.length) return res.status(400).json({ success: false, message: 'No eligible opted-in email recipients remain.' });
        const campaigns = getCampaigns(); const emailCampaign = { id: id('email'), name: `${body.name.trim()} — Email`, provider: 'brevo', senderName: body.senderName || '', senderEmail: body.senderEmail || '', subject: body.subject, htmlBody: body.htmlBody, textBody: body.textBody || '', audience, delivery: audience.map(c => ({ email: c.email, status: 'pending' })), scheduledFor: body.scheduledFor || nowIso(), status: 'queued', createdAt: nowIso(), preflight: { multichannel: true } }; campaigns[emailCampaign.id] = emailCampaign; saveDb('email_campaigns', campaigns);
        const journeys = getDb('multichannel_campaigns') || {}; const journey = { id: id('journey'), name: body.name.trim(), emailCampaignId: emailCampaign.id, contacts: audience, whatsappMessage: String(body.whatsAppMessage), delayHours: Math.max(1, Number(body.followUpAfterHours || 24)), status: 'email_queued', createdAt: nowIso(), completedJids: [], skippedJids: [], note: 'Local mode checks for a WhatsApp reply after email API acceptance; email opens and replies are not detected without a public webhook.' }; journeys[journey.id] = journey; saveDb('multichannel_campaigns', journeys); setImmediate(processEmailCampaigns); res.json({ success: true, journey, emailCampaign });
    });
    app.post('/api/email/webhooks/brevo', (req, res) => {
        const events = Array.isArray(req.body) ? req.body : [req.body]; const stored = getEvents(); const contacts = getContacts();
        for (const event of events.filter(Boolean)) {
            stored.unshift({ id: id('emailevt'), receivedAt: nowIso(), ...event });
            const email = String(event.email || '').toLowerCase();
            if (email) Object.values(contacts).filter(c => String(c.email || '').toLowerCase() === email).forEach(c => applyContactEmailStatus(c, event));
        }
        saveDb('email_events', stored.slice(0, 2000)); saveDb('contacts', contacts); res.status(204).end();
    });
    app.get('/api/email/analytics', (req, res) => {
        const campaigns = Object.values(getCampaigns()); const events = getEvents();
        const byEvent = events.reduce((acc, e) => { const key = String(e.event || e.type || 'other').toLowerCase(); acc[key] = (acc[key] || 0) + 1; return acc; }, {});
        res.json({ success: true, totals: { campaigns: campaigns.length, queued: campaigns.filter(c => ['queued','paused','sending'].includes(c.status)).length, accepted: campaigns.reduce((n, c) => n + (c.delivery || []).filter(d => ['accepted','sent'].includes(d.status)).length, 0), sent: campaigns.reduce((n, c) => n + (c.delivery || []).filter(d => ['accepted','sent'].includes(d.status)).length, 0), failed: campaigns.reduce((n, c) => n + (c.delivery || []).filter(d => d.status === 'failed').length, 0), cancelled: campaigns.filter(c => c.status === 'cancelled').length, events: byEvent }, campaigns });
    });
    app.post('/api/email/listmonk/retire', (req, res) => {
        const archive = { archivedAt: nowIso(), note: 'Listmonk retired from ScholarVault CRM operations. No source data was deleted.', settingsPresent: Boolean(getDb('settings_listmonk')) };
        saveDb('listmonk_retirement_archive', archive); res.json({ success: true, archive });
    });
    setInterval(processEmailCampaigns, 60000);
    console.log('[Email Engine] Brevo-native email routes loaded at /api/email/*');
};
