// Staged audience tools for the bulk campaign composer. Nothing here writes to
// CRM contacts: approval happens only when the campaign is launched.
function svBulkValue(raw, names) {
  const key = Object.keys(raw || {}).find(k => names.some(name => String(k).replace(/[\s_-]/g, '').toLowerCase() === name.replace(/[\s_-]/g, '').toLowerCase()));
  return key === undefined ? '' : raw[key];
}
function svNormalizeBulkRow(raw = {}, source = 'File') {
  let phone = String(svBulkValue(raw, ['Phone', 'Number', 'Mobile', 'WhatsApp']) || '').replace(/\D/g, '');
  let countryCode = String(svBulkValue(raw, ['CountryCode', 'Country Code', 'CC']) || '').replace(/\D/g, '');
  if (!countryCode && phone.length === 10) countryCode = '91';
  if (countryCode && phone && !phone.startsWith(countryCode)) phone = countryCode + phone;
  return { id: `bulk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, source, name: String(svBulkValue(raw, ['Name', 'Full Name']) || '').trim(), phone, countryCode, email: String(svBulkValue(raw, ['Email']) || '').trim(), country: String(svBulkValue(raw, ['Country']) || '').trim(), tags: String(svBulkValue(raw, ['Tags']) || '').split(/[|,]/).map(x => x.trim()).filter(Boolean), optIn: /^(yes|true|1)$/i.test(String(svBulkValue(raw, ['OptIn', 'Opt-in', 'Consent']) || '')), leadSource: String(svBulkValue(raw, ['LeadSource', 'Lead Source']) || '').trim(), excluded: false, formatValid: phone.length >= 10 };
}
async function svParseBulkFile(file) {
  if (!file) throw new Error('Choose a CSV or Excel file');
  if (!window.XLSX) throw new Error('Excel support is loading. Please retry in a moment.');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
  return rows.map(row => svNormalizeBulkRow(row, file.name)).filter(row => row.phone || row.email || row.name);
}
function svActiveBulkAudience() { return (state.campaignContacts || []).filter(row => !row.excluded && row.formatValid); }
function svRefreshBulkPreview() {
  const target = document.querySelector('#campaignPreview');
  if (target) target.textContent = `${svActiveBulkAudience().length} approved of ${(state.campaignContacts || []).length} staged contacts. Review before launch; CRM records are unchanged.`;
}
function svDownloadTemplate(format) {
  const rows = [{ Name: 'Dr. Aishwarya Devi', Phone: '9876543210', CountryCode: '91', Email: 'researcher@example.com', Country: 'India', Tags: 'Conference lead|CFP', OptIn: 'Yes', LeadSource: 'Website' }, { Name: 'Prof. Rahul Kumar', Phone: '9123456789', CountryCode: '91', Email: 'professor@example.com', Country: 'India', Tags: 'Speaker', OptIn: 'Yes', LeadSource: 'LinkedIn' }];
  if (format === 'xlsx' && window.XLSX) { const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Contacts'); XLSX.writeFile(book, 'ScholarVault_Bulk_Campaign_Template.xlsx'); return; }
  const headers = Object.keys(rows[0]); const csv = [headers.join(','), ...rows.map(row => headers.map(key => `"${String(row[key]).replace(/"/g, '""')}"`).join(','))].join('\r\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'ScholarVault_Bulk_Campaign_Template.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 500);
}
function svReviewBulkAudience() {
  const rows = state.campaignContacts || [];
  if (!rows.length) return toast('Load CRM, CSV, or Excel contacts first', 'error');
  const draw = () => {
    const query = document.querySelector('#bulkAudienceSearch')?.value.toLowerCase() || '';
    const shown = rows.filter(row => !query || `${row.name} ${row.phone} ${row.email} ${row.tags.join(' ')}`.toLowerCase().includes(query));
    document.querySelector('#bulkAudienceRows').innerHTML = shown.map(row => `<tr><td><input type="checkbox" data-bulk-include="${row.id}" ${row.excluded ? '' : 'checked'}></td><td><input data-bulk-name="${row.id}" value="${escapeHtml(row.name || '')}"></td><td><input data-bulk-phone="${row.id}" value="${escapeHtml(row.phone || '')}"></td><td>${row.countryCode || '—'}</td><td>${escapeHtml(row.email || '—')}</td><td>${escapeHtml(row.source || '—')}</td><td>${row.formatValid ? '<span class="tag success">Ready</span>' : '<span class="tag warning">Fix number</span>'}</td><td><button class="text-btn danger-text" data-bulk-remove="${row.id}">Remove</button></td></tr>`).join('') || '<tr><td colspan="8">No contacts match.</td></tr>';
    document.querySelectorAll('[data-bulk-include]').forEach(input => input.onchange = () => { const row = rows.find(value => value.id === input.dataset.bulkInclude); if (row) row.excluded = !input.checked; svRefreshBulkPreview(); });
    document.querySelectorAll('[data-bulk-name]').forEach(input => input.oninput = () => { const row = rows.find(value => value.id === input.dataset.bulkName); if (row) row.name = input.value; });
    document.querySelectorAll('[data-bulk-phone]').forEach(input => input.oninput = () => { const row = rows.find(value => value.id === input.dataset.bulkPhone); if (!row) return; row.phone = input.value.replace(/\D/g, ''); row.formatValid = row.phone.length >= 10; draw(); svRefreshBulkPreview(); });
    document.querySelectorAll('[data-bulk-remove]').forEach(button => button.onclick = () => { state.campaignContacts = state.campaignContacts.filter(value => value.id !== button.dataset.bulkRemove); svRefreshBulkPreview(); draw(); });
  };
  showDialog(`<div class="dialog-content audience-review"><p class="eyebrow">Bulk campaign audience</p><h2>Review staged contacts</h2><p class="muted">Edit, exclude, or remove recipients before queueing. These edits never overwrite existing CRM contacts.</p><input id="bulkAudienceSearch" placeholder="Search name, number, email, or tag"><div class="native-table audience-table"><table><thead><tr><th>Send</th><th>Name</th><th>Normalized number</th><th>CC</th><th>Email</th><th>Source</th><th>Check</th><th></th></tr></thead><tbody id="bulkAudienceRows"></tbody></table></div><div class="dialog-actions"><button class="secondary-btn" value="cancel">Close</button><button id="bulkAudienceApply" class="primary-btn" value="default">Use approved contacts</button></div></div>`);
  document.querySelector('#bulkAudienceSearch').oninput = draw;
  document.querySelector('#bulkAudienceApply').onclick = event => { event.preventDefault(); state.campaignContacts = rows.filter(row => !row.excluded); document.querySelector('#crmDialog').close(); svRefreshBulkPreview(); toast(`${svActiveBulkAudience().length} approved contacts ready`, 'success'); };
  draw();
}
document.querySelector('#campaignCsv')?.addEventListener('change', async event => { event.stopImmediatePropagation(); try { state.campaignContacts = await svParseBulkFile(event.target.files?.[0]); svRefreshBulkPreview(); toast(`${state.campaignContacts.length} contacts staged for review`, 'success'); } catch (error) { toast(error.message, 'error'); } }, true);
const svCampaignFile = document.querySelector('#campaignCsv');
if (svCampaignFile && !document.querySelector('#svBulkTools')) {
  const tools = document.createElement('div'); tools.id = 'svBulkTools'; tools.className = 'form-actions';
  tools.innerHTML = '<button class="secondary-btn small" data-action="campaign-review-audience">Review audience</button><button class="secondary-btn small" data-action="campaign-download-csv">Download CSV template</button><button class="secondary-btn small" data-action="campaign-download-xlsx">Download Excel template</button>';
  svCampaignFile.closest('.form-actions')?.insertAdjacentElement('afterend', tools);
}
document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!['campaign-crm-contacts', 'campaign-review-audience', 'campaign-download-csv', 'campaign-download-xlsx'].includes(action)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (action === 'campaign-crm-contacts') { state.campaignContacts = Object.values(state.contacts || {}).filter(contact => String(contact.jid || '').includes('@s.whatsapp.net')).map(contact => svNormalizeBulkRow({ Name: contact.name, Phone: String(contact.jid || '').split('@')[0], Email: contact.email || '', Country: contact.country || '', Tags: (contact.tags || []).join('|'), OptIn: contact.optIn ? 'Yes' : '', LeadSource: contact.leadSource || '' }, 'CRM')); svRefreshBulkPreview(); toast(`${state.campaignContacts.length} WhatsApp CRM contacts staged`, 'success'); }
  if (action === 'campaign-review-audience') svReviewBulkAudience();
  if (action === 'campaign-download-csv') svDownloadTemplate('csv');
  if (action === 'campaign-download-xlsx') svDownloadTemplate('xlsx');
}, true);
