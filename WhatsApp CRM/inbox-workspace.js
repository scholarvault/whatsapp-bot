// CRM-only sales workspace for Live Inbox. Notes and follow-ups never leave the CRM.
const svWorkspaceCache = new Map();
let svWorkspaceRequest = 0;
let svActiveThreadTimer = null;
let svActiveThreadSyncAt = 0;
let svActiveThreadSyncInFlight = false;

async function svWorkspace(jid, method = 'GET', payload) {
    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (payload !== undefined) options.body = JSON.stringify(payload);
    const response = await fetch(`/api/contacts/${encodeURIComponent(jid)}/workspace`, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.message || 'Could not update contact workspace');
    const workspace = body.workspace || body;
    svWorkspaceCache.set(jid, workspace);
    return workspace;
}

function svDateLocal(offsetDays = 0) {
    const date = new Date(Date.now() + offsetDays * 86400000);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
}

function svSafeDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function svFollowupState(workspace = {}) {
    const value = workspace.followUpAt || workspace.followUpDate;
    if (!value) return null;
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) return null;
    const now = new Date();
    const today = when.toDateString() === now.toDateString();
    return { value, label: when < now ? 'Overdue' : today ? 'Due today' : svSafeDate(when), tone: when < now ? 'overdue' : today ? 'today' : 'upcoming' };
}

function svUpdateHeader(workspace = {}) {
    let badge = document.querySelector('#threadFollowupBadge');
    if (!badge) {
        const threadName = document.querySelector('#threadName');
        if (threadName) {
            badge = document.createElement('span');
            badge.id = 'threadFollowupBadge';
            badge.className = 'thread-followup-badge';
            threadName.insertAdjacentElement('afterend', badge);
        }
    }
    if (!badge) return;
    const status = svFollowupState(workspace);
    badge.hidden = !status;
    badge.className = `thread-followup-badge ${status?.tone || ''}`;
    badge.textContent = status ? `${status.label}${workspace.nextAction ? ` · ${workspace.nextAction}` : ''}` : '';
    badge.title = status ? `Next follow-up: ${svSafeDate(status.value)}` : '';
}

function svWorkspaceHtml(workspace = {}) {
    const priority = workspace.priority || 'Warm';
    const source = workspace.leadSource || 'manual';
    const interests = Array.isArray(workspace.interests) ? workspace.interests : [];
    const notes = Array.isArray(workspace.notes) && workspace.notes.length ? workspace.notes : (Array.isArray(workspace.crmNotes) ? workspace.crmNotes : []);
    const timeline = Array.isArray(workspace.timeline) ? workspace.timeline : [];
    const followup = svFollowupState(workspace);
    return `<section class="sv-sales-workspace">
        <div class="sv-workspace-head"><div><h3>Sales follow-up</h3>${followup ? `<small class="followup-summary ${followup.tone}">${escapeHtml(followup.label)} · ${escapeHtml(workspace.nextAction || 'Follow up')}</small>` : '<small>No follow-up scheduled</small>'}</div><span class="tag ${priority.toLowerCase()}">${escapeHtml(priority)}</span></div>
        <label>Priority<select id="svPriority">${['Hot', 'Warm', 'Cold'].map(value => `<option ${value === priority ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
        <label>Lead source<select id="svLeadSource">${['Website', 'LinkedIn', 'Campaign', 'Manual', 'Referral'].map(value => `<option value="${value.toLowerCase()}" ${value.toLowerCase() === source.toLowerCase() ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
        <label>Interested in<input id="svInterests" value="${escapeHtml(interests.join(', '))}" placeholder="CFP, speaker, registration"></label>
        <label>Next action<input id="svNextAction" value="${escapeHtml(workspace.nextAction || '')}" placeholder="Send brochure and follow up"></label>
        <label>Follow-up date & time<input id="svFollowUpAt" type="datetime-local" value="${workspace.followUpAt ? String(workspace.followUpAt).slice(0, 16) : ''}"></label>
        <div class="sv-workspace-actions"><button class="secondary-btn small" id="svRemindTomorrow">Tomorrow</button><button class="primary-btn small" id="svSaveWorkspace">Save follow-up</button>${followup ? '<button class="danger-btn small" id="svRemoveFollowup">Remove follow-up</button>' : ''}</div>
        <section class="sv-private-notes"><div><h4>Private internal notes</h4><span>Never sent to WhatsApp</span></div><textarea id="svNoteText" rows="3" placeholder="Add a private call note, context, or next step…"></textarea><button class="secondary-btn small" id="svAddNote">Add private note</button><div class="sv-note-list">${notes.slice(0, 10).map(note => `<article class="sv-note-row"><span><p>${escapeHtml(note.text || '')}</p><small>${svSafeDate(note.createdAt)}</small></span><button class="sv-note-delete" data-sv-delete-note="${escapeHtml(note.id || '')}" title="Delete private note">Delete</button></article>`).join('') || '<p class="muted">No private notes yet.</p>'}</div></section>
        <section class="sv-timeline"><h4>Contact timeline</h4>${timeline.slice(0, 10).map(item => `<div><span><b>${escapeHtml(item.label || item.type || 'Activity')}</b>${item.details ? `<em>${escapeHtml(item.details)}</em>` : ''}</span><small>${svSafeDate(item.createdAt)}</small></div>`).join('') || '<p>Timeline builds as you work with this contact.</p>'}</section>
    </section>`;
}

function svConfirm(message) { return window.confirm(message); }

function svBindWorkspace(holder, jid) {
    const save = async (extra = {}) => {
        const payload = {
            priority: holder.querySelector('#svPriority')?.value || 'Warm',
            leadSource: holder.querySelector('#svLeadSource')?.value || 'manual',
            interests: (holder.querySelector('#svInterests')?.value || '').split(',').map(x => x.trim()).filter(Boolean),
            nextAction: holder.querySelector('#svNextAction')?.value || '',
            followUpAt: holder.querySelector('#svFollowUpAt')?.value || null,
            ...extra
        };
        try {
            const value = await svWorkspace(jid, 'POST', payload);
            if (state.activeJid !== jid) return;
            holder.innerHTML = svWorkspaceHtml(value);
            svUpdateHeader(value);
            svBindWorkspace(holder, jid);
            toast(extra.note ? 'Private note added' : 'Follow-up saved', 'success');
        } catch (error) { toast(error.message, 'error'); }
    };
    holder.querySelector('#svSaveWorkspace')?.addEventListener('click', event => { event.preventDefault(); save(); });
    holder.querySelector('#svRemindTomorrow')?.addEventListener('click', event => { event.preventDefault(); const input = holder.querySelector('#svFollowUpAt'); if (input) input.value = svDateLocal(1); save(); });
    holder.querySelector('#svRemoveFollowup')?.addEventListener('click', async event => {
        event.preventDefault();
        if (!svConfirm('Remove this CRM follow-up? This does not delete any WhatsApp message.')) return;
        try {
            const response = await fetch(`/api/contacts/${encodeURIComponent(jid)}/followup`, { method: 'DELETE' });
            const body = await response.json().catch(() => ({}));
            if (!response.ok || body.success === false) throw new Error(body.message || 'Could not remove follow-up');
            const value = body.workspace || {};
            svWorkspaceCache.set(jid, value);
            holder.innerHTML = svWorkspaceHtml(value); svUpdateHeader(value); svBindWorkspace(holder, jid);
            toast('Follow-up removed', 'success');
        } catch (error) { toast(error.message, 'error'); }
    });
    holder.querySelector('#svAddNote')?.addEventListener('click', event => { event.preventDefault(); const text = holder.querySelector('#svNoteText')?.value.trim(); if (!text) return toast('Write a private note first', 'error'); save({ note: text }); });
    holder.querySelectorAll('[data-sv-delete-note]').forEach(button => button.addEventListener('click', async event => {
        event.preventDefault();
        const noteId = button.dataset.svDeleteNote;
        if (!noteId || !svConfirm('Delete this private note from the CRM?')) return;
        try {
            const response = await fetch(`/api/contacts/${encodeURIComponent(jid)}/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
            const body = await response.json().catch(() => ({}));
            if (!response.ok || body.success === false) throw new Error(body.message || 'Could not delete private note');
            const value = body.workspace || {};
            svWorkspaceCache.set(jid, value);
            holder.innerHTML = svWorkspaceHtml(value); svUpdateHeader(value); svBindWorkspace(holder, jid);
            toast('Private note deleted', 'success');
        } catch (error) { toast(error.message, 'error'); }
    }));
}

async function svEnhanceProfile(force = false) {
    const jid = state.activeJid;
    const target = document.querySelector('#profileFields');
    if (!jid || !target) return;
    let holder = document.querySelector('#svSalesWorkspace');
    if (!holder) { holder = document.createElement('div'); holder.id = 'svSalesWorkspace'; target.parentElement?.append(holder); }
    if (!force && holder.dataset.jid === jid && svWorkspaceCache.has(jid)) return;
    holder.dataset.jid = jid;
    const cached = svWorkspaceCache.get(jid);
    if (cached) { holder.innerHTML = svWorkspaceHtml(cached); svUpdateHeader(cached); svBindWorkspace(holder, jid); } else holder.innerHTML = '<section class="sv-sales-workspace workspace-loading">Loading CRM workspace…</section>';
    const token = ++svWorkspaceRequest;
    try {
        const workspace = await svWorkspace(jid);
        if (state.activeJid !== jid || token !== svWorkspaceRequest) return;
        holder.innerHTML = svWorkspaceHtml(workspace); svUpdateHeader(workspace); svBindWorkspace(holder, jid);
    } catch (error) { if (!cached) holder.innerHTML = `<section class="sv-sales-workspace"><p class="error-text">${escapeHtml(error.message)}</p></section>`; }
}

async function svRefreshActiveThread(jid) {
    if (!jid || document.hidden || state.view !== 'inbox' || state.activeJid !== jid) return;
    try {
        // Socket events are authoritative when available, but a phone can send
        // while the browser reconnects. Periodically backfill only this active
        // JID so the selected thread does not remain stale and other chats are
        // not needlessly queried.
        if (!svActiveThreadSyncInFlight && Date.now() - svActiveThreadSyncAt >= 10000) {
            svActiveThreadSyncInFlight = true;
            try {
                await fetch('/api/inbox/history-sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jids: [jid], limit: 100 })
                });
            } finally {
                svActiveThreadSyncAt = Date.now();
                svActiveThreadSyncInFlight = false;
            }
        }
        const response = await api(`/api/inbox/${encodeURIComponent(jid)}/thread?refresh=0`);
        const next = response.thread || [];
        const old = state.activeThread || [];
        const lastNext = next[next.length - 1] || {}, lastOld = old[old.length - 1] || {};
        const changed = next.length !== old.length || lastNext.id !== lastOld.id || lastNext.timestamp !== lastOld.timestamp || lastNext.status !== lastOld.status || JSON.stringify(lastNext.reactions || []) !== JSON.stringify(lastOld.reactions || []);
        if (changed) { state.activeThread = next; renderThread(); updateProfile(); }
    } catch (_) { /* Socket and manual refresh remain available when offline. */ }
}

function svStartThreadRefresh(jid) {
    clearInterval(svActiveThreadTimer);
    svActiveThreadSyncAt = 0;
    svActiveThreadSyncInFlight = false;
    if (jid) svActiveThreadTimer = setInterval(() => svRefreshActiveThread(jid), 4000);
}

const svOriginalOpenChat = window.openChat;
if (typeof svOriginalOpenChat === 'function') window.openChat = async (...args) => { const result = await svOriginalOpenChat(...args); await svEnhanceProfile(); svStartThreadRefresh(state.activeJid); return result; };
setTimeout(() => { svEnhanceProfile(); svStartThreadRefresh(state.activeJid); }, 250);

setTimeout(async () => { if (sessionStorage.getItem('sv-followup-reminders-shown')) return; try { const response = await fetch('/api/contacts/due-today'); const data = await response.json(); const due = data.due || []; if (due.length) toast(`${due.length} follow-up${due.length === 1 ? '' : 's'} due — ${due.slice(0, 2).map(x => x.name).join(', ')}`, 'warning'); sessionStorage.setItem('sv-followup-reminders-shown', '1'); } catch (_) {} }, 900);

document.querySelector('#messageInput')?.addEventListener('keydown', event => { if (event.key !== '/' || event.currentTarget.value.trim()) return; const replies = [{ label: 'Send brochure', text: 'Here is the conference brochure for your review.' }, { label: 'Registration link', text: 'Here is the registration link.' }, { label: 'CFP reminder', text: 'A quick reminder about the CFP deadline.' }, { label: 'Payment link', text: 'Here is the payment link for your registration.' }]; setTimeout(() => { const input = event.currentTarget; if (!input.value.startsWith('/')) return; document.querySelector('.sv-quick-replies')?.remove(); const menu = document.createElement('div'); menu.className = 'context-menu sv-quick-replies'; menu.style.left = `${input.getBoundingClientRect().left}px`; menu.style.top = `${Math.max(12, input.getBoundingClientRect().top - 190)}px`; menu.innerHTML = `<b>Quick replies</b>${replies.map(reply => `<button data-sv-reply="${escapeHtml(reply.text)}">${escapeHtml(reply.label)}</button>`).join('')}`; document.body.append(menu); menu.querySelectorAll('[data-sv-reply]').forEach(button => button.onclick = () => { input.value = button.dataset.svReply; menu.remove(); input.focus(); }); }, 0); });
