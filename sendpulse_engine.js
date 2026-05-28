// ═══════════════════════════════════════════════════════════
// SENDPULSE BULK EMAIL ENGINE — sendpulse_engine.js
// Plug-in module for ScholarVault Campaign Dashboard
// Sends up to 1000 emails/day at 50/hour via SendPulse API
// No SMTP needed — uses REST API only
// ═══════════════════════════════════════════════════════════
// HOW TO USE:
//   In server.js, add at top:
//     const setupSendPulse = require('./sendpulse_engine');
//   After all your existing routes, before app.listen:
//     setupSendPulse(app, getDb, saveDb);
// ═══════════════════════════════════════════════════════════

const axios = require('axios');

const SP_API = 'https://api.sendpulse.com';

module.exports = function setupSendPulse(app, getDb, saveDb) {

    // ─── Token Cache ───
    let SP_TOKEN = null;
    let SP_TOKEN_EXPIRES = 0;

    function getSPSettings() {
        return getDb('settings_sendpulse') || {};
    }

    // --- Authentication (Supports OAuth and Static API Key) ---
    async function getSPToken() {
        const { clientId, clientSecret } = getSPSettings();
        
        // Support for static API key provided by user (starts with sp_apikey_)
        if (clientId && clientId.startsWith('sp_apikey_')) {
            return clientId.replace('sp_apikey_', '');
        }

        const now = Date.now();
        if (SP_TOKEN && now < SP_TOKEN_EXPIRES) return SP_TOKEN;
        
        if (!clientId || !clientSecret)
            throw new Error('SendPulse not configured. Please enter your API Key or Client ID + Secret in Settings.');
        
        const r = await axios.post(`${SP_API}/oauth/access_token`, {
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret
        });
        SP_TOKEN = r.data.access_token;
        SP_TOKEN_EXPIRES = now + (55 * 60 * 1000);
        console.log('[SendPulse] ✅ OAuth Token refreshed.');
        return SP_TOKEN;
    }

    // --- Get or create a mailing list by name ---
    async function spGetOrCreateList(token, listName) {
        const r = await axios.get(`${SP_API}/addressbooks`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const existing = (r.data || []).find(l => l.name === listName);
        if (existing) return existing.id;
        const c = await axios.post(`${SP_API}/addressbooks`,
            { bookName: listName },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        return c.data.id;
    }

    // --- Add contacts to a SP mailing list ---
    async function spAddContacts(token, listId, contacts) {
        const emails = contacts.map(c => ({
            email: c.email,
            variables: { name: c.name || 'Researcher' }
        }));
        await axios.post(`${SP_API}/addressbooks/${listId}/emails`,
            { emails },
            { headers: { Authorization: `Bearer ${token}` } }
        );
    }

    // --- Create and fire a SP campaign ---
    async function spCreateCampaign(token, { listId, senderName, senderEmail, subject, htmlBody, campaignName }) {
        const bodyB64 = Buffer.from(htmlBody).toString('base64');
        const r = await axios.post(`${SP_API}/campaigns`, {
            sender_name: senderName,
            sender_email: senderEmail,
            subject,
            body: bodyB64,
            list_id: String(listId),
            name: campaignName
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return r.data;
    }

    // ─── Queue DB helpers ───
    function getSPQueue() { return getDb('sendpulse_queue') || {}; }
    function saveSPQueue(q) { saveDb('sendpulse_queue', q); }

    // ═══════════════════════════════════════════════════════
    // WORKER — runs every 5 minutes or immediately on demand
    // Picks up batches whose scheduledFor time has arrived
    // ═══════════════════════════════════════════════════════
    async function processQueues() {
        try {
            const queue = getSPQueue();
            let updated = false;

            for (const qId in queue) {
                const q = queue[qId];
                if (['cancelled', 'completed'].includes(q.status)) continue;

                for (const batch of q.batches) {
                    if (batch.status !== 'pending') continue;
                    if (batch.scheduledFor > Date.now()) continue; // not yet

                    console.log(`[SP Worker] ⏰ Processing batch ${batch.batchIdx + 1}/${q.totalBatches} — ${batch.contacts.length} contacts`);
                    try {
                        const token = await getSPToken();
                        const listName = `SV_${qId}_b${batch.batchIdx}`;
                        
                        // 1. Create mailing list
                        const listId = await spGetOrCreateList(token, listName);
                        
                        // 2. Add contacts
                        await spAddContacts(token, listId, batch.contacts);
                        
                        // 3. Optional: Verification Step
                        if (q.verifyEmails) {
                            console.log(`[SP Worker] 🔍 Requesting verification for list ${listId}`);
                            try {
                                await axios.post(`${SP_API}/verifier-service/send-list-to-verify/`, 
                                    { id: listId }, 
                                    { headers: { Authorization: `Bearer ${token}` } }
                                );
                                // Wait longer for verification to finish (approx 10s for 50 emails)
                                await new Promise(r => setTimeout(r, 12000));
                            } catch (ve) {
                                console.warn('[SP Worker] Verification request failed (maybe already verifying):', ve.message);
                            }
                        } else {
                            // Small pause so SP indexes contacts
                            await new Promise(r => setTimeout(r, 5000));
                        }
                        
                        // 5. Fire campaign (with retry if "Book is empty")
                        let result;
                        let attempts = 0;
                        const maxAttempts = 3;
                        
                        while (attempts < maxAttempts) {
                            try {
                                result = await spCreateCampaign(token, {
                                    listId,
                                    senderName: batch.senderName,
                                    senderEmail: batch.senderEmail,
                                    subject: batch.subject,
                                    htmlBody: batch.htmlBody,
                                    campaignName: `${batch.campaignName} [B${batch.batchIdx + 1}]`
                                });
                                break; // Success!
                            } catch (err) {
                                attempts++;
                                const isBookEmpty = err.response && err.response.data && err.response.data.error_code === 798;
                                if (isBookEmpty && attempts < maxAttempts) {
                                    console.warn(`[SP Worker] ⚠️ SendPulse says "Book is empty" (indexing lag). Retrying in 10s... (Attempt ${attempts}/${maxAttempts})`);
                                    await new Promise(r => setTimeout(r, 10000));
                                } else {
                                    throw err; // Real error or too many retries
                                }
                            }
                        }
                        
                        batch.status = 'sent';
                        batch.spCampaignId = result.id;
                        batch.sentAt = new Date().toISOString();
                        console.log(`[SP Worker] ✅ Batch ${batch.batchIdx + 1} sent. SP Campaign ID: ${result.id}`);
                    } catch (err) {
                        batch.status = 'failed';
                        const errorData = err.response?.data;
                        batch.error = errorData?.message || errorData?.error_description || err.message;
                        console.error(`[SP Worker] ❌ Batch ${batch.batchIdx + 1} failed:`, batch.error);
                        if (errorData) console.error(' -> Detail:', JSON.stringify(errorData));
                    }
                    updated = true;
                }

                // Mark queue completed if all batches done
                const allDone = q.batches.every(b => ['sent', 'failed', 'cancelled'].includes(b.status));
                if (allDone && q.status === 'queued') {
                    q.status = 'completed';
                    const sentCount = q.batches.filter(b => b.status === 'sent').reduce((a, b) => a + b.contacts.length, 0);
                    console.log(`[SP Worker] 🏁 Queue ${qId} completed. Total sent: ${sentCount}`);
                }
            }
            if (updated) saveSPQueue(queue);

        } catch (err) {
            console.error('[SP Worker Error]', err.message);
        }
    }

    // --- Check Intervals ---
    const CHECK_INTERVAL = 5 * 60 * 1000;
    setInterval(processQueues, CHECK_INTERVAL);

    // ═══════════════════════════════════════════════════════
    // ROUTES
    // ═══════════════════════════════════════════════════════

    // (Webhook route removed per user request)

    // GET  /api/settings/sendpulse  — read current config (masked)
    app.get('/api/settings/sendpulse', (req, res) => {
        const s = getSPSettings();
        res.json({
            success: true,
            settings: {
                clientId: s.clientId ? s.clientId.substring(0, 8) + '...' : '',
                clientSecretSet: !!(s.clientSecret),
                senderName: s.senderName || 'ScholarVault Conferences',
                senderEmail: s.senderEmail || 'conferences@scholarvault.in',
                configured: !!(s.clientId && (s.clientId.startsWith('sp_apikey_') || s.clientSecret))
            }
        });
    });

    // POST /api/sendpulse/send-test — send a single test email
    app.post('/api/sendpulse/send-test', async (req, res) => {
        const { recipient, subject, htmlBody, senderName, senderEmail } = req.body;
        if (!recipient || !subject || !htmlBody) return res.status(400).json({ success: false, message: 'Missing fields' });

        try {
            const token = await getSPToken();
            const listName = `SV_TEST_${Date.now()}`;
            
            console.log(`[SendPulse Test] Creating temporary list: ${listName}`);
            const listId = await spGetOrCreateList(token, listName);
            
            console.log(`[SendPulse Test] Adding recipient: ${recipient}`);
            await spAddContacts(token, listId, [{ email: recipient, name: 'Test User' }]);
            
            // Wait for SP indexing
            console.log(`[SendPulse Test] Waiting for indexing...`);
            
            let result;
            let attempts = 0;
            const maxAttempts = 3;
            
            while (attempts < maxAttempts) {
                try {
                    console.log(`[SendPulse Test] Launching test campaign... (Attempt ${attempts + 1})`);
                    result = await spCreateCampaign(token, {
                        listId,
                        senderName: senderName || 'ScholarVault Test',
                        senderEmail: senderEmail || 'conferences@scholarvault.in',
                        subject: `[TEST] ${subject}`,
                        htmlBody,
                        campaignName: listName
                    });
                    break; // Success!
                } catch (err) {
                    attempts++;
                    const isBookEmpty = err.response && err.response.data && err.response.data.error_code === 798;
                    if (isBookEmpty && attempts < maxAttempts) {
                        console.warn(`[SendPulse Test] ⚠️ List still empty, retrying in 10s...`);
                        await new Promise(r => setTimeout(r, 10000));
                    } else {
                        throw err;
                    }
                }
            }

            res.json({ success: true, message: 'Test campaign created', id: result.id });
        } catch (err) {
            const errorData = err.response?.data;
            const msg = errorData?.message || errorData?.error_description || err.message;
            console.error('[SendPulse Test Error]', msg);
            res.status(500).json({ success: false, message: msg });
        }
    });

    // POST /api/sendpulse/test-auth — explicit test
    app.post('/api/sendpulse/test-auth', async (req, res) => {
        try {
            const { clientId, clientSecret } = req.body;
            // Temporarily use these for the test
            const token = await (async () => {
                if (clientId && clientId.startsWith('sp_apikey_')) return clientId.replace('sp_apikey_', '');
                const r = await axios.post(`${SP_API}/oauth/access_token`, {
                    grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret
                });
                return r.data.access_token;
            })();
            const r = await axios.get(`${SP_API}/user/info`, { headers: { Authorization: `Bearer ${token}` } });
            res.json({ success: true, message: 'Successfully connected to SendPulse!', account: r.data.name || r.data.email });
        } catch (e) {
            const errorData = e.response?.data;
            res.json({ success: false, message: errorData?.message || errorData?.error_description || e.message });
        }
    });

    // POST /api/settings/sendpulse  — save config
    app.post('/api/settings/sendpulse', (req, res) => {
        const { clientId, clientSecret, senderName, senderEmail } = req.body;
        if (!clientId || (!clientId.startsWith('sp_apikey_') && !clientSecret))
            return res.status(400).json({ success: false, message: 'API Key or Client ID + Secret required.' });
        saveDb('settings_sendpulse', { clientId, clientSecret, senderName, senderEmail });
        SP_TOKEN = null; // force refresh
        res.json({ success: true, message: 'SendPulse settings saved. Run /api/sendpulse/test to verify.' });
    });

    // GET  /api/sendpulse/test  — verify credentials work
    app.get('/api/sendpulse/test', async (req, res) => {
        try {
            const token = await getSPToken();
            const r = await axios.get(`${SP_API}/user/info`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            res.json({ success: true, account: r.data });
        } catch (e) {
            const errorData = e.response?.data;
            const msg = errorData?.message || errorData?.error_description || e.message;
            res.json({ success: false, message: msg, detail: errorData });
        }
    });

    // POST /api/sendpulse/send-bulk
    // Body: { contacts:[{email,name}], subject, htmlBody, campaignName }
    // Batches 50/hour automatically, up to 1000/day
    app.post('/api/sendpulse/send-bulk', async (req, res) => {
        try {
            const { contacts, subject, htmlBody, campaignName } = req.body;
            if (!contacts || !contacts.length)
                return res.status(400).json({ success: false, message: 'No contacts provided.' });
            if (!subject || !htmlBody)
                return res.status(400).json({ success: false, message: 'subject and htmlBody are required.' });

            const settings = getSPSettings();
            const isStatic = settings.clientId && settings.clientId.startsWith('sp_apikey_');
            if (!settings.clientId || (!isStatic && !settings.clientSecret))
                return res.status(400).json({ success: false, message: 'SendPulse not configured. Please enter your API Key in Settings.' });

            // Filter valid emails only
            const valid = contacts.filter(c => c.email && c.email.includes('@') && c.email.includes('.'));
            if (!valid.length)
                return res.status(400).json({ success: false, message: 'No valid email addresses found in contacts list.' });

            // Split into batches of 50
            const BATCH_SIZE = 50;
            const HOUR_MS = 60 * 60 * 1000;
            const batches = [];
            for (let i = 0; i < valid.length; i += BATCH_SIZE) {
                batches.push(valid.slice(i, i + BATCH_SIZE));
            }

            const queueId = 'spq_' + Date.now();
            const now = Date.now();
            const queue = getSPQueue();
            const campName = campaignName || `SV Campaign ${new Date().toLocaleDateString('en-IN')}`;

            queue[queueId] = {
                id: queueId,
                name: campName,
                totalContacts: valid.length,
                totalBatches: batches.length,
                createdAt: new Date().toISOString(),
                status: 'queued',
                batches: batches.map((batch, idx) => ({
                    batchIdx: idx,
                    contacts: batch,
                    subject,
                    htmlBody,
                    campaignName: campName,
                    senderName: settings.senderName || 'ScholarVault Conferences',
                    senderEmail: settings.senderEmail || 'conferences@scholarvault.in',
                    scheduledFor: now + (idx * HOUR_MS),
                    status: 'pending',
                    spCampaignId: null,
                    sentAt: null,
                    error: null
                }))
            };
            saveSPQueue(queue);

            console.log(`[SendPulse] Queued ${valid.length} contacts in ${batches.length} batches. ID: ${queueId}`);
            res.json({
                success: true,
                queueId,
                totalContacts: valid.length,
                totalBatches: batches.length,
                schedule: batches.map((b, i) => ({
                    batch: i + 1,
                    contacts: b.length,
                    sendsAt: new Date(now + (i * HOUR_MS)).toLocaleTimeString('en-IN')
                }))
            });

            // Trigger the first batch immediately!
            setImmediate(processQueues);

        } catch (e) {
            console.error('[SendPulse /send-bulk Error]', e.message);
            res.json({ success: false, message: e.message });
        }
    });

    // GET  /api/sendpulse/status  — all queues
    app.get('/api/sendpulse/status', (req, res) => {
        const queue = getSPQueue();
        const summary = Object.values(queue).map(q => ({
            id: q.id,
            name: q.name,
            status: q.status,
            totalContacts: q.totalContacts,
            totalBatches: q.totalBatches,
            sent: q.batches.filter(b => b.status === 'sent').length,
            pending: q.batches.filter(b => b.status === 'pending').length,
            failed: q.batches.filter(b => b.status === 'failed').length,
            createdAt: q.createdAt,
            nextBatch: (() => {
                const next = q.batches.find(b => b.status === 'pending');
                return next ? new Date(next.scheduledFor).toLocaleTimeString('en-IN') : null;
            })()
        }));
        res.json({ success: true, queues: summary });
    });

    // DELETE /api/sendpulse/queue/:queueId  — cancel
    app.delete('/api/sendpulse/queue/:queueId', (req, res) => {
        const queue = getSPQueue();
        if (!queue[req.params.queueId])
            return res.status(404).json({ success: false, message: 'Queue not found.' });
        queue[req.params.queueId].batches.forEach(b => {
            if (b.status === 'pending') b.status = 'cancelled';
        });
        queue[req.params.queueId].status = 'cancelled';
        saveSPQueue(queue);
        res.json({ success: true, message: 'Queue cancelled. Pending batches will not be sent.' });
    });

    // ═══════════════════════════════════════════════════════
    // CRON — runs every 5 minutes
    // Picks up batches whose scheduledFor time has arrived
    // ═══════════════════════════════════════════════════════
    setInterval(async () => {
        try {
            const queue = getSPQueue();
            let updated = false;

            for (const qId in queue) {
                const q = queue[qId];
                if (['cancelled', 'completed'].includes(q.status)) continue;

                for (const batch of q.batches) {
                    if (batch.status !== 'pending') continue;
                    if (batch.scheduledFor > Date.now()) continue; // not yet

                    console.log(`[SP Cron] ⏰ Processing batch ${batch.batchIdx + 1}/${q.totalBatches} — ${batch.contacts.length} contacts`);
                    try {
                        const token = await getSPToken();
                        const listName = `SV_${qId}_b${batch.batchIdx}`;
                        // 1. Create mailing list
                        const listId = await spGetOrCreateList(token, listName);
                        // 2. Add contacts
                        await spAddContacts(token, listId, batch.contacts);
                        // 3. Small pause so SP indexes contacts
                        await new Promise(r => setTimeout(r, 4000));
                        // 4. Fire campaign
                        const result = await spCreateCampaign(token, {
                            listId,
                            senderName: batch.senderName,
                            senderEmail: batch.senderEmail,
                            subject: batch.subject,
                            htmlBody: batch.htmlBody,
                            campaignName: `${batch.campaignName} [B${batch.batchIdx + 1}]`
                        });
                        batch.status = 'sent';
                        batch.spCampaignId = result.id;
                        batch.sentAt = new Date().toISOString();
                        console.log(`[SP Cron] ✅ Batch ${batch.batchIdx + 1} sent. SP Campaign ID: ${result.id}`);
                    } catch (err) {
                        batch.status = 'failed';
                        batch.error = err.response?.data?.message || err.message;
                        console.error(`[SP Cron] ❌ Batch ${batch.batchIdx + 1} failed:`, batch.error);
                    }
                    updated = true;
                }

                // Mark queue completed if all batches done
                const allDone = q.batches.every(b => ['sent', 'failed', 'cancelled'].includes(b.status));
                if (allDone && q.status === 'queued') {
                    q.status = 'completed';
                    const sentCount = q.batches.filter(b => b.status === 'sent').reduce((a, b) => a + b.contacts.length, 0);
                    console.log(`[SP Cron] 🏁 Queue ${qId} completed. Total sent: ${sentCount}`);
                }
            }
            if (updated) saveSPQueue(queue);

        } catch (err) {
            console.error('[SP Cron Error]', err.message);
        }
    }, 5 * 60 * 1000); // every 5 min

    console.log('[SendPulse Engine] ✅ Loaded. Routes: /api/settings/sendpulse, /api/sendpulse/*');
};
