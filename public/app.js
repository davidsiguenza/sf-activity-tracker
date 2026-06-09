// SF Activity Tracker — frontend logic.
// All user-controlled content goes through textContent / createElement to avoid XSS.

// Google Calendar standard colors (1-11) — same palette the user's Tampermonkey script uses.
const GOOGLE_COLORS = {
  '1':  { hex: '#7986cb', name: 'Lavender' },
  '2':  { hex: '#33b679', name: 'Sage' },
  '3':  { hex: '#8e24aa', name: 'Grape' },
  '4':  { hex: '#e67c73', name: 'Flamingo' },
  '5':  { hex: '#f6c026', name: 'Banana' },
  '6':  { hex: '#f5511d', name: 'Tangerine' },
  '7':  { hex: '#039be5', name: 'Peacock' },
  '8':  { hex: '#616161', name: 'Graphite' },
  '9':  { hex: '#3f51b5', name: 'Blueberry' },
  '10': { hex: '#0b8043', name: 'Basil' },
  '11': { hex: '#d60000', name: 'Tomato' },
};

const STATUS_PILLS = [
  { key: 'identified',     label: 'To log',         color: '#0969da' },
  { key: 'already-logged', label: 'Already logged', color: '#57606a' },
  { key: 'flagged',        label: 'Flagged',        color: '#bf8700' },
  { key: 'skip',           label: 'Skipped',        color: '#8c8c8c' },
  { key: 'excluded',       label: 'Excluded',       color: '#8c8c8c' },
];

const state = {
  config: null,
  calendar: null,
  events: [],
  classifications: [],
  dcOpportunities: [],
  draftRows: new Map(),
  showLogged: loadShowLogged(),
  selectedEventId: null,
  filters: {
    text: '',
    statuses: new Set(), // empty = no status filter
    colors: new Set(),   // empty = no color filter (colorId strings; '' = "no color")
  },
};

function loadShowLogged() {
  try {
    const v = localStorage.getItem('sfat.showLogged');
    return v === null ? false : JSON.parse(v); // default: hide already-logged for cleaner view
  } catch { return false; }
}
function saveShowLogged(v) {
  try { localStorage.setItem('sfat.showLogged', JSON.stringify(v)); } catch {}
}

// SE Task Type picklist values — mirrored from server/lib/prompts.js
// Verbatim picklist values from org62 (queried 2026-06-08).
const SE_TASK_TYPES = [
  'Customer Discovery', 'Customer Presentation', 'Workshop', 'POC', 'Dry Run',
  'Solution Creation', 'Asset Creation', 'Account Planning', 'Business Value Assessment',
  'BVS - Business Case', 'BVS - Proposal', 'BVS - Value Hypothesis',
  'Consumption Estimation', 'Consumption Event',
  'Post Sale Adoption Support', 'Post Sale Consumption Activation',
  'Post Sale Technical Product Support', 'Red Account Support',
  'RFx', 'Marketing Support', 'Partner Support', 'Localization',
  'Mentorship', 'Sales Enablement', 'Personal Development',
  'V2MOM Initiatives', 'Travel', 'Wellness', 'Admin', 'Not Available',
];

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const cfgResp = await fetchJson('/api/config');
  if (!cfgResp.configured) {
    showSetup(cfgResp.defaults);
    return;
  }
  state.config = cfgResp.config;
  showApp();
  refreshBackendBadge();
}

/**
 * Update the topbar pill that shows which calendar backend is active.
 * Cheap call, no Google network round-trip — just checks if ADC creds exist.
 */
async function refreshBackendBadge(forceBackend) {
  const badge = document.getElementById('backend-badge');
  if (!badge) return;

  // If we just got a backend from the latest analyze response, prefer that.
  if (forceBackend) {
    return paintBackendBadge(badge, forceBackend);
  }
  try {
    const r = await fetchJson('/api/calendar/status');
    paintBackendBadge(badge, r.googleApiConfigured ? 'google-api' : 'claude');
  } catch {
    paintBackendBadge(badge, 'unknown');
  }
}

function paintBackendBadge(el, backend) {
  el.classList.remove('backend-google-api', 'backend-claude', 'backend-claude-fallback', 'backend-unknown');
  el.classList.add(`backend-${backend}`);
  switch (backend) {
    case 'google-api':
      el.textContent = '⚡ Google API';
      el.title = 'Calendar fetched via Google Calendar API direct (~500ms, zero tokens). Configure in Settings.';
      break;
    case 'claude':
      el.textContent = '🐢 Claude (slow)';
      el.title = 'Calendar fetched via claude -p + Google MCP (~30-180s). Connect Google API in Settings to make this ~300x faster.';
      break;
    case 'claude-fallback':
      el.textContent = '⚠ Fallback';
      el.title = 'Google API failed, fell back to Claude. Re-run the gcloud command in Settings.';
      break;
    default:
      el.textContent = '…';
      el.title = '';
  }
}

// ─── Setup wizard ─────────────────────────────────────────────────────────────

function showSetup(defaults) {
  document.getElementById('setup-wizard').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('se-info').textContent = 'Setup pending';

  const resolveBtn = document.getElementById('setup-resolve-btn');
  const saveBtn = document.getElementById('setup-save-btn');
  const result = document.getElementById('setup-resolve-result');
  let resolved = null;

  resolveBtn.addEventListener('click', async () => {
    const email = document.getElementById('setup-email').value.trim();
    result.textContent = 'Resolviendo en org62…';
    try {
      resolved = await fetchJson('/api/setup/resolve-user', { method: 'POST', body: { email } });
      result.replaceChildren();
      result.appendChild(text('✓ '));
      const b = document.createElement('b'); b.textContent = resolved.seName; result.appendChild(b);
      result.appendChild(text(` · ${resolved.seEmail} · TZ ${resolved.timeZone} · Manager: ${resolved.managerName || '?'}`));
      saveBtn.disabled = false;
    } catch (e) {
      result.textContent = `✗ ${e.message}`;
      saveBtn.disabled = true;
    }
  });

  saveBtn.addEventListener('click', async () => {
    const role = document.getElementById('setup-role').value.trim() || 'Core SE';
    const excluded = document.getElementById('setup-excluded').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const cfg = await fetchJson('/api/setup/save', {
      method: 'POST',
      body: {
        ...resolved,
        seOpportunityRole: role,
        excludedTitles: excluded,
        internalEmailDomains: defaults.internalEmailDomains,
      },
    });
    state.config = cfg.config;
    document.getElementById('setup-wizard').classList.add('hidden');
    showApp();
  });
}

// ─── Main app ─────────────────────────────────────────────────────────────────

function showApp() {
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('se-info').textContent = `${state.config.seName} · ${state.config.timeZone}`;

  const today = new Date();
  const monday = startOfWeek(today);
  const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
  document.getElementById('from-date').value = isoDate(monday);
  document.getElementById('to-date').value = isoDate(sunday);

  document.querySelectorAll('.quick-ranges button').forEach((btn) => {
    btn.addEventListener('click', () => applyQuickRange(btn.dataset.range));
  });

  document.getElementById('analyze-btn').addEventListener('click', runAnalyze);
  document.getElementById('create-btn').addEventListener('click', runCreate);
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('help-btn').addEventListener('click', () => {
    document.getElementById('help-modal').classList.remove('hidden');
  });
  document.getElementById('help-close').addEventListener('click', () => {
    document.getElementById('help-modal').classList.add('hidden');
  });
  document.getElementById('settings-save-btn').addEventListener('click', saveSettings);

  // Header "select all" toggles all selectable rows. Default = unchecked (opt-in).
  const selectAll = document.getElementById('select-all');
  selectAll.checked = false;
  selectAll.addEventListener('change', (e) => {
    for (const row of state.draftRows.values()) {
      const cls = row.classification;
      if (['already-logged', 'excluded', 'skip'].includes(cls.status)) continue;
      row.selected = e.target.checked;
    }
    renderDraftPlan({ keepSelectAllState: true });
  });

  // Show / hide already-logged events
  const toggle = document.getElementById('toggle-show-logged');
  toggle.checked = state.showLogged;
  toggle.addEventListener('change', () => {
    state.showLogged = toggle.checked;
    saveShowLogged(state.showLogged);
    applyAllFilters();
  });

  // Filter panel
  const textInput = document.getElementById('filter-text');
  textInput.addEventListener('input', () => {
    state.filters.text = textInput.value.trim().toLowerCase();
    applyAllFilters();
  });
  document.getElementById('filter-reset').addEventListener('click', () => {
    state.filters.text = '';
    state.filters.statuses.clear();
    state.filters.colors.clear();
    textInput.value = '';
    rebuildFilterPills();
    applyAllFilters();
  });

  initCalendar();
}

function initCalendar() {
  const el = document.getElementById('calendar');
  state.calendar = new FullCalendar.Calendar(el, {
    initialView: 'timeGridWeek',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' },
    height: 600,
    locale: 'es',
    weekends: true,
    slotMinTime: '07:00',
    slotMaxTime: '21:00',
    eventClassNames(arg) {
      const classes = [...(arg.event.extendedProps.classes || [])];
      if (state.selectedEventId === arg.event.id) classes.push('event-selected');
      return classes;
    },
    eventDidMount(info) {
      // Paint a 5px inset stripe on the left in the Google Calendar color.
      // We use box-shadow inset (not border) so the state border (dashed/solid)
      // stays intact on all four sides.
      const color = info.event.extendedProps?.googleColor;
      if (color) {
        info.el.style.boxShadow = `inset 5px 0 0 ${color}`;
        info.el.dataset.gcolor = '1';
      }
    },
    eventClick(info) {
      info.jsEvent.preventDefault();
      selectEvent(info.event.id, { scrollToRow: true });
    },
  });
  state.calendar.render();
}

/**
 * Toggle-style event selection.
 * - Clicking the currently-selected event again → deselect.
 * - Clicking a different event → select it (and clear the previous one).
 * - Calls with explicit `forceSelect: true` always select.
 */
function selectEvent(eventId, opts = {}) {
  const previousId = state.selectedEventId;
  const isSameEvent = previousId === eventId && !opts.forceSelect;
  const newId = isSameEvent ? null : eventId;
  state.selectedEventId = newId;

  // Table — drop highlight on any row that's no longer selected, add it on the new one
  document.querySelectorAll('#draft-plan-table tbody tr.row-highlight')
    .forEach((tr) => tr.classList.remove('row-highlight'));
  if (newId) {
    const tr = document.querySelector(
      `#draft-plan-table tbody tr[data-event-id="${CSS.escape(newId)}"]`
    );
    if (tr) {
      tr.classList.add('row-highlight');
      if (opts.scrollToRow) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Calendar — force eventClassNames to re-run on both the previous and new events
  // so .event-selected goes/comes correctly.
  if (state.calendar) {
    const touch = (id) => {
      if (!id) return;
      const ev = state.calendar.getEventById(id);
      if (ev) ev.setExtendedProp('_sel', Date.now());
    };
    touch(previousId);
    touch(newId);
  }
}

// Replaced by selectEvent (kept here only to remember the legacy entry point name).

function applyQuickRange(range) {
  const today = new Date();
  let from, to;
  switch (range) {
    case 'today': from = today; to = today; break;
    case 'yesterday': from = addDays(today, -1); to = addDays(today, -1); break;
    case 'thisweek': from = startOfWeek(today); to = addDays(from, 6); break;
    case 'lastweek': from = addDays(startOfWeek(today), -7); to = addDays(from, 6); break;
    case 'thismonth': from = new Date(today.getFullYear(), today.getMonth(), 1); to = new Date(today.getFullYear(), today.getMonth() + 1, 0); break;
    default: return;
  }
  document.getElementById('from-date').value = isoDate(from);
  document.getElementById('to-date').value = isoDate(to);
}

// ─── Analyze ──────────────────────────────────────────────────────────────────

async function runAnalyze() {
  const fromDate = document.getElementById('from-date').value;
  const toDate = document.getElementById('to-date').value;
  if (!fromDate || !toDate) return alert('Select date range');
  const fromIso = `${fromDate}T00:00:00`;
  const toIso = `${toDate}T23:59:59`;

  const forceRefresh = document.getElementById('force-refresh').checked;

  const btn = document.getElementById('analyze-btn');
  btn.disabled = true;
  btn.textContent = forceRefresh
    ? '⏳ Refreshing from Google… (puede tardar hasta 5 min)'
    : '⏳ Analyzing…';

  try {
    const result = await fetchJson('/api/analyze', {
      method: 'POST',
      body: { fromIso, toIso, forceRefresh },
    });
    state.events = result.events || [];
    state.classifications = result.classifications || [];
    state.dcOpportunities = result.dcOpportunities || [];
    renderResults(result);
    // Reset force-refresh so the next click defaults to cached
    document.getElementById('force-refresh').checked = false;
  } catch (e) {
    showError(`Analyze failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Analyze';
  }
}

function renderResults(result) {
  const s = result.summary || { counts: {}, cfHours: 0, crHours: 0 };
  document.getElementById('summary-bar').classList.remove('hidden');
  document.getElementById('chip-identified').textContent = `${s.counts.identified || 0} to log`;
  document.getElementById('chip-logged').textContent = `${s.counts.alreadyLogged || 0} already logged`;
  document.getElementById('chip-flagged').textContent = `${s.counts.flagged || 0} flagged`;
  document.getElementById('chip-skipped').textContent = `${(s.counts.skip || 0) + (s.counts.excluded || 0)} skipped`;
  document.getElementById('chip-cf').textContent = `${s.cfHours} CF hrs`;
  document.getElementById('chip-cr').textContent = `${s.crHours} CR hrs`;

  // Cache info indicator
  const cacheInfo = document.getElementById('cache-info');
  if (result.calendarMeta && result.calendarMeta.fetchedAt) {
    cacheInfo.classList.remove('hidden');
    const when = new Date(result.calendarMeta.fetchedAt);
    const ago = humanizeAgo(when);
    const backend = result.calendarMeta.backend || 'unknown';
    const backendLabel = ({
      'google-api': '⚡ Google API direct',
      'claude': '🐢 Claude (slow)',
      'claude-fallback': '⚠ Claude fallback (Google API failed)',
    })[backend] || backend;

    let txt = result.calendarMeta.fromCache
      ? `📦 Calendar served from cache (fetched ${ago} via ${backendLabel}). Tick "Force refresh" before Analyze to re-query.`
      : `🔄 Calendar fetched fresh at ${when.toLocaleTimeString('es-ES')} via ${backendLabel}. Cache valid 30 min.`;
    if (result.calendarMeta.fellBackTo) {
      txt += ` — Fallback reason: ${result.calendarMeta.fallbackReason || 'unknown'}`;
    }
    cacheInfo.textContent = txt;

    // Update topbar badge to reflect actual backend used
    refreshBackendBadge(backend);
  } else {
    cacheInfo.classList.add('hidden');
  }

  const errBar = document.getElementById('errors-bar');
  errBar.replaceChildren();
  if (result.errors && result.errors.length) {
    errBar.classList.remove('hidden');
    for (const e of result.errors) {
      const div = document.createElement('div');
      div.appendChild(text('⚠ '));
      const b = document.createElement('b'); b.textContent = e.stage; div.appendChild(b);
      div.appendChild(text(`: ${e.message}`));
      errBar.appendChild(div);
    }
  } else {
    errBar.classList.add('hidden');
  }

  state.calendar.removeAllEvents();
  for (const ev of state.events) {
    const cls = state.classifications.find((c) => c.eventId === ev.id);
    const status = cls?.status || 'flagged';
    const googleColor = ev.colorId && GOOGLE_COLORS[ev.colorId]
      ? GOOGLE_COLORS[ev.colorId].hex
      : null;
    state.calendar.addEvent({
      id: ev.id,
      title: ev.summary,
      start: ev.start,
      end: ev.end,
      extendedProps: {
        classes: [`event-${status}`],
        classification: cls,
        raw: ev,
        googleColor,
      },
    });
  }
  if (state.events.length) state.calendar.gotoDate(new Date(state.events[0].start));

  // Show filter panel and rebuild its pills based on the data we just got
  document.getElementById('filter-panel').classList.remove('hidden');
  rebuildFilterPills();

  state.draftRows.clear();
  for (const ev of state.events) {
    const cls = state.classifications.find((c) => c.eventId === ev.id);
    if (!cls) continue;
    state.draftRows.set(ev.id, {
      event: ev,
      classification: { ...cls },
      selected: false, // opt-in: user explicitly checks what to log
    });
  }
  state.selectedEventId = null;
  renderDraftPlan();
}

/**
 * Apply all active filters (text, status, color, show-logged) to BOTH the calendar
 * and the draft plan table. Single source of truth for visibility.
 */
function applyAllFilters() {
  for (const row of state.draftRows.values()) {
    row._visible = isRowVisible(row);
  }

  // Calendar — set display per event
  if (state.calendar) {
    for (const fcEvent of state.calendar.getEvents()) {
      const row = state.draftRows.get(fcEvent.id);
      const visible = row ? row._visible : true;
      fcEvent.setProp('display', visible ? 'auto' : 'none');
    }
  }

  // Table — set CSS display per row
  const trs = document.querySelectorAll('#draft-plan-table tbody tr');
  for (const tr of trs) {
    const eventId = tr.dataset.eventId;
    const row = state.draftRows.get(eventId);
    tr.style.display = row && row._visible ? '' : 'none';
  }
}

/** Decide if a draft row should be visible given the active filters. */
function isRowVisible(row) {
  const cls = row.classification;
  const ev = row.event;

  // 1. Show / hide already-logged
  if (cls.status === 'already-logged' && !state.showLogged) return false;

  // 2. Status filter — empty set = no filter
  if (state.filters.statuses.size > 0 && !state.filters.statuses.has(cls.status)) return false;

  // 3. Color filter — empty set = no filter; '' = "no color set"
  if (state.filters.colors.size > 0) {
    const c = ev.colorId || '';
    if (!state.filters.colors.has(c)) return false;
  }

  // 4. Text filter — checks title and description
  if (state.filters.text) {
    const haystack = ((ev.summary || '') + ' ' + (ev.description || '')).toLowerCase();
    if (!haystack.includes(state.filters.text)) return false;
  }

  return true;
}

// Backward-compat alias used elsewhere; just delegates.
function applyShowLoggedFilter() { applyAllFilters(); }

/**
 * Rebuild the status / color pills based on what's actually in the current data.
 * Called after every analyze.
 */
function rebuildFilterPills() {
  // STATUS pills — only show ones present in the data so we don't clutter
  const presentStatuses = new Set();
  for (const row of state.draftRows.values()) presentStatuses.add(row.classification.status);

  const statusGroup = document.getElementById('filter-status-group');
  // Keep the <label> child (first), wipe the rest
  while (statusGroup.children.length > 1) statusGroup.removeChild(statusGroup.lastChild);

  for (const def of STATUS_PILLS) {
    if (!presentStatuses.has(def.key)) continue;
    const pill = document.createElement('span');
    pill.className = 'filter-pill';
    pill.dataset.status = def.key;
    if (state.filters.statuses.has(def.key)) pill.classList.add('is-on');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = def.color;
    pill.appendChild(swatch);
    pill.appendChild(document.createTextNode(def.label));
    pill.addEventListener('click', () => {
      if (state.filters.statuses.has(def.key)) state.filters.statuses.delete(def.key);
      else state.filters.statuses.add(def.key);
      pill.classList.toggle('is-on');
      applyAllFilters();
    });
    statusGroup.appendChild(pill);
  }

  // COLOR pills — based on Google colorId values present in the events
  const presentColors = new Set();
  let hasUncolored = false;
  for (const row of state.draftRows.values()) {
    const c = row.event.colorId;
    if (c) presentColors.add(c);
    else hasUncolored = true;
  }

  const colorGroup = document.getElementById('filter-color-group');
  while (colorGroup.children.length > 1) colorGroup.removeChild(colorGroup.lastChild);

  if (presentColors.size === 0 && !hasUncolored) {
    colorGroup.style.display = 'none';
    return;
  }
  colorGroup.style.display = '';

  // Sort numerically (1..11)
  const ordered = [...presentColors].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const cid of ordered) {
    const meta = GOOGLE_COLORS[cid] || { hex: '#888', name: `Color ${cid}` };
    const pill = makeColorPill(cid, meta.hex, meta.name);
    if (state.filters.colors.has(cid)) pill.classList.add('is-on');
    colorGroup.appendChild(pill);
  }
  if (hasUncolored) {
    const pill = makeColorPill('', '#dde1e5', 'Default');
    if (state.filters.colors.has('')) pill.classList.add('is-on');
    colorGroup.appendChild(pill);
  }
}

function makeColorPill(cid, hex, name) {
  const pill = document.createElement('span');
  pill.className = 'filter-pill';
  pill.dataset.colorId = cid;
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = hex;
  pill.appendChild(sw);
  pill.appendChild(document.createTextNode(name));
  pill.addEventListener('click', () => {
    if (state.filters.colors.has(cid)) state.filters.colors.delete(cid);
    else state.filters.colors.add(cid);
    pill.classList.toggle('is-on');
    applyAllFilters();
  });
  return pill;
}

function renderDraftPlan(opts = {}) {
  const card = document.getElementById('draft-plan-card');
  const tbody = document.querySelector('#draft-plan-table tbody');
  card.classList.remove('hidden');
  tbody.replaceChildren();

  const rows = [...state.draftRows.values()].sort((a, b) => new Date(a.event.start) - new Date(b.event.start));
  for (const row of rows) {
    tbody.appendChild(buildDraftRow(row));
  }
  // Re-apply visibility (text/status/color filters + show-logged toggle)
  applyAllFilters();

  // Keep header select-all in sync unless caller asked us not to
  if (!opts.keepSelectAllState) {
    syncSelectAllCheckbox();
  }
  refreshCreateBtn();
}

function syncSelectAllCheckbox() {
  const selectable = [...state.draftRows.values()].filter(
    (r) => !['already-logged', 'excluded', 'skip'].includes(r.classification.status)
  );
  const all = selectable.length > 0 && selectable.every((r) => r.selected);
  const some = selectable.some((r) => r.selected);
  const cb = document.getElementById('select-all');
  if (cb) {
    cb.checked = all;
    cb.indeterminate = some && !all;
  }
}

function buildDraftRow(row) {
  const tr = document.createElement('tr');
  const cls = row.classification;
  tr.classList.add(`row-${cls.status}`);
  tr.dataset.eventId = row.event.id;
  // Click anywhere on the row (except interactive widgets) → select event in calendar
  tr.addEventListener('click', (e) => {
    if (e.target.closest('input, select, button, a')) return;
    selectEvent(row.event.id, { scrollToRow: false });
    // Jump calendar to the event's date
    if (state.calendar && row.event.start) state.calendar.gotoDate(new Date(row.event.start));
  });
  if (state.selectedEventId === row.event.id) tr.classList.add('row-highlight');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = row.selected;
  cb.disabled = ['already-logged', 'excluded', 'skip'].includes(cls.status);
  cb.addEventListener('change', () => { row.selected = cb.checked; refreshCreateBtn(); });
  tr.appendChild(td(cb));

  tr.appendChild(td(text(row.event.summary)));
  tr.appendChild(td(text(formatDateTime(row.event.start, row.event.end))));
  tr.appendChild(td(text(`${(row.event.durationHours || 0).toFixed(2)}`)));
  tr.appendChild(buildRelatedToCell(row));
  tr.appendChild(buildConfidenceCell(cls.confidence));
  tr.appendChild(buildTaskTypeCell(row));
  tr.appendChild(buildBoolCell(cls.isCF, (v) => { cls.isCF = v; }));
  tr.appendChild(buildBoolCell(cls.isCR, (v) => { cls.isCR = v; }));
  tr.appendChild(buildStatusCell(cls));

  return tr;
}

function buildRelatedToCell(row) {
  const cls = row.classification;
  if (cls.status === 'already-logged') return td(em('logged'));
  if (cls.status === 'excluded' || cls.status === 'skip') return td(em('—'));

  const select = document.createElement('select');
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '— none —';
  select.appendChild(empty);

  for (const dc of state.dcOpportunities) {
    const opt = document.createElement('option');
    opt.value = JSON.stringify({ id: dc.opportunityId, name: dc.opportunityName, type: 'Opportunity' });
    opt.textContent = `${dc.opportunityName} (${dc.accountName})`;
    if (cls.relatedTo?.id === dc.opportunityId) opt.selected = true;
    select.appendChild(opt);
  }

  if (cls.relatedTo && !state.dcOpportunities.find((d) => d.opportunityId === cls.relatedTo.id)) {
    const opt = document.createElement('option');
    opt.value = JSON.stringify(cls.relatedTo);
    opt.textContent = `${cls.relatedTo.name} (${cls.relatedTo.type})`;
    opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => {
    cls.relatedTo = select.value ? JSON.parse(select.value) : null;
  });
  return td(select);
}

function buildConfidenceCell(c) {
  const cell = document.createElement('td');
  if (c) {
    const span = document.createElement('span');
    span.className = `confidence-${c}`;
    span.textContent = c;
    cell.appendChild(span);
  }
  return cell;
}

function buildTaskTypeCell(row) {
  const cls = row.classification;
  if (['already-logged', 'excluded', 'skip'].includes(cls.status)) return td(em('—'));

  const select = document.createElement('select');
  for (const t of SE_TASK_TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (cls.seTaskType === t) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => { cls.seTaskType = select.value; });
  return td(select);
}

function buildBoolCell(value, onChange) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!value;
  cb.addEventListener('change', () => onChange(cb.checked));
  return td(cb);
}

function buildStatusCell(cls) {
  const cell = document.createElement('td');
  const top = document.createElement('div');
  const b = document.createElement('b'); b.textContent = cls.status;
  top.appendChild(b);
  cell.appendChild(top);
  const reason = cls.reasoning || '';
  const sub = document.createElement('div');
  sub.className = 'hint';
  sub.title = reason;
  sub.textContent = reason.length > 60 ? reason.slice(0, 60) + '…' : reason;
  cell.appendChild(sub);
  return cell;
}

function refreshCreateBtn() {
  const btn = document.getElementById('create-btn');
  const count = [...state.draftRows.values()].filter((r) => r.selected).length;
  btn.disabled = count === 0;
  btn.textContent = count === 0 ? 'Create in org62' : `Create ${count} in org62`;
  syncSelectAllCheckbox();
}

// ─── Create ───────────────────────────────────────────────────────────────────

async function runCreate() {
  const approved = [];
  for (const row of state.draftRows.values()) {
    if (!row.selected) continue;
    const cls = row.classification;
    if (cls.status !== 'identified' && cls.status !== 'flagged') continue;
    if (!cls.seTaskType) continue;
    if (!row.event.start || !row.event.end) continue;

    approved.push({
      eventId: row.event.id,
      subject: row.event.summary,
      startUtc: new Date(row.event.start).toISOString(),
      endUtc: new Date(row.event.end).toISOString(),
      whatId: cls.relatedTo?.id || null,
      seTaskType: cls.seTaskType,
      isCF: cls.isCF,
      isCR: cls.isCR,
      createDc: shouldCreateDc(cls),
      dcOpportunityId: cls.relatedTo?.type === 'Opportunity' ? cls.relatedTo.id : null,
      splitPercentage: 100,
    });
  }
  if (approved.length === 0) return;

  document.getElementById('progress-card').classList.remove('hidden');
  const log = document.getElementById('progress-log');
  log.replaceChildren();

  try {
    await sse('/api/create', { approved }, (event, data) => {
      switch (event) {
        case 'phase':
          appendLog(`▶ ${data.name} (${data.total})`);
          break;
        case 'dc-created':
          appendLog(`DC created for opp ${data.oppId}`, 'ok');
          break;
        case 'dc-skipped':
          appendLog(`DC skipped (already exists) for opp ${data.oppId}`, 'ok');
          break;
        case 'dc-error':
          appendLog(`DC error: ${data.error}`, 'err');
          break;
        case 'event-created':
          appendLog(`Event created: ${data.subject}`, 'ok');
          markEventLogged(data.eventId);
          break;
        case 'event-error':
          appendLog(`Event failed (${data.subject}): ${data.error}`, 'err');
          break;
        case 'done':
          appendLog(`✔ Done — ${data.eventsCreated} events, ${data.dcsCreated} DCs (${data.eventsFailed} failed)`, data.eventsFailed === 0 ? 'ok' : 'err');
          break;
      }
    });
  } catch (e) {
    appendLog(`Stream error: ${e.message}`, 'err');
  }
}

function shouldCreateDc(cls) {
  if (!cls.relatedTo || cls.relatedTo.type !== 'Opportunity') return false;
  const existing = state.dcOpportunities.find((d) => d.opportunityId === cls.relatedTo.id);
  if (existing && (existing.splitPercentage || 0) > 0) return false;
  return true;
}

function markEventLogged(eventId) {
  const fcEvent = state.calendar.getEventById(eventId);
  if (fcEvent) {
    fcEvent.setExtendedProp('classes', ['event-logged']);
  }
  const row = state.draftRows.get(eventId);
  if (row) {
    row.classification.status = 'already-logged';
    row.selected = false;
  }
  renderDraftPlan();
  rebuildFilterPills(); // status set may have changed
  updateSummaryChips();
}

/**
 * Recompute the summary chip counts from current state (after creations).
 */
function updateSummaryChips() {
  const counts = { identified: 0, alreadyLogged: 0, flagged: 0, skip: 0, excluded: 0 };
  let cfHours = 0;
  let crHours = 0;
  for (const row of state.draftRows.values()) {
    const cls = row.classification;
    const key = cls.status === 'already-logged' ? 'alreadyLogged' : cls.status;
    counts[key] = (counts[key] || 0) + 1;
    if (cls.status === 'identified') {
      const dur = row.event.durationHours || 0;
      if (cls.isCF) cfHours += dur;
      if (cls.isCR) crHours += dur;
    }
  }
  document.getElementById('chip-identified').textContent = `${counts.identified} to log`;
  document.getElementById('chip-logged').textContent = `${counts.alreadyLogged} already logged`;
  document.getElementById('chip-flagged').textContent = `${counts.flagged} flagged`;
  document.getElementById('chip-skipped').textContent = `${counts.skip + counts.excluded} skipped`;
  document.getElementById('chip-cf').textContent = `${(Math.round(cfHours * 100) / 100)} CF hrs`;
  document.getElementById('chip-cr').textContent = `${(Math.round(crHours * 100) / 100)} CR hrs`;
}

function appendLog(textStr, kind) {
  const li = document.createElement('li');
  if (kind) li.className = kind;
  li.textContent = textStr;
  document.getElementById('progress-log').appendChild(li);
  li.scrollIntoView({ block: 'end' });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function openSettings() {
  const cfg = await fetchJson('/api/config');
  state.config = cfg.config;
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('config-raw').textContent = JSON.stringify(cfg.config, null, 2);
  document.getElementById('settings-excluded').value = (cfg.config.excludedTitles || []).join('\n');

  // Google API section
  await refreshGoogleApiSection();
  // Calendar picker — only meaningful when Google API is configured
  await refreshCalendarPicker();

  const aliasBody = document.querySelector('#alias-table tbody');
  aliasBody.replaceChildren();
  const aliases = cfg.config.aliasTable || [];
  if (!aliases.length) {
    aliasBody.appendChild(emptyTableRow(2, 'Sin aliases todavía. Se aprenden corrigiendo el matching.'));
  } else {
    for (const a of aliases) {
      const tr = document.createElement('tr');
      tr.appendChild(td(text(a.alias)));
      const matchTd = document.createElement('td');
      a.matches.forEach((m, i) => {
        if (i > 0) matchTd.appendChild(document.createElement('br'));
        matchTd.appendChild(text(`${m.type}: ${m.name}`));
      });
      tr.appendChild(matchTd);
      aliasBody.appendChild(tr);
    }
  }

  const corrBody = document.querySelector('#correction-table tbody');
  corrBody.replaceChildren();
  const corrections = cfg.config.taxonomyCorrections || [];
  if (!corrections.length) {
    corrBody.appendChild(emptyTableRow(2, 'Sin correcciones todavía.'));
  } else {
    for (const c of corrections) {
      const tr = document.createElement('tr');
      tr.appendChild(td(text(c.keyword)));
      tr.appendChild(td(text(c.seTaskType)));
      corrBody.appendChild(tr);
    }
  }

  const cd = document.getElementById('catchall-display');
  cd.textContent = cfg.config.catchAll ? `${cfg.config.catchAll.type}: ${cfg.config.catchAll.name}` : 'No configurado.';
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

async function saveSettings() {
  const excluded = document.getElementById('settings-excluded').value.split('\n').map((s) => s.trim()).filter(Boolean);
  await fetchJson('/api/config', { method: 'PUT', body: { excludedTitles: excluded } });
  closeSettings();
  alert('Settings guardados.');
}

// ─── Google API section ──────────────────────────────────────────────────────

async function refreshGoogleApiSection() {
  const statusEl = document.getElementById('google-oauth-status');
  const stepClient = document.getElementById('oauth-step-client');
  const saveClientBtn = document.getElementById('oauth-save-client-btn');
  const connectBtn = document.getElementById('oauth-connect-btn');
  const disconnectBtn = document.getElementById('oauth-disconnect-btn');
  const clearBtn = document.getElementById('google-api-clear-cache-btn');

  // Idempotent wiring
  saveClientBtn.onclick = async () => {
    const contents = document.getElementById('oauth-client-json').value.trim();
    if (!contents) return alert('Pega el contenido del JSON descargado de GCP Console.');
    try {
      const r = await fetchJson('/api/oauth/set-client', { method: 'POST', body: { contents } });
      paintOauthStatus(statusEl, { ...await getOauthStatus(), savedClient: r.clientId });
      stepClient.open = false;
      document.getElementById('oauth-client-json').value = '';
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  };

  connectBtn.onclick = async () => {
    try {
      const r = await fetchJson('/api/oauth/start', { method: 'POST' });
      // Server already tries to open the browser. As a fallback we pop a window too.
      window.open(r.authUrl, '_blank');
      statusEl.textContent = '⏳ Esperando autorización en Google… vuelve aquí cuando termines y pulsa Test connection o Refresh.';
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  };

  disconnectBtn.onclick = async () => {
    if (!confirm('¿Desconectar Google? Volverás al backend Claude (lento) hasta que reconectes.')) return;
    await fetchJson('/api/oauth/disconnect', { method: 'POST', body: {} });
    await refreshGoogleApiSection();
    refreshBackendBadge();
  };

  clearBtn.onclick = async () => {
    await fetchJson('/api/calendar/clear-cache', { method: 'POST' });
    statusEl.textContent = 'Calendar cache cleared.';
  };

  // Initial paint
  const oauth = await getOauthStatus();
  paintOauthStatus(statusEl, oauth);

  // Auto-collapse the upload step once we have a client
  stepClient.open = !oauth.hasClient;
}

async function getOauthStatus() {
  try {
    return await fetchJson('/api/oauth/status');
  } catch (e) {
    return { error: e.message };
  }
}

function paintOauthStatus(el, s) {
  el.replaceChildren();
  if (s.error) {
    el.style.color = '#cf222e';
    el.textContent = `✗ ${s.error}`;
    return;
  }
  if (s.hasTokens) {
    el.style.color = '#1a7f37';
    el.textContent = `✓ Connected. Project: ${s.projectId || '(unknown)'}`;
    if (s.scopes) {
      const sub = document.createElement('div');
      sub.style.fontSize = '11px';
      sub.style.opacity = '0.7';
      sub.style.marginTop = '4px';
      sub.textContent = `Scopes: ${s.scopes}`;
      el.appendChild(sub);
    }
    return;
  }
  if (s.hasClient) {
    el.style.color = '#bf8700';
    el.textContent = `⏸ Client JSON saved (${s.clientId}). Pulsa "Connect with Google" para autorizar.`;
    return;
  }
  el.style.color = '#57606a';
  el.textContent = '⏵ Sin conectar. Sube tu OAuth client JSON (Paso 1) y pulsa Connect.';
}

// ─── Calendar picker section ─────────────────────────────────────────────────

async function refreshCalendarPicker() {
  const listEl = document.getElementById('calendar-picker-list');
  const loadBtn = document.getElementById('calendar-picker-load-btn');
  const allBtn = document.getElementById('calendar-picker-all-btn');
  const noneBtn = document.getElementById('calendar-picker-none-btn');
  const saveBtn = document.getElementById('calendar-picker-save-btn');

  // Idempotent button wiring
  loadBtn.onclick = () => loadCalendarPicker();
  allBtn.onclick = () => toggleAllCalendars(true);
  noneBtn.onclick = () => toggleAllCalendars(false);
  saveBtn.onclick = () => saveCalendarSelection();

  // First load attempt — only if Google API is configured
  await loadCalendarPicker();
}

async function loadCalendarPicker() {
  const listEl = document.getElementById('calendar-picker-list');
  listEl.replaceChildren();

  // Check Google API status before trying to list
  const status = await fetchJson('/api/calendar/status').catch(() => null);
  if (!status?.googleApiConfigured) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Conecta Google API primero para ver tu lista de calendarios.';
    listEl.appendChild(hint);
    return;
  }

  try {
    const res = await fetchJson('/api/calendar/list');
    const enabled = new Set(state.config.enabledCalendarIds || []);
    const allEnabled = enabled.size === 0; // empty config = all

    // Sort: primary first, then alphabetic by summary
    const cals = [...(res.calendars || [])].sort((a, b) => {
      if (a.primary && !b.primary) return -1;
      if (!a.primary && b.primary) return 1;
      return (a.summary || '').localeCompare(b.summary || '');
    });

    if (cals.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = 'No se encontraron calendarios.';
      listEl.appendChild(hint);
      return;
    }

    for (const cal of cals) {
      const row = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.calId = cal.id;
      cb.checked = allEnabled || enabled.has(cal.id);

      const swatch = document.createElement('span');
      swatch.className = 'cal-swatch';
      swatch.style.background = cal.backgroundColor || '#ccc';

      const name = document.createElement('span');
      name.className = 'cal-name';
      name.textContent = cal.summary + (cal.primary ? ' (primary)' : '');

      const meta = document.createElement('span');
      meta.className = 'cal-meta';
      meta.textContent = cal.accessRole || '';

      row.append(cb, swatch, name, meta);
      listEl.appendChild(row);
    }
  } catch (e) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.style.color = '#82071e';
    hint.textContent = `Error: ${e.message}`;
    listEl.appendChild(hint);
  }
}

function toggleAllCalendars(checked) {
  document.querySelectorAll('#calendar-picker-list input[type="checkbox"]').forEach((cb) => {
    cb.checked = checked;
  });
}

async function saveCalendarSelection() {
  const checked = [...document.querySelectorAll('#calendar-picker-list input[type="checkbox"]:checked')]
    .map((cb) => cb.dataset.calId);
  // If everything is checked, save empty array (= "all", future-proof if user adds calendars)
  const total = document.querySelectorAll('#calendar-picker-list input[type="checkbox"]').length;
  const toSave = checked.length === total ? [] : checked;

  await fetchJson('/api/config', {
    method: 'PUT',
    body: { enabledCalendarIds: toSave },
  });
  // Cache key depends on selection — clear so next analyze refetches
  await fetchJson('/api/calendar/clear-cache', { method: 'POST' });

  state.config.enabledCalendarIds = toSave;
  alert(toSave.length === 0
    ? `✓ Guardado: leeré de TODOS los calendarios (${total}).`
    : `✓ Guardado: leeré de ${toSave.length} de ${total} calendarios.`);
}

function paintGoogleApiStatus(el, result) {
  el.replaceChildren();
  if (result.ok) {
    el.style.color = '#1a7f37';
    el.textContent = `✓ Connected. ${result.calendarCount} calendar${result.calendarCount === 1 ? '' : 's'} visible (of ${result.calendarTotal || result.calendarCount} accessible).`;
    if (result.calendarNames && result.calendarNames.length) {
      const list = document.createElement('div');
      list.style.fontSize = '11px';
      list.style.opacity = '0.85';
      list.style.marginTop = '4px';
      list.textContent = `Calendars: ${result.calendarNames.join(', ')}`;
      el.appendChild(list);
    }
    if (result.grantedScopes) {
      const sub = document.createElement('div');
      sub.style.fontSize = '11px';
      sub.style.opacity = '0.7';
      sub.style.marginTop = '4px';
      sub.textContent = `Granted scopes: ${result.grantedScopes}`;
      el.appendChild(sub);
    }
  } else {
    el.style.color = '#82071e';
    const main = document.createElement('div');
    main.textContent = `✗ ${result.error}`;
    el.appendChild(main);
    if (result.hint) {
      const hint = document.createElement('div');
      hint.style.fontSize = '12px';
      hint.style.marginTop = '4px';
      hint.style.opacity = '0.85';
      hint.style.whiteSpace = 'pre-wrap';
      hint.textContent = result.hint;
      el.appendChild(hint);
    }
    if (result.grantedScopes !== undefined) {
      const sub = document.createElement('div');
      sub.style.fontSize = '11px';
      sub.style.opacity = '0.7';
      sub.style.marginTop = '4px';
      sub.textContent = `Currently granted: ${result.grantedScopes || '(none)'}`;
      el.appendChild(sub);
    }
  }
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function td(node) {
  const cell = document.createElement('td');
  if (typeof node === 'string') cell.textContent = node;
  else cell.appendChild(node);
  return cell;
}

function text(s) { return document.createTextNode(s ?? ''); }

function em(s) { const e = document.createElement('i'); e.textContent = s; return e; }

function emptyTableRow(colspan, msg) {
  const tr = document.createElement('tr');
  const c = document.createElement('td');
  c.colSpan = colspan;
  c.className = 'hint';
  c.textContent = msg;
  tr.appendChild(c);
  return tr;
}

// ─── Network helpers ─────────────────────────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

async function sse(url, body, onEvent) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.body) throw new Error('No SSE stream');
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
      const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (eventLine && dataLine) {
        const evt = eventLine.slice(7).trim();
        try {
          onEvent(evt, JSON.parse(dataLine.slice(6)));
        } catch {}
      }
    }
  }
}

function showError(msg) {
  const errBar = document.getElementById('errors-bar');
  errBar.classList.remove('hidden');
  errBar.replaceChildren();
  const div = document.createElement('div');
  div.textContent = `⚠ ${msg}`;
  errBar.appendChild(div);
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfWeek(d) {
  const r = new Date(d);
  const day = r.getDay() || 7;
  if (day !== 1) r.setDate(r.getDate() - (day - 1));
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function humanizeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatDateTime(startIso, endIso) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const date = s.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short' });
  const t = (d) => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${t(s)}–${t(e)}`;
}
