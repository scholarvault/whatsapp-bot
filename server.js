const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const setupSendPulse = require('./sendpulse_engine');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

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
        if (process.env.GOOGLE_CREDENTIALS) {
            authOpts.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
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
            const isArray = ['blacklist', 'inbox', 'hot_leads', 'instances', 'ai_replies'].includes(name);
            fs.writeFileSync(file, isArray ? '[]' : '{}');
        }
        let data = JSON.parse(fs.readFileSync(file, 'utf8'));
        
        // Defensive type guard to prevent serialization errors (e.g. conversations loaded as array)
        const expectArray = ['blacklist', 'inbox', 'hot_leads', 'instances', 'ai_replies'].includes(name);
        if (expectArray && !Array.isArray(data)) {
            data = [];
        } else if (!expectArray && (Array.isArray(data) || typeof data !== 'object' || data === null)) {
            data = {};
        }
        return data;
    } catch (e) {
        console.error(`[DB Error] Failed reading ${name}:`, e.message);
        return ['blacklist', 'inbox', 'hot_leads', 'ai_replies'].includes(name) ? [] : {};
    }
};

const saveDb = (name, data) => {
    fs.writeFileSync(path.join(DB_DIR, `${name}.json`), JSON.stringify(data, null, 2));
};

function getDefaultInstanceName() {
    const instances = getDb('instances');
    if (Array.isArray(instances) && instances.length > 0) {
        const defaultInst = instances.find(i => i.isDefault);
        if (defaultInst) return defaultInst.name;
        return instances[0].name;
    }
    return 'ScholarVault';
}


// --- Listmonk Configuration ---
let LISTMONK_URL = 'https://listmonk.scholarvault.in';
let LISTMONK_AUTH = { username: 'Sam', password: 'wW0cIzcWq4p2uo2Ng9GRTfESqcJvUeWz' };

function loadListmonkSettings() {
    const s = getDb('settings_listmonk');
    if (s && s.url) {
        LISTMONK_URL = s.url;
        LISTMONK_AUTH = { username: s.username, password: s.password };
    }
}
loadListmonkSettings();

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

async function sendSmartMessage(remoteJid, instanceName, textReply, apiKey, buttonsArr, skipDelay = false, senderType = 'bot') {
    const blacklist = getDb('blacklist');
    // Normalize JID if needed
    const normalizedJid = remoteJid.includes('@s.whatsapp.net') ? remoteJid : `${remoteJid}@s.whatsapp.net`;
    
    if (blacklist.includes(normalizedJid)) {
        console.log(`[Safety Guard] Blocked sending to Blacklisted number: ${normalizedJid}`);
        return false;
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

        if (buttonsArr && buttonsArr.length > 0) {
            console.log(`[Sender] Dispatching BUTTON message to ${normalizedJid}...`);
            await axios.post(`${EVO_API_URL}/message/sendButtons/${instanceName}`, {
                number: normalizedJid,
                text: finalMessage,
                footer: "ScholarVault",
                buttons: buttonsArr.map((b, i) => {
                    const str = String(b).trim();
                    if (str.includes('|')) {
                        const [title, action] = str.split('|', 2);
                        const cleanTitle = title.trim().substring(0, 20);
                        const cleanAction = action.trim();
                        if (cleanAction.startsWith('http')) {
                            return { type: "url", title: cleanTitle, url: cleanAction };
                        } else if (cleanAction.startsWith('+') || !isNaN(cleanAction.replace(/\D/g,''))) {
                            return { type: "call", title: cleanTitle, phoneNumber: cleanAction };
                        }
                    }
                    return { type: "reply", reply: { id: `sv_btn_${i}`, title: str.substring(0, 20) } };
                })
            }, { headers: { 'apikey': key } });
        } else {
            console.log(`[Sender] Dispatching TEXT message to ${normalizedJid}...`);
            await axios.post(`${EVO_API_URL}/message/sendText/${instanceName}`, {
                number: normalizedJid,
                text: finalMessage
            }, { headers: { 'apikey': key } });
        }
        
        // Track reply for SLA
        let contacts = getDb('contacts');
        if (contacts[normalizedJid]) {
            contacts[normalizedJid].lastRepliedAt = new Date().toISOString();
            contacts[normalizedJid].slaBreach = false;
            saveDb('contacts', contacts);
        }

        // Track the outbound message in conversations database (ignore system admin alerts)
        if (normalizedJid && !finalMessage.includes("🚨 URGENT:")) {
            let threads = getDb('conversations');
            if (!threads[normalizedJid]) threads[normalizedJid] = [];
            threads[normalizedJid].push({
                direction: 'out',
                text: finalMessage,
                senderType: senderType,
                timestamp: new Date().toISOString()
            });
            if (threads[normalizedJid].length > 200) {
                threads[normalizedJid] = threads[normalizedJid].slice(-200);
            }
            saveDb('conversations', threads);
        }
        
        return true;
    } catch (error) {
        console.error(`[Sender] Failed to send:`, error?.response?.data || error.message);
        return false;
    }
}

// Send an image media message with a caption via Evolution API
async function sendMediaMessage(remoteJid, instanceName, base64Data, caption, fileName, apiKey, skipDelay = false, senderType = 'bot') {
    const blacklist = getDb('blacklist');
    const normalizedJid = remoteJid.includes('@s.whatsapp.net') ? remoteJid : `${remoteJid}@s.whatsapp.net`;
    
    if (blacklist.includes(normalizedJid)) {
        console.log(`[Safety Guard] Blocked media send to Blacklisted number: ${normalizedJid}`);
        return false;
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
        }

        console.log(`[Sender] Dispatching MEDIA message to ${normalizedJid} (${fileName})...`);
        const evoResponse = await axios.post(`${EVO_API_URL}/message/sendMedia/${instanceName}`, {
            number: normalizedJid,
            media: base64Data,
            mediatype: 'image',
            fileName: fileName || 'campaign_poster.png',
            caption: finalCaption
        }, { headers: { 'apikey': key } });

        const apiSuccess = !!evoResponse.data;

        if (apiSuccess) {
            // Save file locally for conversation thread display
            const uploadsDir = path.join(__dirname, 'uploads');
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
            const cleanFileName = (fileName || 'campaign_poster.png').replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const savedFileName = `${Date.now()}-${cleanFileName}`;
            const localFilePath = path.join(uploadsDir, savedFileName);
            fs.writeFileSync(localFilePath, Buffer.from(base64Data, 'base64'));
            const relativeUrl = `/uploads/${savedFileName}`;

            // Track outbound media in conversations
            let threads = getDb('conversations');
            if (!threads[normalizedJid]) threads[normalizedJid] = [];
            threads[normalizedJid].push({
                direction: 'out',
                text: finalCaption || `Sent image: ${fileName || cleanFileName}`,
                mediaUrl: relativeUrl,
                mediaType: 'image',
                fileName: fileName || cleanFileName,
                senderType: senderType,
                timestamp: new Date().toISOString()
            });
            if (threads[normalizedJid].length > 200) {
                threads[normalizedJid] = threads[normalizedJid].slice(-200);
            }
            saveDb('conversations', threads);

            // Track reply for SLA
            let contacts = getDb('contacts');
            if (contacts[normalizedJid]) {
                contacts[normalizedJid].lastRepliedAt = new Date().toISOString();
                contacts[normalizedJid].slaBreach = false;
                saveDb('contacts', contacts);
            }
        }

        return apiSuccess;
    } catch (error) {
        console.error(`[Sender] Failed to send media:`, error?.response?.data || error.message);
        return false;
    }
}

// --- API Endpoints: Core Features ---

app.post('/api/start-evolution', async (req, res) => {
    try {
        const evoUrl = process.env.EVO_API_URL || 'http://localhost:8080';
        const evoKey = process.env.EVO_API_KEY || 'SV-EvoApi-2026-ScholarVault!';
        const instanceName = 'ScholarVault';
        
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

        if (response.data && response.data.base64) {
            return res.json({ success: true, message: 'Scan the QR Code on your screen!', qrcode: response.data.base64 });
        } else {
            return res.json({ success: true, message: 'Instance already connected or processing.', qrcode: null });
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
    const inbox = getDb('inbox');
    const contacts = getDb('contacts');
    // Enrich messages with SLA status and session context escalated status
    const enrichedMessages = inbox.map(m => {
        const sessionContext = getSessionContext(m.jid);
        return {
            ...m,
            escalated: sessionContext.escalated === true || m.escalated === true,
            slaBreach: contacts[m.jid]?.slaBreach || false,
            followUpDate: sessionContext.followUpDate || null
        };
    });
    res.json({ success: true, messages: enrichedMessages });
});
app.post('/api/inbox-reply', async (req, res) => {
    const { jid, message, instance } = req.body;
    if (!jid || !message) return res.status(400).json({ success: false });
    const success = await sendSmartMessage(jid, instance || getDefaultInstanceName(), message, null, null, true, 'agent');
    res.json({ success });
});

// CRM Contacts APIs
app.get('/api/contacts', (req, res) => res.json({ success: true, contacts: getDb('contacts') }));
app.post('/api/contacts', (req, res) => {
    saveDb('contacts', req.body.contacts);
    res.json({ success: true });
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
    const updates = req.body;
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

// --- Webhook Listener ---
app.post(['/webhook', '/webhook/:event'], async (req, res) => {
    res.status(200).send('OK'); // Acknowledge quickly
    const event = req.body || {};
    
    // Fallback: If event.event is not populated in the body, construct it from the URL parameter
    if (!event.event && req.params.event) {
        event.event = req.params.event.replace(/[-.]/g, '_').toUpperCase();
    }
    
    if ((event.event === 'messages.upsert' || event.event === 'MESSAGES_UPSERT') && event.data) {
        try {
            const messageData = event.data;
            const msg = (messageData.messages && messageData.messages.length > 0) ? messageData.messages[0] : messageData;

            if (msg.key && msg.key.fromMe) return;

            const senderJid = msg.key ? msg.key.remoteJid : null;
            if (!senderJid) return;
            
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
            
            if (!incomingText) return;
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
            let inbox = getDb('inbox');
            inbox.unshift({ 
                jid: senderJid, 
                name: msg.pushName || 'Unknown', 
                message: incomingText, 
                sentiment: sentiment,
                timestamp: new Date().toISOString() 
            });
            if (inbox.length > 200) inbox.pop();
            saveDb('inbox', inbox);

            // --- Feature: Contact Tracking (SLA) ---
            let contacts = getDb('contacts');
            if (!contacts[senderJid]) contacts[senderJid] = { jid: senderJid, name: msg.pushName || 'Unknown' };
            
            contacts[senderJid].lastReceivedAt = new Date().toISOString();
            contacts[senderJid].sentiment = sentiment;
            contacts[senderJid].slaBreach = false; // Reset on new message
            
            if (!contacts[senderJid].leadStatus || contacts[senderJid].leadStatus === 'Messaged') {
                contacts[senderJid].leadStatus = 'Replied';
                contacts[senderJid].statusUpdatedAt = new Date().toISOString();
            }
            saveDb('contacts', contacts);

            // --- Feature: Conversation Thread Storage ---
            let threads = getDb('conversations');
            if (!threads[senderJid]) threads[senderJid] = [];
            
            const threadItem = { 
                direction: 'in', 
                text: incomingText, 
                name: msg.pushName || 'Unknown', 
                sentiment: sentiment, 
                timestamp: new Date().toISOString() 
            };
            if (relativeUrl) {
                threadItem.mediaUrl = relativeUrl;
                threadItem.mediaType = mediatype;
                threadItem.fileName = fileName || (mediatype === 'image' ? 'photo.png' : 'document.pdf');
            }
            
            threads[senderJid].push(threadItem);
            if (threads[senderJid].length > 200) threads[senderJid] = threads[senderJid].slice(-200);
            saveDb('conversations', threads);

            // --- Feature: Send-Time Analytics ---
            const replyHour = new Date().getHours();
            let sendTimeStats = getDb('send_time_stats');
            if (!sendTimeStats.hours) sendTimeStats.hours = {};
            sendTimeStats.hours[replyHour] = (sendTimeStats.hours[replyHour] || 0) + 1;
            saveDb('send_time_stats', sendTimeStats);

            // --- Feature: Hot Leads & Auto-Sync ---
            const HOT_KEYWORDS = ['pricing', 'price', 'cost', 'fee', 'registration', 'register', 'interested', 'details', 'info', 'enroll', 'join', 'how much', 'apply', 'collaborate', 'collaboration', 'partner', 'partnership', 'mou', 'tie up'];
            const matchedKeyword = HOT_KEYWORDS.find(kw => lowerText.includes(kw));
            
            if (matchedKeyword || sentiment === 'Positive') {
                let hotLeads = getDb('hot_leads');
                const alreadyTagged = hotLeads.find(l => l.phone === senderJid);
                if (!alreadyTagged) {
                    const newLead = {
                        phone: senderJid,
                        name: msg.pushName || 'Unknown',
                        keyword: matchedKeyword || 'Sentiment',
                        sentiment: sentiment,
                        message: incomingText,
                        timestamp: new Date().toISOString()
                    };
                    hotLeads.unshift(newLead);
                    saveDb('hot_leads', hotLeads);
                    console.log(`[🔥 Hot Lead] Tagged ${senderJid}`);
                    
                    // AUTO-SYNC TO GOOGLE SHEETS
                    syncLeadToSheet(newLead);
                }
            }

            // --- Feature: Auto-Blacklisting ---
            if (['stop', 'unsubscribe', 'optout', 'remove'].includes(lowerText)) {
                let blacklist = getDb('blacklist');
                if (!blacklist.includes(senderJid)) {
                    blacklist.push(senderJid);
                    saveDb('blacklist', blacklist);
                    console.log(`[Blacklist] System auto-banned ${senderJid} per user request.`);
                    
                    // Reply confirming removal
                    await sendSmartMessage(senderJid, instanceName, "You have been successfully removed from our list. You will not receive any more automated messages.", event.apikey);
                }
                return; // Stop processing further rules
            }

            // --- Feature: Live Inbox Escalation Scan & Handoff Lock ---
            const currentSession = getSessionContext(senderJid);
            if (currentSession.escalated === true && !lowerText.includes('re-enable ai')) {
                console.log(`[Human Handoff Lock] Conversation with ${senderJid} is escalated. Skipping automated responder.`);
                return;
            }
            
            // Re-enable AI command (for testing/ops convenience)
            if (lowerText.includes('re-enable ai')) {
                currentSession.escalated = false;
                saveSessionContext(senderJid, currentSession);
                console.log(`[Human Handoff Lock] Re-enabled AI automated responder for ${senderJid}`);
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
                const jidMatch = inboxDb.findIndex(m => m.jid === senderJid);
                if (jidMatch !== -1) {
                    inboxDb[jidMatch].escalated = true;
                    inboxDb[jidMatch].escalationTrigger = matchedEscalation;
                    inboxDb[jidMatch].escalationTime = new Date().toISOString();
                    saveDb('inbox', inboxDb);
                }
                
                // Flag in session state context memory
                currentSession.escalated = true;
                currentSession.lastIntent = 'human_escalation';
                saveSessionContext(senderJid, currentSession);
                
                // Dispatch recovery handoff message
                const handoffText = kb?.fallbacks?.handoff || "Connecting you with our support operations team. A manager will reply directly shortly.";
                const escalationDeskStr = `\n\nDirect Contacts:\n📞 Phone: ${kb.escalation.finance.phone} (${kb.escalation.finance.department})\n✉️ Email: ${kb.escalation.finance.email}`;
                
                await sendSmartMessage(senderJid, instanceName, handoffText + escalationDeskStr + "\n\n— ScholarVault Team", event.apikey);

                // Dispatch WhatsApp push alert to Shyam (admin)
                const adminJid = "918610100624@s.whatsapp.net";
                const cleanPhone = senderJid.replace('@s.whatsapp.net', '');
                const formattedPhone = (cleanPhone.startsWith('91') && cleanPhone.length === 12) 
                    ? `+${cleanPhone.slice(0, 2)}-${cleanPhone.slice(2, 7)}-${cleanPhone.slice(7)}` 
                    : `+${cleanPhone}`;
                const senderName = msg.pushName || 'Researcher';
                const alertMsg = `🚨 URGENT: Shyam, ${senderName} (${formattedPhone}) is requesting human assistance regarding ${matchedEscalation || 'manual escalation'}! View chat here: http://localhost:3000`;
                console.log(`[Admin Alert] Dispatching priority handoff WhatsApp push notification to Shyam...`);
                await sendSmartMessage(adminJid, instanceName, alertMsg, event.apikey);

                return; // Stop automation immediately
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
                    await sendSmartMessage(senderJid, instanceName, matchedRule.reply, event.apikey);
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
                        saveSessionContext(senderJid, currentSession);
                        
                        let inboxDb = getDb('inbox');
                        const jidMatch = inboxDb.findIndex(m => m.jid === senderJid);
                        if (jidMatch !== -1) {
                            inboxDb[jidMatch].escalated = true;
                            inboxDb[jidMatch].escalationTrigger = 'hostile_guardrail_intercept';
                            inboxDb[jidMatch].escalationTime = new Date().toISOString();
                            saveDb('inbox', inboxDb);
                        }
                    }

                    const delaySec = (Math.floor(Math.random() * 2) + 1) * 1000; // 1-2 second realistic human delay
                    setTimeout(async () => {
                        await sendSmartMessage(senderJid, instanceName, filterResult.reply + "\n\n— ScholarVault Team", event.apikey);
                    }, delaySec);
                    return; // Halt execution and skip AI call completely
                }

                // Conversational query: Route directly to Mistral AI
                console.log(`[AI Routing] Directing conversational query "${incomingText}" to Mistral AI...`);
                const aiDelay = (Math.floor(Math.random() * 3) + 2) * 1000; // 2-4 second human-like delay
                setTimeout(async () => {
                    try {
                        const aiReply = await generateAIReply(incomingText, senderJid, msg.pushName || 'Friend');
                        if (aiReply) {
                            await sendSmartMessage(senderJid, instanceName, aiReply, event.apikey);
                            console.log(`[AI Routing] Sent AI reply to ${senderJid}`);

                            // Check if the conversation was just escalated during this AI turn
                            const updatedSession = getSessionContext(senderJid);
                            if (updatedSession.escalated === true && updatedSession.lastIntent === 'ai_requested_handoff') {
                                // 1. Flag in inbox database as escalated
                                let inboxDb = getDb('inbox');
                                const jidMatch = inboxDb.findIndex(m => m.jid === senderJid);
                                if (jidMatch !== -1) {
                                    inboxDb[jidMatch].escalated = true;
                                    inboxDb[jidMatch].escalationTrigger = 'ai_requested_handoff';
                                    inboxDb[jidMatch].escalationTime = new Date().toISOString();
                                    saveDb('inbox', inboxDb);
                                }

                                // 2. Send immediate push WhatsApp alert to Shyam (admin)
                                const adminJid = "918610100624@s.whatsapp.net";
                                const cleanPhone = senderJid.replace('@s.whatsapp.net', '');
                                const formattedPhone = (cleanPhone.startsWith('91') && cleanPhone.length === 12) 
                                    ? `+${cleanPhone.slice(0, 2)}-${cleanPhone.slice(2, 7)}-${cleanPhone.slice(7)}` 
                                    : `+${cleanPhone}`;
                                const senderName = msg.pushName || 'Researcher';
                                const alertMsg = `🚨 URGENT: Shyam, ${senderName} (${formattedPhone}) is requesting human assistance regarding AI handoff! View chat here: http://localhost:3000`;
                                console.log(`[Admin Alert] Dispatching WhatsApp push notification to Shyam...`);
                                await sendSmartMessage(adminJid, instanceName, alertMsg, event.apikey);
                            }
                        } else {
                            console.log(`[AI Routing] No AI reply generated for ${senderJid}`);
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
                        await sendSmartMessage(senderJid, instanceName, broadMatch.reply, event.apikey);
                    }, delaySec);
                }
            }
        } catch (err) {
            console.error('[Webhook Error]', err.message);
        }
    }
});

// --- Cron Loop: Scheduler & Drip Engine ---
// Runs every 1 minute
setInterval(async () => {
    try {
        const now = Date.now();
        // 1. Check Scheduled Campaigns
        let campaigns = getDb('campaigns');
        let campaignsUpdated = false;

        for (let campId in campaigns) {
            let camp = campaigns[campId];
            if (camp.status === 'scheduled' && camp.scheduledFor <= now) {
                console.log(`[Cron] Starting scheduled campaign: ${camp.name}`);
                camp.status = 'processing';
                campaignsUpdated = true;
                
                // Fire and forget the bulk send process so it doesn't block
                processBulkCampaign(campId, camp);
            }
        }
        if (campaignsUpdated) saveDb('campaigns', campaigns);

        // 2. Check Drip Follow-ups
        let dripState = getDb('drip_state');
        let dripUpdated = false;
        
        for (let jid in dripState) {
            let userDrip = dripState[jid];
            if (userDrip.pendingFollowups && userDrip.pendingFollowups.length > 0) {
                let nextFollowup = userDrip.pendingFollowups[0];
                if (nextFollowup.scheduledFor <= now) {
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
                    await sendSmartMessage(jid, nextFollowup.instance, nextFollowup.message, null, nextFollowup.buttons);
                    
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
    }
}, 60000);

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
    let sentCount = 0;
    let failedCount = 0;

    const hasMedia = !!mediaBase64;
    if (hasMedia) {
        console.log(`[Campaign] Image attached: ${mediaFileName || 'poster'} — will send as media+caption`);
    }

    for (let contact of contacts) {
        let targetJid = contact.jid || contact.phone;
        if (!targetJid) continue;

        // NEW: Safety check for non-numeric prefixes (prevents email@s.whatsapp.net failures)
        if (targetJid.includes('@')) {
            const prefix = targetJid.split('@')[0];
            if (isNaN(prefix) && !prefix.startsWith('status')) { // Skip non-numeric prefixes, allowing system JIDs like 'status' if needed
                console.log(`[Sender] Skipping invalid JID (non-numeric): ${targetJid}`);
                failedCount++;
                continue;
            }
        }
        
        const personalizedMessage = messageTemplate.replace('{{name}}', contact.name || 'Friend');
        let sentResult;

        if (hasMedia) {
            // Send image with caption
            sentResult = await sendMediaMessage(targetJid, instanceName, mediaBase64, personalizedMessage, mediaFileName, apiKey);
        } else {
            // Text-only campaign (original behavior)
            sentResult = await sendSmartMessage(targetJid, instanceName, personalizedMessage, apiKey, campData.buttons || []);
        }
        if (sentResult) {
            sentCount++;
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
                    instance: instanceName,
                    campaignSentAt: Date.now(), // Used by Smart Drip reply check
                    pendingFollowups: dripFollowups.map(drip => ({
                        message: drip.message.replace('{{name}}', contact.name || 'Friend'),
                        scheduledFor: Date.now() + (drip.delayHours * 3600 * 1000),
                        instance: instanceName,
                        buttons: drip.buttons || []
                    }))
                };
                saveDb('drip_state', dripState);
            }
        } else {
            failedCount++;
        }
        // Delay between batch messages
        await new Promise(r => setTimeout(r, delayBetweenMs || 5000));
    }

    let campaigns = getDb('campaigns');
    if (campaigns[campId]) {
        campaigns[campId].status = 'completed';
        campaigns[campId].sentCount = sentCount;
        campaigns[campId].failedCount = failedCount;
        campaigns[campId].completedAt = new Date().toISOString();
        saveDb('campaigns', campaigns);
        console.log(`[Campaign] Finished ${campData.name}: ${sentCount} sent, ${failedCount} failed.`);
    }
}

// Campaign API
app.post('/api/campaigns', (req, res) => {
    let campaigns = getDb('campaigns');
    const campId = 'camp_' + Date.now();
    
    // Check if scheduled immediately or future
    const scheduledFor = req.body.scheduledFor || Date.now();
    
    campaigns[campId] = {
        name: req.body.name || 'Unnamed Campaign',
        status: scheduledFor <= Date.now() ? 'scheduled' : 'scheduled',
        createdAt: new Date().toISOString(),
        scheduledFor: scheduledFor,
        ...req.body
    };
    saveDb('campaigns', campaigns);
    res.json({ success: true, message: 'Campaign Queued', campId });
});
app.get('/api/campaigns', (req, res) => res.json({ success: true, campaigns: getDb('campaigns') }));
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
    const { email, institution, role, country } = req.body;
    
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
    
    res.json({ 
        success: true, 
        thread: threads[jid] || [], 
        context: { ...sessionContext, jid, name: jidMatch ? jidMatch.name : 'Researcher', escalated }
    });
});

// Reply via thread (also logs outgoing message)
app.post('/api/inbox/:jid/reply', async (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const { message, instance } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'Message is required' });
    
    // We pass skipDelay = true and senderType = 'agent' so manual replies are sent instantly and logged automatically in sendSmartMessage
    const success = await sendSmartMessage(jid, instance || getDefaultInstanceName(), message, null, null, true, 'agent');
    res.json({ success });
});

// Send media via thread (handles base64 data URIs and saves file locally)
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
        
        if (apiSuccess) {
            let threads = getDb('conversations');
            if (!threads[jid]) threads[jid] = [];
            threads[jid].push({
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
        res.json({ success: true, session: currentSession });
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
    const contacts = getDb('contacts');
    const pipeline = { New: [], Messaged: [], Replied: [], Interested: [], Registered: [], Attended: [] };
    Object.values(contacts).forEach(c => {
        const status = c.leadStatus || 'New';
        if (pipeline[status]) pipeline[status].push(c);
        else pipeline['New'].push(c);
    });
    res.json({ success: true, pipeline });
});
app.post('/api/contacts/:jid/status', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const { status } = req.body;
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
    const contacts = getDb('contacts');
    let csv = 'Name,Phone,Status,Tags,Updated\n';
    Object.values(contacts).forEach(c => {
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
            return { ...inst, status: r.data?.instance?.state || 'unknown' };
        } catch (err) { 
            return { ...inst, status: 'offline' }; 
        }
    }));
    res.json({ success: true, instances: withStatus });
});
app.post('/api/instances', (req, res) => {
    const { name, apiUrl, apiKey } = req.body;
    if (!name || !apiUrl || !apiKey) return res.status(400).json({ success: false, message: 'name, apiUrl, apiKey required' });
    let instances = getDb('instances');
    if (!Array.isArray(instances)) instances = [];
    if (!instances.find(i => i.name === name)) instances.push({ name, apiUrl, apiKey, addedAt: new Date().toISOString() });
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
setupSendPulse(app, getDb, saveDb);

async function autoStartEvolution() {
    // Only attempt auto-start on Windows local machines
    if (process.platform !== 'win32') {
        console.log('[Auto-Start] Running in cloud environment. Skipping local Evolution API auto-start.');
        return;
    }
    
    try {
        // Check if Evolution API is already active
        await axios.get((process.env.EVO_API_URL || 'http://localhost:8080'), { timeout: 2000 });
        console.log('[Auto-Start] Evolution API is already running on port 8080.');
    } catch (e) {
        // Port 8080 is offline, spawn a new instance
        try {
            const evoPath = 'C:\\Users\\Shyam\\evolution-api';
            console.log(`[Auto-Start] Evolution API not active. Spawning at ${evoPath}...`);
            evolutionProcess = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'npm run start'], { cwd: evoPath, detached: true, windowsHide: false });
            evolutionProcess.unref();
            console.log(`[Auto-Start] Evolution API launched successfully.`);
        } catch (spawnErr) {
            console.error('[Auto-Start] Failed to start Evolution API process:', spawnErr.message);
        }
    }
}

app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 ScholarVault Campaign Command Center`);
    console.log(`=========================================`);
    console.log(`Dashboard available at: http://localhost:${PORT}`);
    console.log(`Webhook listener ACTIVE on port ${PORT}`);
    
    // Auto-start Evolution API if not already running
    setTimeout(autoStartEvolution, 3000);
});
