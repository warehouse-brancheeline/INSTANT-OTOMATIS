const toggleEl = document.getElementById('toggle-enabled');
const employeeInput = document.getElementById('employee-id');
const saveEmployeeBtn = document.getElementById('save-employee');
const shipperInput = document.getElementById('shipper-nik');
const saveShipperBtn = document.getElementById('save-shipper');
const togglePrintPicklistEl = document.getElementById('toggle-print-picklist');
const dispatchDelayInput = document.getElementById('dispatch-delay-minutes');
const saveDispatchDelayBtn = document.getElementById('save-dispatch-delay');
const dispatchDelayLabelEl = document.getElementById('dispatch-delay-label');
const restrictInput = document.getElementById('restrict-order-no');
const saveRestrictBtn = document.getElementById('save-restrict');
const statusEl = document.getElementById('status');
const triggerPicklistBtn = document.getElementById('trigger-picklist');
const triggerPrintBtn = document.getElementById('trigger-print');
const triggerDispatchBtn = document.getElementById('trigger-dispatch');
const triggerResultEl = document.getElementById('trigger-result');
const manualPicklistBtn = document.getElementById('manual-picklist');
const manualPrintResiBtn = document.getElementById('manual-print-resi');
const manualSiapKirimBtn = document.getElementById('manual-siap-kirim');
const manualSelesaikanBtn = document.getElementById('manual-selesaikan');
const manualBuatPengirimanBtn = document.getElementById('manual-buat-pengiriman');
const manualPanggilDriverBtn = document.getElementById('manual-panggil-driver');
const manualResultEl = document.getElementById('manual-result');
const logGroupsEl = document.getElementById('log-groups');

const expandedGroups = new Set();

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

async function loadSettings() {
  const settings = await fetchJSON('/api/settings');
  toggleEl.checked = settings.feature_enabled === '1';
  employeeInput.value = settings.employee_id || '';
  shipperInput.value = settings.shipper_nik || '';
  togglePrintPicklistEl.checked = settings.print_picklist_enabled !== '0';
  dispatchDelayInput.value = settings.dispatch_delay_minutes || '30';
  dispatchDelayLabelEl.textContent = `${settings.dispatch_delay_minutes || '30'} menit`;
  restrictInput.value = settings.restrict_order_no || '';
}

async function loadStatus() {
  const status = await fetchJSON('/api/status');
  statusEl.innerHTML = `
    <div>Proses Instant: <strong>${status.featureEnabled ? 'AKTIF' : 'NONAKTIF'}</strong></div>
    <div>Picklist job berjalan: ${status.picklistRunning ? 'ya' : 'tidak'}</div>
    <div>Terakhir picklist: ${status.lastPicklistRun || '-'}</div>
    <div>Print job berjalan: ${status.printRunning ? 'ya' : 'tidak'}</div>
    <div>Terakhir print: ${status.lastPrintRun || '-'}</div>
    <div>Dispatch job berjalan: ${status.dispatchRunning ? 'ya' : 'tidak'}</div>
    <div>Terakhir dispatch: ${status.lastDispatchRun || '-'}</div>
  `;
}

function groupLogs(logs) {
  const groups = new Map();
  for (const l of logs) {
    const key = l.picklist_no || '(tanpa picklist)';
    if (!groups.has(key)) {
      groups.set(key, { key, entries: [], latestTs: l.ts, anyFail: false });
    }
    const g = groups.get(key);
    g.entries.push(l);
    if (l.ts > g.latestTs) g.latestTs = l.ts;
    if (!l.success) g.anyFail = true;
  }
  return Array.from(groups.values()).sort((a, b) => (a.latestTs < b.latestTs ? 1 : -1));
}

function renderEntryRow(l) {
  return `<tr>
    <td>${l.ts}</td>
    <td>${l.salesorder_no || '-'}</td>
    <td>${l.action}</td>
    <td class="${l.success ? 'badge-ok' : 'badge-fail'}">${l.success ? 'OK' : 'GAGAL'}</td>
    <td>${l.detail || ''}</td>
  </tr>`;
}

async function loadLogs() {
  const logs = await fetchJSON('/api/logs?limit=300');
  const groups = groupLogs(logs);

  logGroupsEl.innerHTML = groups
    .map((g) => {
      const isOpen = expandedGroups.has(g.key);
      const distinctOrders = new Set(g.entries.map((e) => e.salesorder_no)).size;
      return `
        <div class="log-group">
          <div class="log-group-header" data-key="${g.key}">
            <span class="log-group-caret">${isOpen ? '▾' : '▸'}</span>
            <span class="log-group-title">${g.key}</span>
            <span class="muted">${distinctOrders} resi</span>
            <span class="${g.anyFail ? 'badge-fail' : 'badge-ok'}">${g.anyFail ? 'ADA GAGAL' : 'OK'}</span>
            <span class="muted log-group-time">${g.latestTs}</span>
          </div>
          <div class="log-group-body" style="display:${isOpen ? 'block' : 'none'}">
            <table>
              <thead>
                <tr><th>Waktu</th><th>No. Order</th><th>Aksi</th><th>Status</th><th>Detail</th></tr>
              </thead>
              <tbody>${g.entries.map(renderEntryRow).join('')}</tbody>
            </table>
          </div>
        </div>
      `;
    })
    .join('');

  logGroupsEl.querySelectorAll('.log-group-header').forEach((header) => {
    header.addEventListener('click', () => {
      const key = header.dataset.key;
      if (expandedGroups.has(key)) {
        expandedGroups.delete(key);
      } else {
        expandedGroups.add(key);
      }
      loadLogs();
    });
  });
}

toggleEl.addEventListener('change', async () => {
  await fetchJSON('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature_enabled: toggleEl.checked }),
  });
  loadStatus();
});

togglePrintPicklistEl.addEventListener('change', async () => {
  await fetchJSON('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ print_picklist_enabled: togglePrintPicklistEl.checked }),
  });
});

saveEmployeeBtn.addEventListener('click', async () => {
  await fetchJSON('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: employeeInput.value }),
  });
  saveEmployeeBtn.textContent = 'Tersimpan';
  setTimeout(() => (saveEmployeeBtn.textContent = 'Simpan'), 1200);
});

saveShipperBtn.addEventListener('click', async () => {
  await fetchJSON('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shipper_nik: shipperInput.value }),
  });
  saveShipperBtn.textContent = 'Tersimpan';
  setTimeout(() => (saveShipperBtn.textContent = 'Simpan'), 1200);
});

saveDispatchDelayBtn.addEventListener('click', async () => {
  await fetchJSON('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dispatch_delay_minutes: dispatchDelayInput.value }),
  });
  dispatchDelayLabelEl.textContent = `${dispatchDelayInput.value} menit`;
  saveDispatchDelayBtn.textContent = 'Tersimpan';
  setTimeout(() => (saveDispatchDelayBtn.textContent = 'Simpan'), 1200);
});

saveRestrictBtn.addEventListener('click', async () => {
  await fetchJSON('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restrict_order_no: restrictInput.value }),
  });
  saveRestrictBtn.textContent = 'Tersimpan';
  setTimeout(() => (saveRestrictBtn.textContent = 'Simpan'), 1200);
});

triggerPicklistBtn.addEventListener('click', async () => {
  triggerResultEl.textContent = 'Menjalankan picklist job...';
  const result = await fetchJSON('/api/debug/run-picklist-now', { method: 'POST' });
  triggerResultEl.textContent = 'Picklist job: ' + JSON.stringify(result);
  loadStatus();
  loadLogs();
});

triggerPrintBtn.addEventListener('click', async () => {
  triggerResultEl.textContent = 'Menjalankan print job...';
  const result = await fetchJSON('/api/debug/run-print-now', { method: 'POST' });
  triggerResultEl.textContent = 'Print job: ' + JSON.stringify(result);
  loadStatus();
  loadLogs();
});

triggerDispatchBtn.addEventListener('click', async () => {
  triggerResultEl.textContent = 'Menjalankan dispatch job...';
  const result = await fetchJSON('/api/debug/run-dispatch-now', { method: 'POST' });
  triggerResultEl.textContent = 'Dispatch job: ' + JSON.stringify(result);
  loadStatus();
  loadLogs();
});

async function runManualAction(btn, label, url) {
  manualResultEl.textContent = `Menjalankan ${label}...`;
  const result = await fetchJSON(url, { method: 'POST' });
  manualResultEl.textContent = `${label}: ` + JSON.stringify(result);
  loadStatus();
  loadLogs();
}

manualPicklistBtn.addEventListener('click', () =>
  runManualAction(manualPicklistBtn, 'Picklist', '/api/debug/manual/picklist')
);
manualPrintResiBtn.addEventListener('click', () =>
  runManualAction(manualPrintResiBtn, 'Print Resi', '/api/debug/manual/print-resi')
);
manualSiapKirimBtn.addEventListener('click', () =>
  runManualAction(manualSiapKirimBtn, 'Siap Dikirim', '/api/debug/manual/siap-kirim')
);
manualSelesaikanBtn.addEventListener('click', () =>
  runManualAction(manualSelesaikanBtn, 'Selesaikan', '/api/debug/manual/selesaikan')
);
manualBuatPengirimanBtn.addEventListener('click', () =>
  runManualAction(manualBuatPengirimanBtn, 'Buat Pengiriman', '/api/debug/manual/buat-pengiriman')
);
manualPanggilDriverBtn.addEventListener('click', () =>
  runManualAction(manualPanggilDriverBtn, 'Panggil Driver', '/api/debug/manual/panggil-driver')
);

function refreshAll() {
  loadStatus();
  loadLogs();
}

loadSettings();
refreshAll();
setInterval(refreshAll, 5000);
