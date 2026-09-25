(() => {
  const fallback = window.renderNativeModule || window.loadLegacyModule;
  const root = () => document.getElementById('moduleContent');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const array = (value, keys = []) => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    for (const key of [...keys, 'items', 'rows', 'results', 'records', 'data']) {
      if (Array.isArray(value[key])) return value[key];
      if (value[key] && typeof value[key] === 'object') {
        const nested = array(value[key]);
        if (nested.length) return nested;
      }
    }
    return [];
  };
  const toast = (message, type = 'success') => window.showToast ? window.showToast(message, type) : alert(message);
  const icons = () => window.lucide?.createIcons();
  const api = async (url, options = {}) => {
    const response = await fetch(url, { headers: { 'Content-Type':'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.message || data.error || `Request failed (${response.status})`);
    return data;
  };
  const firstVariation = text => String(text || '').replace(/{{name}}/g, 'Dr. Researcher').replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, values) => values.split('|')[0]);
  const navigate = view => document.querySelector(`[data-view="${view}"]`)?.click();
  const setScheduledField = (view, id, date) => {
    navigate(view);
    let attempts = 0;
    const timer = setInterval(() => {
      const field = document.getElementById(id);
      if (field) { field.value = date; field.dispatchEvent(new Event('change', { bubbles:true })); clearInterval(timer); }
      if (++attempts > 15) clearInterval(timer);
    }, 100);
  };

  async function templates() {
    let channel = 'wa';
    let selected = null;
    let wa = JSON.parse(localStorage.getItem('sv_wa_templates') || '[]');
    const emailResponse = await api('/api/email/templates').catch(() => ({ templates:[] }));
    let email = array(emailResponse.templates ?? emailResponse.data?.templates ?? emailResponse);
    root().innerHTML = `<div class="premium-shell"><div class="premium-toolbar"><div><span class="premium-kicker">Content studio</span><h2>Templates</h2><p>Create, preview and maintain every WhatsApp and email message in one place.</p></div><button class="primary-btn" id="premiumNewTemplate"><i data-lucide="plus"></i> New template</button></div><div class="premium-tabs"><button class="active" data-channel="wa">WhatsApp & Spintax</button><button data-channel="email">Email HTML</button></div><div class="premium-grid"><section class="premium-card premium-library"><div class="library-head"><h3>Template library</h3><input id="templateSearch" placeholder="Search templates"></div><div id="premiumTemplateList"></div></section><section class="premium-card premium-editor"><div class="editor-head"><div><span class="premium-kicker" id="editorMode">New WhatsApp template</span><h3 id="editorTitle">Compose template</h3></div><button class="secondary-btn" id="clearTemplate">Clear</button></div><div class="premium-form"><label>Template name<input id="premiumTemplateName" placeholder="e.g. ICAHCR registration follow-up"></label><label id="subjectWrap" hidden>Email subject<input id="premiumTemplateSubject" placeholder="e.g. Your ICAHCR invitation"></label><label><span id="bodyLabel">Message with Spintax</span><textarea id="premiumTemplateBody" rows="15" placeholder="Write your reusable message..."></textarea></label><div class="premium-actions"><button class="secondary-btn danger" id="deleteTemplate" hidden>Delete</button><button class="primary-btn" id="saveTemplate"><i data-lucide="save"></i> Save template</button></div></div></section><aside class="premium-card premium-preview"><div class="preview-head"><div><span class="premium-kicker">Live preview</span><h3>Recipient view</h3></div><span class="preview-chip" id="previewChannel">WhatsApp</span></div><div id="premiumTemplatePreview" class="message-preview"></div><p class="preview-help" id="previewHelp">Spintax shows the first variation. The sender rotates it during campaigns.</p></aside></div></div>`;
    const list = () => channel === 'wa' ? wa : email;
    const bodyOf = item => item?.message || item?.content || item?.body || item?.htmlBody || item?.html || '';
    const drawPreview = () => {
      const subject = document.getElementById('premiumTemplateSubject').value;
      const body = document.getElementById('premiumTemplateBody').value;
      const preview = document.getElementById('premiumTemplatePreview');
      if (channel === 'email') {
        preview.innerHTML = `<div class="email-subject"><b>Subject:</b> ${esc(subject || 'Your subject')}</div><iframe sandbox="" title="Email preview"></iframe>`;
        preview.querySelector('iframe').srcdoc = body || '<div style="font-family:Arial;padding:24px;color:#667085">Start writing to preview your email.</div>';
      } else preview.innerHTML = `<div class="wa-preview-bubble">${esc(firstVariation(body) || 'Start writing to preview your WhatsApp message.').replace(/\n/g, '<br>')}</div>`;
    };
    const edit = index => {
      selected = index;
      const item = index === null ? {} : list()[index] || {};
      document.getElementById('premiumTemplateName').value = item.name || '';
      document.getElementById('premiumTemplateSubject').value = item.subject || '';
      document.getElementById('premiumTemplateBody').value = bodyOf(item);
      document.getElementById('editorMode').textContent = `${index === null ? 'New' : 'Editing'} ${channel === 'wa' ? 'WhatsApp' : 'email'} template`;
      document.getElementById('editorTitle').textContent = item.name || 'Compose template';
      document.getElementById('deleteTemplate').hidden = index === null;
      drawPreview();
    };
    const drawList = () => {
      const query = document.getElementById('templateSearch').value.toLowerCase();
      const matches = list().map((item, index) => ({ item, index })).filter(({ item }) => `${item.name || ''} ${item.subject || ''} ${bodyOf(item)}`.toLowerCase().includes(query));
      document.getElementById('premiumTemplateList').innerHTML = matches.map(({ item, index }) => `<button class="premium-list-item ${selected === index ? 'active' : ''}" data-index="${index}"><span><strong>${esc(item.name || item.subject || 'Untitled template')}</strong><small>${esc(firstVariation(bodyOf(item)).replace(/\s+/g, ' ').slice(0, 115))}</small></span><i data-lucide="chevron-right"></i></button>`).join('') || '<div class="premium-empty">No templates found.</div>';
      document.querySelectorAll('#premiumTemplateList [data-index]').forEach(button => button.onclick = () => { edit(Number(button.dataset.index)); drawList(); });
      icons();
    };
    const switchChannel = next => {
      channel = next; selected = null;
      document.querySelectorAll('[data-channel]').forEach(button => button.classList.toggle('active', button.dataset.channel === channel));
      document.getElementById('subjectWrap').hidden = channel !== 'email';
      document.getElementById('bodyLabel').textContent = channel === 'email' ? 'HTML email content' : 'Message with Spintax';
      document.getElementById('previewChannel').textContent = channel === 'email' ? 'Email' : 'WhatsApp';
      document.getElementById('previewHelp').textContent = channel === 'email' ? 'HTML is rendered in an isolated preview.' : 'Spintax shows the first variation. The sender rotates it during campaigns.';
      edit(null); drawList();
    };
    document.querySelectorAll('[data-channel]').forEach(button => button.onclick = () => switchChannel(button.dataset.channel));
    document.getElementById('templateSearch').oninput = drawList;
    document.getElementById('premiumTemplateName').oninput = () => { document.getElementById('editorTitle').textContent = document.getElementById('premiumTemplateName').value || 'Compose template'; };
    document.getElementById('premiumTemplateSubject').oninput = drawPreview;
    document.getElementById('premiumTemplateBody').oninput = drawPreview;
    document.getElementById('premiumNewTemplate').onclick = () => edit(null);
    document.getElementById('clearTemplate').onclick = () => edit(null);
    document.getElementById('saveTemplate').onclick = async () => {
      const name = document.getElementById('premiumTemplateName').value.trim();
      const subject = document.getElementById('premiumTemplateSubject').value.trim();
      const body = document.getElementById('premiumTemplateBody').value.trim();
      if (!name || !body || (channel === 'email' && !subject)) return toast('Complete the template name, content and subject.', 'error');
      try {
        if (channel === 'wa') {
          const item = { ...(selected === null ? {} : wa[selected]), name, message:body };
          selected === null ? wa.unshift(item) : wa[selected] = item;
          localStorage.setItem('sv_wa_templates', JSON.stringify(wa)); window.loadTemplateSelectors?.(); selected = selected === null ? 0 : selected;
        } else {
          const current = selected === null ? {} : email[selected];
          await api('/api/email/templates', { method:'POST', body:JSON.stringify({ id:current?.id, name, subject, htmlBody:body, textBody:body.replace(/<[^>]+>/g, ' ') }) });
          const refreshed = await api('/api/email/templates'); email = array(refreshed.templates ?? refreshed.data?.templates ?? refreshed); selected = email.findIndex(item => item.name === name);
        }
        toast('Template saved'); drawList(); edit(selected);
      } catch (error) { toast(error.message, 'error'); }
    };
    document.getElementById('deleteTemplate').onclick = async () => {
      if (selected === null || !confirm('Delete this template? This cannot be undone.')) return;
      try { if (channel === 'wa') { wa.splice(selected, 1); localStorage.setItem('sv_wa_templates', JSON.stringify(wa)); window.loadTemplateSelectors?.(); } else { await api(`/api/email/templates/${encodeURIComponent(email[selected].id)}`, { method:'DELETE' }); const refreshed = await api('/api/email/templates'); email = array(refreshed.templates ?? refreshed.data?.templates ?? refreshed); } selected = null; edit(null); drawList(); toast('Template deleted'); } catch (error) { toast(error.message, 'error'); }
    };
    switchChannel('wa'); icons();
  }

  async function calendar() {
    const [waData, emailData, followData] = await Promise.all([api('/api/campaigns').catch(() => ({})), api('/api/email/campaigns').catch(() => ({})), api('/api/contacts/follow-ups').catch(() => ({ followUps:[] }))]);
    const normalize = (value, type) => {
      const source = value?.campaigns || value?.followUps || value?.data || value || [];
      const rows = Array.isArray(source) ? source : Object.values(source || {});
      return rows.map(item => ({ ...item, type, at:item.scheduledFor || item.schedule || item.followUpAt || item.followUpDate || item.createdAt }));
    };
    const events = [...normalize(waData, 'WhatsApp'), ...normalize(emailData, 'Email'), ...normalize(followData, 'Follow-up')].filter(item => item.at && !Number.isNaN(new Date(item.at).getTime()));
    let cursor = new Date(); cursor.setDate(1); let selectedDate = new Date();
    root().innerHTML = `<div class="premium-shell"><div class="premium-toolbar"><div><span class="premium-kicker">Planning workspace</span><h2>Campaign calendar</h2><p>Plan future work here. Campaign History remains the permanent delivery and failure archive.</p></div><div class="premium-actions"><button class="secondary-btn" data-open-history>Open history</button><button class="primary-btn" id="planCampaign"><i data-lucide="plus"></i> Plan campaign</button></div></div><div class="premium-grid calendar-layout"><section class="premium-card calendar-card"><div class="calendar-toolbar"><button class="icon-btn soft" id="monthBack"><i data-lucide="chevron-left"></i></button><h3 id="calendarMonth"></h3><button class="icon-btn soft" id="monthNext"><i data-lucide="chevron-right"></i></button></div><div class="calendar-weekdays">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => `<span>${day}</span>`).join('')}</div><div id="calendarGrid" class="calendar-grid"></div></section><aside class="premium-card calendar-agenda"><span class="premium-kicker">Selected day</span><h3 id="selectedDateTitle"></h3><div id="dayAgenda"></div><hr><h3>Schedule new</h3><label>Time<input id="plannerTime" type="time" value="10:00"></label><div class="planner-actions"><button class="secondary-btn" id="planEmail"><i data-lucide="mail"></i> Email</button><button class="primary-btn" id="planWhatsApp"><i data-lucide="message-circle"></i> WhatsApp</button></div></aside></div></div>`;
    const key = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    const drawAgenda = () => {
      document.getElementById('selectedDateTitle').textContent = selectedDate.toLocaleDateString(undefined, { weekday:'long', day:'numeric', month:'long' });
      const day = events.filter(item => key(new Date(item.at)) === key(selectedDate));
      document.getElementById('dayAgenda').innerHTML = day.map(item => `<article class="agenda-item"><span class="agenda-dot ${item.type.toLowerCase()}"></span><div><strong>${esc(item.name || item.nextAction || item.subject || item.type)}</strong><small>${esc(item.type)} · ${new Date(item.at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</small></div><span class="status-pill">${esc(item.status || 'planned')}</span></article>`).join('') || '<div class="premium-empty compact">Nothing scheduled. Choose a channel below.</div>';
    };
    const draw = () => {
      document.getElementById('calendarMonth').textContent = cursor.toLocaleDateString(undefined, { month:'long', year:'numeric' });
      const first = new Date(cursor), offset = (first.getDay()+6)%7, total = new Date(cursor.getFullYear(), cursor.getMonth()+1, 0).getDate();
      let html = ''.padStart(0); for (let i=0; i<offset; i++) html += '<div class="calendar-day muted-day"></div>';
      for (let day=1; day<=total; day++) { const date = new Date(cursor.getFullYear(), cursor.getMonth(), day), count = events.filter(item => key(new Date(item.at)) === key(date)).length; html += `<button class="calendar-day ${key(date) === key(selectedDate) ? 'selected' : ''}" data-date="${key(date)}"><span>${day}</span>${count ? `<b>${count} item${count>1?'s':''}</b>` : ''}</button>`; }
      document.getElementById('calendarGrid').innerHTML = html;
      document.querySelectorAll('[data-date]').forEach(button => button.onclick = () => { selectedDate = new Date(`${button.dataset.date}T12:00:00`); draw(); drawAgenda(); }); icons();
    };
    const scheduled = () => `${key(selectedDate)}T${document.getElementById('plannerTime').value || '10:00'}`;
    document.getElementById('monthBack').onclick = () => { cursor.setMonth(cursor.getMonth()-1); draw(); };
    document.getElementById('monthNext').onclick = () => { cursor.setMonth(cursor.getMonth()+1); draw(); };
    document.getElementById('planEmail').onclick = () => setScheduledField('unified', 'emailSchedule', scheduled());
    document.getElementById('planWhatsApp').onclick = () => setScheduledField('campaign', 'campaignSchedule', scheduled());
    document.getElementById('planCampaign').onclick = () => document.getElementById('planWhatsApp').click();
    document.querySelector('[data-open-history]').onclick = () => navigate('campaign-history');
    draw(); drawAgenda(); icons();
  }

  async function settings() {
    const [emailData, sendpulseData, aiData, packData, health] = await Promise.all([api('/api/email/settings').catch(() => ({ settings:{} })), api('/api/settings/sendpulse').catch(() => ({ settings:{} })), api('/api/ai-settings').catch(() => ({ settings:{} })), api('/api/resource-packs').catch(() => ({ packs:[] })), api('/api/health').catch(() => ({}))]);
    const email = emailData.settings || emailData.data?.settings || emailData || {}, sendpulse = sendpulseData.settings || sendpulseData.data?.settings || sendpulseData || {}, ai = aiData.settings || aiData.data?.settings || aiData || {}, packs = array(packData.packs ?? packData.data?.packs ?? packData);
    root().innerHTML = `<div class="premium-shell"><div class="premium-toolbar"><div><span class="premium-kicker">Administration</span><h2>Settings</h2><p>Credentials, providers and reusable conference resources belong here.</p></div><span class="health-badge ${health.connected ? 'good' : ''}">${health.connected ? 'WhatsApp connected' : 'Local service'}</span></div><div class="settings-layout"><nav class="premium-card settings-nav"><button class="active" data-settings-tab="general"><i data-lucide="sliders-horizontal"></i> General</button><button data-settings-tab="ai"><i data-lucide="bot"></i> AI & automation</button><button data-settings-tab="email"><i data-lucide="mail-check"></i> Email providers</button><button data-settings-tab="packs"><i data-lucide="package-open"></i> Resource packs</button><button data-settings-tab="whatsapp"><i data-lucide="message-circle"></i> WhatsApp</button></nav><section class="premium-card settings-panel" id="settingsPanel"></section></div></div>`;
    const panel = document.getElementById('settingsPanel');
    const draw = tab => {
      document.querySelectorAll('[data-settings-tab]').forEach(button => button.classList.toggle('active', button.dataset.settingsTab === tab));
      if (tab === 'general') panel.innerHTML = `<span class="premium-kicker">Local operations</span><h3>ScholarVault CRM</h3><div class="settings-callout"><i data-lucide="shield-check"></i><div><strong>Protected local workspace</strong><p>The CRM runs on this computer. Cloudflare is not required for WhatsApp or email sending.</p></div></div><div class="setting-row"><div><strong>Theme</strong><p>Saved in this browser.</p></div><button class="secondary-btn" id="toggleThemeSetting">Switch theme</button></div><div class="setting-row"><div><strong>Provider event tracking</strong><p>Delivered, opened, clicked and bounce telemetry needs a public webhook. Sending remains available without it.</p></div><span class="status-pill">Deferred</span></div>`;
      if (tab === 'ai') panel.innerHTML = `<span class="premium-kicker">Mistral control</span><h3>AI & automation settings</h3><p class="panel-intro">The global Master AI switch overrides every individual chat switch.</p><div class="premium-form two-column"><label>Mistral API key<input id="settingAiKey" type="password" placeholder="Leave blank to keep existing key"></label><label>Model<input id="settingAiModel" value="${esc(ai.model || 'open-mistral-nemo')}"></label><label class="check-row"><input id="settingAiEnabled" type="checkbox" ${ai.enabled ? 'checked' : ''}> Enable smart replies when Master AI is on</label></div><div class="premium-actions"><button class="secondary-btn" id="testAiSetting">Test safely</button><button class="primary-btn" id="saveAiSetting">Save AI settings</button></div><div id="aiSettingResult" class="settings-result"></div>`;
      if (tab === 'email') panel.innerHTML = `<span class="premium-kicker">Delivery infrastructure</span><h3>Email providers</h3><p class="panel-intro">Brevo is primary. SendPulse is used only when you explicitly choose overflow.</p><div class="provider-grid"><article><div class="provider-title"><strong>Brevo</strong><span class="status-pill">Primary</span></div><label>API key<input id="brevoKey" type="password" placeholder="Leave blank to keep saved key"></label><label>Sender name<input id="brevoName" value="${esc(email.senderName || email.defaultSenderName || 'ScholarVault')}"></label><label>Verified sender email<input id="brevoEmail" value="${esc(email.senderEmail || email.verifiedSenderEmail || '')}"></label><label>Daily capacity policy<input id="brevoCapacity" type="number" value="${esc(email.dailyCapacity || 300)}"></label><div class="premium-actions"><button class="secondary-btn" id="testBrevo">Test</button><button class="primary-btn" id="saveBrevo">Save</button></div></article><article><div class="provider-title"><strong>SendPulse</strong><span class="status-pill">Fallback</span></div><label>Client ID<input id="spClient" value="${esc(sendpulse.clientId || sendpulse.client_id || '')}"></label><label>Client secret<input id="spSecret" type="password" placeholder="Leave blank to keep saved secret"></label><label>Sender name<input id="spName" value="${esc(sendpulse.senderName || 'ScholarVault Conferences')}"></label><label>Sender email<input id="spEmail" value="${esc(sendpulse.senderEmail || '')}"></label><div class="premium-actions"><button class="secondary-btn" id="testSendpulse">Test</button><button class="primary-btn" id="saveSendpulse">Save</button></div></article></div><div id="providerResult" class="settings-result"></div>`;
      if (tab === 'packs') panel.innerHTML = `<div class="panel-title-row"><div><span class="premium-kicker">One-click sales assets</span><h3>Conference resource packs</h3></div><button class="primary-btn" id="newPack"><i data-lucide="plus"></i> New pack</button></div><p class="panel-intro">Inbox actions prefill these resources for operator review. They never send automatically.</p><div id="packList" class="pack-list">${packs.map((pack, index) => `<article><div><strong>${esc(pack.name)}</strong><p>${esc(pack.registrationLink || pack.brochureLink || 'No links configured')}</p></div><div class="premium-actions"><button class="secondary-btn" data-pack-edit="${index}">Edit</button><button class="secondary-btn danger" data-pack-delete="${index}">Delete</button></div></article>`).join('') || '<div class="premium-empty">No resource packs yet.</div>'}</div>`;
      if (tab === 'whatsapp') panel.innerHTML = `<span class="premium-kicker">Evolution API</span><h3>WhatsApp connection</h3><div class="settings-callout"><i data-lucide="${health.connected ? 'circle-check-big' : 'circle-alert'}"></i><div><strong>${health.connected ? 'Instance connected' : 'Connection needs attention'}</strong><p>${esc(health.instance || health.instanceName || 'ScholarVault')} · localhost:8080</p></div></div><div class="premium-actions"><button class="primary-btn" id="manageInstances">Manage instances and QR</button></div>`;
      bind(tab); icons();
    };
    const packEditor = (pack = {}) => {
      panel.innerHTML = `<span class="premium-kicker">Resource pack editor</span><h3>${pack.id ? 'Edit' : 'Create'} conference pack</h3><div class="premium-form two-column"><label>Pack name<input id="packName" value="${esc(pack.name || '')}"></label><label>Brochure file or link<input id="packBrochure" value="${esc(pack.brochureLink || pack.brochure || '')}"></label><label>Registration link<input id="packRegistration" value="${esc(pack.registrationLink || '')}"></label><label>Payment link<input id="packPayment" value="${esc(pack.paymentLink || '')}"></label><label class="full">CFP reminder message<textarea id="packCfp" rows="5">${esc(pack.cfpReminder || '')}</textarea></label><label class="full">Brochure message<textarea id="packMessage" rows="5">${esc(pack.brochureMessage || '')}</textarea></label></div><div class="premium-actions"><button class="secondary-btn" id="cancelPack">Cancel</button><button class="primary-btn" id="savePack">Save resource pack</button></div>`;
      document.getElementById('cancelPack').onclick = () => draw('packs');
      document.getElementById('savePack').onclick = async () => { try { await api('/api/resource-packs', { method:'POST', body:JSON.stringify({ id:pack.id, name:document.getElementById('packName').value, brochureLink:document.getElementById('packBrochure').value, registrationLink:document.getElementById('packRegistration').value, paymentLink:document.getElementById('packPayment').value, cfpReminder:document.getElementById('packCfp').value, brochureMessage:document.getElementById('packMessage').value }) }); toast('Resource pack saved'); settings(); } catch (error) { toast(error.message, 'error'); } };
    };
    const bind = tab => {
      if (tab === 'general') document.getElementById('toggleThemeSetting').onclick = () => document.getElementById('themeToggle')?.click();
      if (tab === 'whatsapp') document.getElementById('manageInstances').onclick = () => navigate('instances');
      if (tab === 'ai') {
        document.getElementById('saveAiSetting').onclick = async () => { const body = { model:document.getElementById('settingAiModel').value, enabled:document.getElementById('settingAiEnabled').checked }; const key = document.getElementById('settingAiKey').value; if (key) body.apiKey = key; try { await api('/api/ai-settings', { method:'POST', body:JSON.stringify(body) }); toast('AI settings saved'); } catch (error) { toast(error.message, 'error'); } };
        document.getElementById('testAiSetting').onclick = async () => { try { const data = await api('/api/ai-test', { method:'POST', body:JSON.stringify({ message:'Tell a conference prospect how ScholarVault can help.' }) }); document.getElementById('aiSettingResult').textContent = data.reply || 'Connection successful.'; } catch (error) { toast(error.message, 'error'); } };
      }
      if (tab === 'email') {
        document.getElementById('saveBrevo').onclick = async () => { const body = { senderName:document.getElementById('brevoName').value, senderEmail:document.getElementById('brevoEmail').value, dailyCapacity:Number(document.getElementById('brevoCapacity').value) }; if (document.getElementById('brevoKey').value) body.apiKey = document.getElementById('brevoKey').value; try { await api('/api/email/settings', { method:'POST', body:JSON.stringify(body) }); toast('Brevo settings saved'); } catch (error) { toast(error.message, 'error'); } };
        document.getElementById('testBrevo').onclick = async () => { try { const data = await api('/api/email/test-connection', { method:'POST', body:'{}' }); document.getElementById('providerResult').textContent = data.message || 'Brevo connection successful.'; } catch (error) { toast(error.message, 'error'); } };
        document.getElementById('saveSendpulse').onclick = async () => { const body = { clientId:document.getElementById('spClient').value, senderName:document.getElementById('spName').value, senderEmail:document.getElementById('spEmail').value }; if (document.getElementById('spSecret').value) body.clientSecret = document.getElementById('spSecret').value; try { await api('/api/settings/sendpulse', { method:'POST', body:JSON.stringify(body) }); toast('SendPulse settings saved'); } catch (error) { toast(error.message, 'error'); } };
        document.getElementById('testSendpulse').onclick = async () => { try { const data = await api('/api/sendpulse/test'); document.getElementById('providerResult').textContent = data.message || 'SendPulse connection successful.'; } catch (error) { toast(error.message, 'error'); } };
      }
      if (tab === 'packs') {
        document.getElementById('newPack').onclick = () => packEditor();
        document.querySelectorAll('[data-pack-edit]').forEach(button => button.onclick = () => packEditor(packs[Number(button.dataset.packEdit)]));
        document.querySelectorAll('[data-pack-delete]').forEach(button => button.onclick = async () => { const pack = packs[Number(button.dataset.packDelete)]; if (!confirm(`Delete ${pack.name}?`)) return; await api(`/api/resource-packs/${encodeURIComponent(pack.id)}`, { method:'DELETE' }); settings(); });
      }
    };
    document.querySelectorAll('[data-settings-tab]').forEach(button => button.onclick = () => draw(button.dataset.settingsTab)); draw('general'); icons();
  }

  async function abTests() {
    const testsResponse = await api('/api/email/ab-tests').catch(() => ({ tests:[] }));
    let tests = array(testsResponse.tests ?? testsResponse.data?.tests ?? testsResponse);
    root().innerHTML = `<div class="premium-shell"><div class="premium-toolbar"><div><span class="premium-kicker">Experiment studio</span><h2>Email A/B tests</h2><p>Compare subject lines or email bodies, then choose the winner manually in local mode.</p></div><span class="tracking-note"><i data-lucide="info"></i> Automatic open/click winner requires webhook tracking</span></div><div class="ab-layout"><section class="premium-card ab-builder"><div class="premium-form"><label>Experiment name<input id="abName" placeholder="e.g. ICAHCR speaker invitation"></label><div class="variant-grid"><article><span class="variant-label">Variant A</span><label>Subject<input id="abSubjectA"></label><label>HTML content<textarea id="abHtmlA" rows="10"></textarea></label></article><article><span class="variant-label purple">Variant B</span><label>Subject<input id="abSubjectB"></label><label>HTML content<textarea id="abHtmlB" rows="10"></textarea></label></article></div><label>Audience — email, name per line<textarea id="abAudience" rows="6" placeholder="researcher@example.com, Dr. Researcher"></textarea></label><div class="inline-fields"><label>Test sample percentage<input id="abSplit" type="number" min="10" max="50" value="20"></label><label class="check-row"><input id="abOptin" type="checkbox" checked> Require recorded opt-in</label></div><div class="premium-actions"><button class="secondary-btn" id="previewVariant">Preview A</button><button class="primary-btn" id="createAbTest"><i data-lucide="flask-conical"></i> Create experiment</button></div></div></section><aside class="premium-card ab-side"><span class="premium-kicker">Live preview</span><h3 id="abPreviewTitle">Variant A</h3><div id="abPreview" class="message-preview"><div class="premium-empty compact">Start writing Variant A.</div></div><hr><h3>Experiments</h3><div id="abTestList">${tests.map((test, index) => `<article class="ab-test-row"><div><strong>${esc(test.name)}</strong><small>${esc(test.status || 'draft')} · ${array(test.audience).length} recipients</small></div><button class="secondary-btn" data-review-test="${index}">Review</button></article>`).join('') || '<div class="premium-empty compact">No experiments created yet.</div>'}</div></aside></div></div>`;
    let preview = 'A';
    const drawPreview = () => { const subject = document.getElementById(`abSubject${preview}`).value, html = document.getElementById(`abHtml${preview}`).value; document.getElementById('abPreviewTitle').textContent = `Variant ${preview}`; document.getElementById('abPreview').innerHTML = `<div class="email-subject"><b>Subject:</b> ${esc(subject || 'Your subject')}</div><iframe sandbox=""></iframe>`; document.querySelector('#abPreview iframe').srcdoc = html || '<div style="font-family:Arial;padding:24px;color:#667085">Start writing to preview this variant.</div>'; };
    ['A','B'].forEach(id => { document.getElementById(`abSubject${id}`).oninput = () => preview === id && drawPreview(); document.getElementById(`abHtml${id}`).oninput = () => preview === id && drawPreview(); });
    document.getElementById('previewVariant').onclick = () => { preview = preview === 'A' ? 'B' : 'A'; document.getElementById('previewVariant').textContent = `Preview ${preview === 'A' ? 'B' : 'A'}`; drawPreview(); };
    document.getElementById('createAbTest').onclick = async () => { const contacts = document.getElementById('abAudience').value.split(/\n+/).map(line => { const [email, name] = line.split(',').map(value => value.trim()); return { email, name, optIn:true }; }).filter(contact => contact.email); try { await api('/api/email/ab-tests', { method:'POST', body:JSON.stringify({ name:document.getElementById('abName').value, variants:[{ id:'A', subject:document.getElementById('abSubjectA').value, htmlBody:document.getElementById('abHtmlA').value }, { id:'B', subject:document.getElementById('abSubjectB').value, htmlBody:document.getElementById('abHtmlB').value }], contacts, splitPercent:Number(document.getElementById('abSplit').value), requireOptIn:document.getElementById('abOptin').checked }) }); toast('A/B experiment created'); abTests(); } catch (error) { toast(error.message, 'error'); } };
    document.querySelectorAll('[data-review-test]').forEach(button => button.onclick = () => { const test = tests[Number(button.dataset.reviewTest)]; const choices = array(test.variants).map(variant => `<button class="secondary-btn" data-winner="${esc(variant.id)}">Choose ${esc(variant.id)} as winner</button>`).join(''); document.getElementById('abPreview').innerHTML = `<div class="review-test"><strong>${esc(test.name)}</strong><p>${esc(test.notes || 'Review the variants and choose a winner.')}</p><div class="premium-actions">${choices}<button class="secondary-btn danger" id="cancelAb">Cancel test</button></div></div>`; document.querySelectorAll('[data-winner]').forEach(choice => choice.onclick = async () => { await api(`/api/email/ab-tests/${encodeURIComponent(test.id)}/winner`, { method:'POST', body:JSON.stringify({ variantId:choice.dataset.winner }) }); toast('Winner selected'); abTests(); }); document.getElementById('cancelAb').onclick = async () => { await api(`/api/email/ab-tests/${encodeURIComponent(test.id)}/cancel`, { method:'POST', body:'{}' }); toast('Experiment cancelled'); abTests(); }; });
    drawPreview(); icons();
  }

  const premium = { calendar, templates, settings, 'ab-tests':abTests };
  const render = async view => {
    if (!premium[view]) return fallback?.(view);
    root().innerHTML = '<div class="premium-empty">Loading workspace…</div>';
    try { await premium[view](); } catch (error) { console.error(`[Premium CRM ${view}]`, error); root().innerHTML = `<section class="premium-card"><h2>Could not load this workspace</h2><p>${esc(error.message)}</p><button class="secondary-btn" id="premiumRetry">Retry</button></section>`; document.getElementById('premiumRetry').onclick = () => render(view); }
    icons();
  };
  window.renderNativeModule = render;
  window.loadLegacyModule = render;
})();
