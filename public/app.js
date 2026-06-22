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
  { key: 'unclassified',   label: 'Unclassified',   color: '#8c8c8c' },
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
  unmatchedSfEvents: [],
  draftRows: new Map(),
  showLogged: loadShowLogged(),
  selectedEventId: null,
  sfInstanceUrl: null, // resolved lazily from /api/sf/instance-url
  filters: {
    text: '',
    statuses: new Set(), // empty = no status filter
    colors: new Set(),   // empty = no color filter (colorId strings; '' = "no color")
    calendars: new Set(),// empty = no calendar filter (calendarId strings)
    cfOnly: false,       // true = only events with isCF
    crOnly: false,       // true = only events with isCR
    freshOnly: false,    // true = only events freshly classified this run (not from cache)
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

// Last analyzed range — used to auto-restore the view on page load.
// Lives in localStorage so it survives reloads but is per-browser.
const LAST_RANGE_KEY = 'sfat.lastRange';
const LAST_RANGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function loadLastRange() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_RANGE_KEY) || 'null');
    if (!v || !v.fromDate || !v.toDate || !v.savedAt) return null;
    if (Date.now() - v.savedAt > LAST_RANGE_TTL_MS) return null;
    return v;
  } catch { return null; }
}
function saveLastRange(fromDate, toDate) {
  try {
    localStorage.setItem(LAST_RANGE_KEY, JSON.stringify({ fromDate, toDate, savedAt: Date.now() }));
  } catch {}
}
function clearLastRange() {
  try { localStorage.removeItem(LAST_RANGE_KEY); } catch {}
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

// Settings + Help buttons are wired at DOM ready (NOT inside showApp) so they
// work even when the setup wizard is showing — otherwise a user with no backend
// connected gets stuck: the wizard can't resolve their user against org62, and
// they can't open Settings to fix the backend config.
document.addEventListener('DOMContentLoaded', () => {
  const settingsBtn = document.getElementById('settings-btn');
  const helpBtn = document.getElementById('help-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
  if (helpBtn) helpBtn.addEventListener('click', () => {
    document.getElementById('help-modal').classList.remove('hidden');
  });
  const settingsClose = document.getElementById('settings-close');
  if (settingsClose) settingsClose.addEventListener('click', closeSettings);
});

async function init() {
  const cfgResp = await fetchJson('/api/config');
  if (!cfgResp.configured) {
    showSetup(cfgResp.defaults);
    return;
  }
  state.config = cfgResp.config;
  showApp();
  refreshBackendBadge();
  // Fetch the SF instance URL once so calendar clicks on already-logged events
  // can open the record in a new tab. Failure is non-fatal — clicks just fall
  // back to the legacy toggle behavior.
  fetchJson('/api/sf/instance-url')
    .then((r) => { state.sfInstanceUrl = r?.instanceUrl || null; })
    .catch(() => { /* ignore — link feature stays disabled */ });
}

/**
 * Build the Lightning record URL for an Event Id, or null if we don't yet
 * have the instance URL or the id is missing.
 */
function sfEventUrl(eventId) {
  if (!state.sfInstanceUrl || !eventId) return null;
  return `${state.sfInstanceUrl}/lightning/r/Event/${eventId}/view`;
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
  const emailInput = document.getElementById('setup-email');
  const emailHint = document.getElementById('setup-email-hint');
  let resolved = null;

  const doResolve = async (email) => {
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
  };

  resolveBtn.addEventListener('click', () => doResolve(emailInput.value.trim()));

  // Open Settings directly from the wizard so the user can configure their
  // backend before trying to resolve. After closing Settings, re-attempt
  // auto-resolve in case they just connected one.
  const openSettingsBtn = document.getElementById('setup-open-settings-btn');
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', async () => {
      await openSettings();
      // When the user closes Settings, retry whoami so the email auto-fills
      // and resolve runs if a backend just came online.
      const onClose = async () => {
        document.getElementById('settings-close').removeEventListener('click', onClose);
        try {
          const r = await fetchJson('/api/setup/whoami');
          if (r?.username) {
            emailInput.value = r.username;
            await doResolve(r.username);
          }
        } catch { /* ignore — user can click Resolver manually */ }
      };
      document.getElementById('settings-close').addEventListener('click', onClose);
    });
  }

  // Auto-detect from `sf` CLI. The app only logs activities for the user
  // authenticated against org62 — so pre-fill and auto-resolve. User can still
  // override manually if the CLI is misconfigured.
  fetchJson('/api/setup/whoami')
    .then((r) => {
      if (!r?.username) throw new Error('no username');
      emailInput.value = r.username;
      emailInput.readOnly = true;
      emailHint.innerHTML = `(auto-detectado de <code>sf</code> CLI · <a href="#" id="setup-email-edit">editar</a>)`;
      document.getElementById('setup-email-edit').addEventListener('click', (ev) => {
        ev.preventDefault();
        emailInput.readOnly = false;
        emailInput.focus();
      });
      doResolve(r.username);
    })
    .catch(() => {
      emailHint.textContent = '(no se pudo auto-detectar — escríbelo manualmente)';
      emailInput.value = 'dsiguenza@salesforce.com';
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

  // Manual date-picker edits sync the calendar to match. Auto-pick a view based
  // on the range duration: 1 day → day view, 2-7 → week, >7 → month.
  const onDateInputChange = () => {
    const fromStr = document.getElementById('from-date').value;
    const toStr = document.getElementById('to-date').value;
    if (!fromStr || !toStr || !state.calendar) return;
    const from = new Date(fromStr + 'T00:00:00');
    const to = new Date(toStr + 'T00:00:00');
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return;
    const dayCount = Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1;
    let view;
    if (dayCount <= 1) view = 'timeGridDay';
    else if (dayCount <= 7) view = 'timeGridWeek';
    else view = 'dayGridMonth';
    state.calendar.changeView(view, from);
  };
  document.getElementById('from-date').addEventListener('change', onDateInputChange);
  document.getElementById('to-date').addEventListener('change', onDateInputChange);

  document.getElementById('analyze-btn').addEventListener('click', runAnalyze);
  document.getElementById('create-btn').addEventListener('click', runCreate);
  document.getElementById('export-btn').addEventListener('click', exportSelection);
  // settings/help buttons are wired at DOM ready (below) so they work even
  // when the setup wizard is showing and showApp() hasn't run yet.
  document.getElementById('help-close').addEventListener('click', () => {
    document.getElementById('help-modal').classList.add('hidden');
  });
  document.getElementById('settings-save-btn').addEventListener('click', saveSettings);

  // Header "select all" toggles only the rows currently VISIBLE under the active
  // filters. Hidden rows keep their previous selection state. Default = unchecked.
  const selectAll = document.getElementById('select-all');
  selectAll.checked = false;
  selectAll.addEventListener('change', (e) => {
    for (const row of state.draftRows.values()) {
      const cls = row.classification;
      if (['already-logged', 'excluded', 'skip', 'unclassified'].includes(cls.status)) continue;
      if (row._visible === false) continue; // skip filtered-out rows
      row.selected = e.target.checked;
      // Sync green-ring on calendar
      if (state.calendar) {
        const fcEv = state.calendar.getEventById(row.event.id);
        if (fcEv) fcEv.setExtendedProp('_markTick', Date.now());
      }
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
    state.filters.calendars.clear();
    state.filters.cfOnly = false;
    state.filters.crOnly = false;
    state.filters.freshOnly = false;
    textInput.value = '';
    rebuildFilterPills();
    syncChipActiveStates();
    applyAllFilters();
  });

  // Summary chips → clickable filters
  document.querySelectorAll('.summary-bar .chip').forEach((chip) => {
    chip.addEventListener('click', () => onChipClick(chip));
  });
  // All / Clear shortcuts for chip filters
  document.getElementById('chips-all-btn').addEventListener('click', () => {
    activateAllChips();
    syncChipActiveStates();
    rebuildFilterPills();
    applyAllFilters();
  });
  document.getElementById('chips-clear-btn').addEventListener('click', () => {
    state.filters.statuses.clear();
    state.filters.cfOnly = false;
    state.filters.crOnly = false;
    state.filters.freshOnly = false;
    syncChipActiveStates();
    rebuildFilterPills();
    applyAllFilters();
  });

  initCalendar();
  startCalendarPoller();

  // Auto-restore last analyzed range — only if recent (<24h) and the user
  // hasn't disabled it. The analyze hits the classification cache so it's
  // fast; the cache info bar will say "from cache" so the user knows.
  const last = loadLastRange();
  if (last) {
    document.getElementById('from-date').value = last.fromDate;
    document.getElementById('to-date').value = last.toDate;
    // Defer one tick so the calendar finishes rendering, then sync calendar
    // view to the restored range and trigger analyze.
    setTimeout(() => {
      onDateInputChange();
      runAnalyze();
    }, 50);
  }
}

/**
 * Given the FullCalendar datesSet arg (or a view), return the inclusive
 * { from, to } date range the user is currently looking at:
 *   - week view  → Monday → Sunday
 *   - day view   → that single day on both ends
 *   - month view → 1st of month → last of month (NOT the 35-42-day grid)
 *   - list view  → same logic as the underlying view
 *
 * FullCalendar gives currentEnd as exclusive (e.g. for May, it's June 1) so we
 * subtract one day to get an inclusive end suitable for the date picker UI.
 */
function calendarRangeToDates(arg) {
  const view = arg.view || arg;
  const from = new Date(view.currentStart);
  const to = new Date(view.currentEnd);
  to.setDate(to.getDate() - 1);
  return { from, to };
}

/** Run a calendar mutation without echoing back into the date pickers. */
function withoutDatePickerSync(fn) {
  state._skipDatePickerSync = true;
  try { fn(); } finally {
    // Defer reset so the datesSet callback that fires from the mutation skips
    setTimeout(() => { state._skipDatePickerSync = false; }, 0);
  }
}

function initCalendar() {
  const el = document.getElementById('calendar');
  state.calendar = new FullCalendar.Calendar(el, {
    initialView: 'timeGridWeek',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' },
    height: 600,
    locale: 'es',
    firstDay: 1, // Monday
    weekends: true,
    slotMinTime: '07:00',
    slotMaxTime: '21:00',
    // Whenever the user navigates (prev/next/today), changes view, or programmatic
    // gotoDate fires, sync the date-picker inputs so Analyze uses the visible range.
    datesSet(arg) {
      if (state._skipDatePickerSync) return;
      const { from, to } = calendarRangeToDates(arg);
      const fromInput = document.getElementById('from-date');
      const toInput = document.getElementById('to-date');
      if (fromInput && toInput) {
        fromInput.value = isoDate(from);
        toInput.value = isoDate(to);
      }
      // Auto-fire a cache-only analyze for the new range so the user always
      // sees data when navigating, even without hitting Analyze. Debounced so
      // rapid scrolling through weeks doesn't hammer the backend.
      scheduleCacheOnlyFetch(from, to);
    },
    eventClassNames(arg) {
      const classes = [...(arg.event.extendedProps.classes || [])];
      if (state.selectedEventId === arg.event.id) classes.push('event-selected');
      const row = state.draftRows.get(arg.event.id);
      if (row?.selected) classes.push('event-marked-create');
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
      const props = info.event.extendedProps || {};
      // Ghost SF-only events: open the SF record directly.
      if (props.isSfOnly) {
        const url = sfEventUrl(props.sfData?.id);
        if (url) window.open(url, '_blank', 'noopener');
        return;
      }
      // Already-logged events: open the linked SF record (double-check use case).
      const cls = props.classification;
      if (cls?.status === 'already-logged') {
        const url = sfEventUrl(cls.salesforceEventId);
        if (url) window.open(url, '_blank', 'noopener');
        return;
      }
      // Otherwise: toggle the row's "create in org62" checkbox.
      // We programmatically click the table checkbox so its existing change
      // handler runs (updates row.selected, refreshes button, etc.).
      const cb = document.querySelector(
        `#draft-plan-table tbody tr[data-event-id="${CSS.escape(info.event.id)}"] input[type="checkbox"]`
      );
      if (!cb || cb.disabled) return; // excluded / skip
      cb.click();
      // Force the calendar event's classes to re-evaluate so the green ring
      // appears/disappears in sync.
      info.event.setExtendedProp('_markTick', Date.now());
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
  let view = null;     // FullCalendar view name to switch to
  let target = null;   // Date to navigate the calendar to

  switch (range) {
    case 'today':     view = 'timeGridDay';   target = today; break;
    case 'yesterday': view = 'timeGridDay';   target = addDays(today, -1); break;
    case 'thisweek':  view = 'timeGridWeek';  target = today; break;
    case 'lastweek':  view = 'timeGridWeek';  target = addDays(today, -7); break;
    case 'thismonth': view = 'dayGridMonth';  target = today; break;
    default: return;
  }

  // Both the view-change and the gotoDate fire datesSet, which will sync the
  // pickers — no need to set the inputs manually here.
  if (state.calendar) {
    state.calendar.changeView(view, target);
  } else {
    // Calendar not ready yet (shouldn't happen post-init): fall back to inputs
    const { from, to } = quickRangeToDates(range);
    document.getElementById('from-date').value = isoDate(from);
    document.getElementById('to-date').value = isoDate(to);
  }
}

/** Plain {from,to} for a quick-range key — used as a fallback if the calendar isn't initialised. */
function quickRangeToDates(range) {
  const today = new Date();
  switch (range) {
    case 'today':     return { from: today, to: today };
    case 'yesterday': { const d = addDays(today, -1); return { from: d, to: d }; }
    case 'thisweek':  { const f = startOfWeek(today); return { from: f, to: addDays(f, 6) }; }
    case 'lastweek':  { const f = addDays(startOfWeek(today), -7); return { from: f, to: addDays(f, 6) }; }
    case 'thismonth': return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: new Date(today.getFullYear(), today.getMonth() + 1, 0) };
  }
  return { from: today, to: today };
}

// ─── Analyze ──────────────────────────────────────────────────────────────────

// ─── Cache-only auto-fetch on calendar navigation ────────────────────────────

let _cacheOnlyTimer = null;
let _calendarPollerId = null;
const POLL_INTERVAL_MS = 60_000; // 1 minute
// Initialized lazily on the state object so the in-flight guard survives
state._cacheOnlyReqCounter = 0;

/**
 * Start a 1-minute poller that re-fetches Google Calendar for whatever range
 * the calendar is currently showing. Picks up new events the user added in
 * Google without needing to navigate or hit Analyze. Pauses while the tab
 * is hidden so we don't burn quota on a window the user isn't looking at.
 */
function startCalendarPoller() {
  if (_calendarPollerId) clearInterval(_calendarPollerId);
  _calendarPollerId = setInterval(() => {
    if (document.hidden) return;
    if (!state.calendar) return;
    if (state._analyzeInFlight) return;
    const view = state.calendar.view;
    const { from, to } = calendarRangeToDates(view);
    doCacheOnlyFetch(from, to);
  }, POLL_INTERVAL_MS);
  // Also fetch right away when the tab becomes visible after being hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.calendar || state._analyzeInFlight) return;
    const view = state.calendar.view;
    const { from, to } = calendarRangeToDates(view);
    doCacheOnlyFetch(from, to);
  });
}

/**
 * Debounced cache-only fetch. Triggered on every calendar navigation so the
 * user always sees data without waiting for claude. Reuses the analyze flow
 * with cacheOnly=true: server fetches calendar (fast Google API) + looks up
 * classifications cache + builds dedupes. Events not in cache come back as
 * status='unclassified' (gray dashed). User explicitly hits Analyze to run
 * claude on them.
 */
function scheduleCacheOnlyFetch(from, to) {
  if (!state.config) return; // setup wizard still pending
  // Skip if range is too long — would require fetching too many events
  const days = Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1;
  if (days > 45) return;
  // Skip if a full Analyze is in flight — let it finish; its result is fresher
  if (state._analyzeInFlight) return;

  clearTimeout(_cacheOnlyTimer);
  _cacheOnlyTimer = setTimeout(() => doCacheOnlyFetch(from, to), 600);
}

async function doCacheOnlyFetch(from, to) {
  const fromIso = `${isoDate(from)}T00:00:00`;
  const toIso = `${isoDate(to)}T23:59:59`;
  // Tag this request so a stale response doesn't pisar what's now visible
  const reqId = ++state._cacheOnlyReqCounter;
  try {
    // forceRefresh: true → always re-fetch from Google so the user sees
    // newly-added calendar events without waiting for the 30-min cache to expire.
    // Google Calendar API is ~500ms so this is fine on every nav / poll.
    const result = await fetchJson('/api/analyze', {
      method: 'POST',
      body: { fromIso, toIso, cacheOnly: true, forceRefresh: true },
    });
    // If user navigated again while the request was in flight, drop this response
    if (reqId !== state._cacheOnlyReqCounter) return;
    state.events = result.events || [];
    state.classifications = result.classifications || [];
    state.dcOpportunities = result.dcOpportunities || [];
    state.unmatchedSfEvents = result.unmatchedSfEvents || [];
    renderResults(result);
  } catch (e) {
    // Silent failure — the user can hit Analyze manually
    console.warn('cacheOnly fetch failed:', e.message);
  }
}

async function runAnalyze() {
  const fromDate = document.getElementById('from-date').value;
  const toDate = document.getElementById('to-date').value;
  if (!fromDate || !toDate) return alert('Select date range');
  const fromIso = `${fromDate}T00:00:00`;
  const toIso = `${toDate}T23:59:59`;

  const forceRefresh = document.getElementById('force-refresh').checked;
  const forceReclassify = document.getElementById('force-reclassify').checked;

  const btn = document.getElementById('analyze-btn');
  btn.disabled = true;
  btn.textContent = forceReclassify
    ? '⏳ Re-classifying all events…'
    : forceRefresh
    ? '⏳ Refreshing from Google…'
    : '⏳ Analyzing…';
  state._analyzeInFlight = true;

  try {
    const result = await fetchJson('/api/analyze', {
      method: 'POST',
      body: { fromIso, toIso, forceRefresh, forceReclassify },
    });
    state.events = result.events || [];
    state.classifications = result.classifications || [];
    state.dcOpportunities = result.dcOpportunities || [];
    state.unmatchedSfEvents = result.unmatchedSfEvents || [];
    renderResults(result);
    // Remember the last successfully-analyzed range so we can auto-restore on next page load
    saveLastRange(fromDate, toDate);
    // Reset force-* toggles so the next click defaults to cached
    document.getElementById('force-refresh').checked = false;
    document.getElementById('force-reclassify').checked = false;
  } catch (e) {
    showError(`Analyze failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Analyze';
    state._analyzeInFlight = false;
  }
}

function renderResults(result) {
  const s = result.summary || { counts: {}, cfHours: 0, crHours: 0 };
  document.getElementById('summary-bar').classList.remove('hidden');
  const skipped = (s.counts.skip || 0) + (s.counts.excluded || 0);
  paintChip('chip-fresh',        `${s.counts.fresh || 0} new`,                   (s.counts.fresh || 0) > 0);
  paintChip('chip-unclassified', `${s.counts.unclassified || 0} unclassified`,   (s.counts.unclassified || 0) > 0);
  paintChip('chip-identified',   `${s.counts.identified || 0} to log`,           (s.counts.identified || 0) > 0);
  paintChip('chip-logged',     `${s.counts.alreadyLogged || 0} already logged`, (s.counts.alreadyLogged || 0) > 0);
  paintChip('chip-flagged',    `${s.counts.flagged || 0} flagged`,              (s.counts.flagged || 0) > 0);
  paintChip('chip-skipped',    `${skipped} skipped`,                            skipped > 0);
  paintChip('chip-cf',         `${s.cfHours} CF hrs`,                           (s.cfHours || 0) > 0);
  paintChip('chip-cr',         `${s.crHours} CR hrs`,                           (s.crHours || 0) > 0);
  syncChipActiveStates();

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
      ? `📦 Calendar from cache (fetched ${ago} via ${backendLabel}).`
      : `🔄 Calendar fetched fresh at ${when.toLocaleTimeString('es-ES')} via ${backendLabel}.`;
    if (result.classifyMeta) {
      const { cacheHits, freshClassifications } = result.classifyMeta;
      const total = cacheHits + freshClassifications;
      if (total > 0) {
        txt += `  ·  🧠 Classification: ${cacheHits} from cache, ${freshClassifications} fresh.`;
      }
    }
    if (result.calendarMeta.fellBackTo) {
      txt += ` — Fallback: ${result.calendarMeta.fallbackReason || 'unknown'}`;
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
    // Map status → CSS class. Dedupe-match overrides status visually so the
    // user sees the duplicate-detection signal immediately on the calendar.
    let cssClass;
    if (status === 'already-logged') cssClass = 'event-logged';
    else if (status === 'unclassified') cssClass = 'event-unclassified';
    else if (cls?._dedupeMatch?.type === 'probably-logged') cssClass = 'event-probably-logged';
    else cssClass = `event-${status}`;

    const classes = [cssClass];
    if (cls?._dedupeMatch?.type === 'time-conflict') classes.push('event-time-conflict');

    state.calendar.addEvent({
      id: ev.id,
      title: ev.summary,
      start: ev.start,
      end: ev.end,
      extendedProps: {
        classes,
        classification: cls,
        raw: ev,
        googleColor,
      },
    });
  }

  // Render SF Events that DIDN'T match any calendar event as ghost blocks.
  // These were logged from outside this app (Activity Editor, Slack skill, etc.).
  for (const sf of state.unmatchedSfEvents || []) {
    state.calendar.addEvent({
      id: 'sf-' + sf.id,
      title: '📋 ' + sf.subject,
      start: sf.start,
      end: sf.end,
      extendedProps: {
        classes: ['event-sf-ghost'],
        sfData: sf,
        isSfOnly: true,
      },
    });
  }
  // Only re-position the calendar on a manual Analyze. cacheOnly fetches are
  // triggered BY calendar navigation, so we're already on the right date —
  // calling gotoDate here would yank the user back to whatever events[0].start
  // resolves to, causing visible jitter when scrolling fast.
  if (state.events.length && !result.classifyMeta?.cacheOnly) {
    state.calendar.gotoDate(new Date(state.events[0].start));
  }

  // Show the filter panel — pills get built AFTER draftRows is populated below
  document.getElementById('filter-panel').classList.remove('hidden');

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

  // Build filter pills now that draftRows is populated, then render the table.
  // (rebuildFilterPills reads from state.draftRows, so order matters here.)
  rebuildFilterPills();
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
      // SF-only ghost events: hide together with the "show already logged" toggle
      if (fcEvent.extendedProps?.isSfOnly) {
        fcEvent.setProp('display', state.showLogged ? 'auto' : 'none');
        continue;
      }
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

  // 3b. Calendar filter — empty set = no filter
  if (state.filters.calendars.size > 0) {
    if (!state.filters.calendars.has(ev._calendarId || '')) return false;
  }

  // 4. Text filter — checks title and description
  if (state.filters.text) {
    const haystack = ((ev.summary || '') + ' ' + (ev.description || '')).toLowerCase();
    if (!haystack.includes(state.filters.text)) return false;
  }

  // 5. CF / CR booleans (from chips)
  if (state.filters.cfOnly && !cls.isCF) return false;
  if (state.filters.crOnly && !cls.isCR) return false;

  // 6. Fresh-only — show only events that were freshly classified this run
  if (state.filters.freshOnly && cls._fromCache !== false) return false;

  return true;
}

// Backward-compat alias used elsewhere; just delegates.
function applyShowLoggedFilter() { applyAllFilters(); }

/**
 * Handle a click on one of the summary chips (status, status-multi, or bool).
 * Each chip toggles the corresponding filter state. Multiple chips can be
 * active at once and combine (intersection).
 */
function onChipClick(chip) {
  // Disabled chips (count=0) don't filter
  if (chip.classList.contains('chip-disabled')) return;

  const kind = chip.dataset.filter;
  const value = chip.dataset.value;
  if (!kind || !value) return;

  if (kind === 'status') {
    if (state.filters.statuses.has(value)) state.filters.statuses.delete(value);
    else state.filters.statuses.add(value);
  } else if (kind === 'status-multi') {
    // "skipped" chip = skip + excluded together. Toggle both at once.
    const values = value.split(',');
    const allOn = values.every((v) => state.filters.statuses.has(v));
    if (allOn) values.forEach((v) => state.filters.statuses.delete(v));
    else values.forEach((v) => state.filters.statuses.add(v));
  } else if (kind === 'bool') {
    if (value === 'cf') state.filters.cfOnly = !state.filters.cfOnly;
    else if (value === 'cr') state.filters.crOnly = !state.filters.crOnly;
    else if (value === 'fresh') state.filters.freshOnly = !state.filters.freshOnly;
  }

  syncChipActiveStates();
  // Status pills in the filter panel mirror the same state — refresh them too
  rebuildFilterPills();
  applyAllFilters();
}

/**
 * Turn ON every status chip that has events behind it. CF/CR booleans stay off
 * (they're "include-only" by nature, and combining them with all status filters
 * would over-restrict the view).
 */
function activateAllChips() {
  for (const chip of document.querySelectorAll('.summary-bar .chip')) {
    if (chip.classList.contains('chip-disabled')) continue;
    const kind = chip.dataset.filter;
    const value = chip.dataset.value;
    if (kind === 'status') {
      state.filters.statuses.add(value);
    } else if (kind === 'status-multi') {
      value.split(',').forEach((v) => state.filters.statuses.add(v));
    }
    // Skip 'bool' chips (CF / CR) — they over-restrict if both turned on
  }
}

/**
 * Repaint the .is-active class on each chip based on current state.filters.
 */
function syncChipActiveStates() {
  document.querySelectorAll('.summary-bar .chip').forEach((chip) => {
    const kind = chip.dataset.filter;
    const value = chip.dataset.value;
    let active = false;
    if (kind === 'status') {
      active = state.filters.statuses.has(value);
    } else if (kind === 'status-multi') {
      const values = value.split(',');
      active = values.every((v) => state.filters.statuses.has(v));
    } else if (kind === 'bool') {
      active = (value === 'cf' && state.filters.cfOnly)
            || (value === 'cr' && state.filters.crOnly)
            || (value === 'fresh' && state.filters.freshOnly);
    }
    chip.classList.toggle('is-active', active);
  });
}

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

  // CALENDAR pills — only render the group if more than one calendar is in view.
  // Events fetched via the Claude fallback don't carry _calendarId, so we treat
  // missing as a single bucket — the group simply won't appear.
  const calendarMap = new Map(); // id → name
  for (const row of state.draftRows.values()) {
    const id = row.event._calendarId;
    if (!id) continue;
    if (!calendarMap.has(id)) calendarMap.set(id, row.event._calendarName || id);
  }
  const calendarGroup = document.getElementById('filter-calendar-group');
  while (calendarGroup.children.length > 1) calendarGroup.removeChild(calendarGroup.lastChild);

  if (calendarMap.size <= 1) {
    calendarGroup.style.display = 'none';
    // Drop any stale calendar filter so it doesn't silently hide everything next time
    state.filters.calendars.clear();
    return;
  }
  calendarGroup.style.display = '';

  const orderedCals = [...calendarMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  for (const [id, name] of orderedCals) {
    const pill = makeCalendarPill(id, name);
    if (state.filters.calendars.has(id)) pill.classList.add('is-on');
    calendarGroup.appendChild(pill);
  }
}

function makeCalendarPill(id, name) {
  const pill = document.createElement('span');
  pill.className = 'filter-pill';
  pill.dataset.calendarId = id;
  pill.appendChild(document.createTextNode(name));
  pill.title = id;
  pill.addEventListener('click', () => {
    if (state.filters.calendars.has(id)) state.filters.calendars.delete(id);
    else state.filters.calendars.add(id);
    pill.classList.toggle('is-on');
    applyAllFilters();
  });
  return pill;
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
  // Only count rows that (a) are selectable by status AND (b) are currently visible.
  // The checkbox should answer: "are all currently-visible selectable rows ticked?"
  const selectable = [...state.draftRows.values()].filter((r) => {
    if (['already-logged', 'excluded', 'skip', 'unclassified'].includes(r.classification.status)) return false;
    if (r._visible === false) return false;
    return true;
  });
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
  cb.disabled = ['already-logged', 'excluded', 'skip', 'unclassified'].includes(cls.status);
  cb.addEventListener('change', () => {
    row.selected = cb.checked;
    refreshCreateBtn();
    // Sync the green-ring state on the calendar event
    if (state.calendar) {
      const fcEv = state.calendar.getEventById(row.event.id);
      if (fcEv) fcEv.setExtendedProp('_markTick', Date.now());
    }
  });
  tr.appendChild(td(cb));

  tr.appendChild(td(text(row.event.summary)));
  tr.appendChild(td(text(formatDateTime(row.event.start, row.event.end))));
  tr.appendChild(td(text(`${(row.event.durationHours || 0).toFixed(2)}`)));
  tr.appendChild(buildRelatedToCell(row));
  tr.appendChild(buildConfidenceCell(cls.confidence));
  tr.appendChild(buildTaskTypeCell(row));
  tr.appendChild(buildBoolCell(cls.isCF, (v) => { cls.isCF = v; saveOverride(row, { isCF: v }); }));
  tr.appendChild(buildBoolCell(cls.isCR, (v) => { cls.isCR = v; saveOverride(row, { isCR: v }); }));
  tr.appendChild(buildStatusCell(cls));

  return tr;
}

// Sentinel value used by the select to trigger the "paste URL/ID" inline editor.
const PASTE_OPTION_VALUE = '__paste__';

/**
 * Persist a user edit so it survives page reloads. Best-effort — failures
 * don't block the UI (the local state still reflects the change).
 */
function saveOverride(row, fields) {
  const hash = row.classification._hash;
  if (!hash) return; // can't persist without hash (shouldn't happen post-analyze)
  fetchJson('/api/override', {
    method: 'POST',
    body: { eventId: row.event.id, hash, fields },
  }).catch((e) => console.warn('saveOverride failed', e));
}

function buildRelatedToCell(row) {
  const cls = row.classification;
  if (cls.status === 'already-logged') return td(em('logged'));
  if (cls.status === 'excluded' || cls.status === 'skip') return td(em('—'));

  const cell = document.createElement('td');
  cell.appendChild(buildRelatedToSelect(row, cell));
  return cell;
}

/**
 * Build the dropdown widget. Layout:
 *   ✎ Paste URL or ID…              ← always at top so no scrolling needed
 *   — none —
 *   ▸ ✎ Manually added (config.manualRelatedRecords + LLM-picked extra)
 *   ▸ 📌 Opportunities (from DCs, excluding long-closed >30d)
 *   ▸ 🏢 Accounts (distinct from DC list)
 *
 * When user picks "Paste URL or ID…" the cell is replaced with a text input
 * that resolves the URL/ID against org62.
 */
function buildRelatedToSelect(row, cellEl) {
  const cls = row.classification;
  const select = document.createElement('select');

  // 1. PASTE option at top — user wanted this so they don't have to scroll
  const pasteOpt = document.createElement('option');
  pasteOpt.value = PASTE_OPTION_VALUE;
  pasteOpt.textContent = '✎ Paste URL or ID…';
  select.appendChild(pasteOpt);

  // 2. Empty option
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '— none —';
  if (!cls.relatedTo) empty.selected = true;
  select.appendChild(empty);

  // Track whether we found the current selection in any group, so we know
  // whether to add an extra "LLM-picked" entry as fallback at the end.
  let selectionFound = false;
  const currentId = cls.relatedTo?.id;
  const todayMs = Date.now();

  // 3. Manually added group (persisted across sessions)
  const manual = state.config?.manualRelatedRecords || [];
  if (manual.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = '✎ Manually added';
    for (const r of manual) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ id: r.id, name: r.name, type: r.type });
      opt.textContent = `${r.name} (${r.type})`;
      if (r.id === currentId) { opt.selected = true; selectionFound = true; }
      grp.appendChild(opt);
    }
    select.appendChild(grp);
  }

  // 4. Opportunities from DCs — split active-vs-recently-closed for visual cue
  const oppsActive = state.dcOpportunities.filter((d) => !d.opportunityIsClosed);
  const oppsRecentClosed = state.dcOpportunities.filter((d) => d.opportunityIsClosed);

  if (oppsActive.length > 0 || oppsRecentClosed.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = '📌 Opportunities';
    for (const dc of oppsActive) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ id: dc.opportunityId, name: dc.opportunityName, type: 'Opportunity' });
      opt.textContent = `${dc.opportunityName} — ${dc.accountName}`;
      if (dc.opportunityId === currentId) { opt.selected = true; selectionFound = true; }
      grp.appendChild(opt);
    }
    for (const dc of oppsRecentClosed) {
      const days = dc.opportunityCloseDate
        ? Math.max(0, Math.floor((todayMs - new Date(dc.opportunityCloseDate).getTime()) / (24 * 60 * 60 * 1000)))
        : null;
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ id: dc.opportunityId, name: dc.opportunityName, type: 'Opportunity' });
      opt.textContent = `${dc.opportunityName} — ${dc.accountName}` + (days !== null ? `  ⊘ closed ${days}d ago` : '  ⊘ closed');
      if (dc.opportunityId === currentId) { opt.selected = true; selectionFound = true; }
      grp.appendChild(opt);
    }
    select.appendChild(grp);
  }

  // 5. Accounts — distinct accounts derived from DC list
  const accountsSeen = new Set();
  const accounts = [];
  for (const dc of state.dcOpportunities) {
    if (!dc.accountId || accountsSeen.has(dc.accountId)) continue;
    accountsSeen.add(dc.accountId);
    accounts.push({ id: dc.accountId, name: dc.accountName });
  }
  accounts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (accounts.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = '🏢 Accounts (from your DCs)';
    for (const a of accounts) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ id: a.id, name: a.name, type: 'Account' });
      opt.textContent = a.name;
      if (a.id === currentId) { opt.selected = true; selectionFound = true; }
      grp.appendChild(opt);
    }
    select.appendChild(grp);
  }

  // 6. Fallback — if the current selection wasn't in any group, add it explicitly
  // (e.g. an LLM-picked Opportunity that's now filtered out as long-closed)
  if (cls.relatedTo && !selectionFound) {
    const grp = document.createElement('optgroup');
    grp.label = '⚙ Current selection (not in lists above)';
    const opt = document.createElement('option');
    opt.value = JSON.stringify(cls.relatedTo);
    opt.textContent = `${cls.relatedTo.name} (${cls.relatedTo.type})`;
    opt.selected = true;
    grp.appendChild(opt);
    select.appendChild(grp);
  }

  select.addEventListener('change', () => {
    if (select.value === PASTE_OPTION_VALUE) {
      // Sentinel — don't take it as a real value. Swap the cell to text input.
      // Restore the visual selection back to whatever was there before this click.
      restoreSelectToCurrent(select, cls.relatedTo);
      swapToPasteInput(row, cellEl);
      return;
    }
    cls.relatedTo = select.value ? JSON.parse(select.value) : null;
    saveOverride(row, { relatedTo: cls.relatedTo });
  });

  return select;
}

/** Reset the select's visual state to match cls.relatedTo (used after the paste sentinel). */
function restoreSelectToCurrent(select, relatedTo) {
  const targetId = relatedTo?.id;
  // Walk every option (including those inside optgroups)
  for (const opt of select.querySelectorAll('option')) {
    if (!targetId && opt.value === '') { opt.selected = true; return; }
    if (targetId) {
      try {
        const v = opt.value && opt.value !== PASTE_OPTION_VALUE ? JSON.parse(opt.value) : null;
        if (v?.id === targetId) { opt.selected = true; return; }
      } catch {}
    }
  }
  // Fall back to the empty option
  select.selectedIndex = 1;
}

/**
 * Replace the select widget with a text input. User pastes a URL or ID, presses
 * Enter or blurs → backend resolves it → cell goes back to a select with the new
 * record selected.
 */
function swapToPasteInput(row, cellEl) {
  cellEl.replaceChildren();

  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'column';
  wrapper.style.gap = '3px';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Paste Salesforce URL or 15/18-char ID';
  input.style.fontSize = '12px';
  wrapper.appendChild(input);

  const status = document.createElement('span');
  status.style.fontSize = '11px';
  status.style.color = 'var(--muted)';
  wrapper.appendChild(status);

  cellEl.appendChild(wrapper);

  let resolving = false;
  const resolve = async () => {
    const value = input.value.trim();
    if (!value || resolving) return;
    resolving = true;
    status.style.color = 'var(--muted)';
    status.textContent = 'Looking up in org62…';
    try {
      const r = await fetchJson('/api/setup/resolve-id', {
        method: 'POST',
        body: { idOrUrl: value },
      });
      // Set the row's relatedTo, persist as override, rebuild the cell as a select
      row.classification.relatedTo = { id: r.id, name: r.name, type: r.type };
      saveOverride(row, { relatedTo: row.classification.relatedTo });
      // Refresh local config so the new record shows under "Manually added" in
      // every dropdown going forward (without needing a page reload)
      try {
        const cfgResp = await fetchJson('/api/config');
        if (cfgResp?.config) state.config = cfgResp.config;
      } catch {}
      cellEl.replaceChildren(buildRelatedToSelect(row, cellEl));
    } catch (e) {
      status.style.color = '#cf222e';
      status.textContent = `✗ ${e.message}`;
      resolving = false;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); resolve(); }
    if (e.key === 'Escape') {
      // Cancel — rebuild cell with the original select
      cellEl.replaceChildren(buildRelatedToSelect(row, cellEl));
    }
  });
  input.addEventListener('blur', () => {
    // Small delay so Escape's rebuild can win the race
    setTimeout(() => {
      if (input.isConnected && input.value.trim()) resolve();
    }, 100);
  });

  // Auto-focus so the user can paste immediately
  setTimeout(() => input.focus(), 0);
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
  if (['already-logged', 'excluded', 'skip', 'unclassified'].includes(cls.status)) return td(em('—'));

  const select = document.createElement('select');
  for (const t of SE_TASK_TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (cls.seTaskType === t) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    cls.seTaskType = select.value;
    saveOverride(row, { seTaskType: cls.seTaskType });
  });
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

  // Two-tier closed-opp check warning
  if (cls._closedOppCheck && cls._closedOppCheck.status !== 'open-at-event') {
    const warn = document.createElement('div');
    warn.className = 'closed-opp-warning';
    const isHard = cls._closedOppCheck.status === 'closed-at-event';
    warn.classList.toggle('closed-opp-warning-hard', isHard);
    warn.title = cls._closedOppCheck.warning || '';
    warn.textContent = isHard
      ? '⚠ Opp was already closed on event date'
      : 'ℹ Opp closed status on event date unverifiable';
    cell.appendChild(warn);
  }

  // Dedup match warning — orange for probably-logged, yellow for time-conflict
  if (cls._dedupeMatch && cls._dedupeMatch.type !== 'exact') {
    const m = cls._dedupeMatch;
    const banner = document.createElement('div');
    banner.className = 'dedupe-banner';
    banner.classList.toggle('dedupe-banner-probably', m.type === 'probably-logged');
    banner.classList.toggle('dedupe-banner-conflict', m.type === 'time-conflict');
    const range = formatTimeRange(m.sfStart, m.sfEnd);
    banner.title = m.sfSubject;
    banner.textContent = m.type === 'probably-logged'
      ? `📋 Probably logged: "${truncate(m.sfSubject, 40)}" ${range}`
      : `⏰ Time clash: "${truncate(m.sfSubject, 40)}" ${range}`;
    cell.appendChild(banner);
  }
  return cell;
}

function formatTimeRange(startIso, endIso) {
  const t = (d) => new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return `${t(startIso)}–${t(endIso)}`;
}

function truncate(s, n) {
  return (s || '').length > n ? (s || '').slice(0, n - 1) + '…' : (s || '');
}

function refreshCreateBtn() {
  const createBtn = document.getElementById('create-btn');
  const exportBtn = document.getElementById('export-btn');
  const count = [...state.draftRows.values()].filter((r) => r.selected).length;
  createBtn.disabled = count === 0;
  createBtn.textContent = count === 0 ? 'Create in org62' : `Create ${count} in org62`;
  if (exportBtn) {
    exportBtn.disabled = count === 0;
    exportBtn.textContent = count === 0 ? '📥 Export JSON' : `📥 Export JSON (${count})`;
  }
  syncSelectAllCheckbox();
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Build the array of items ready to be written to org62 from the currently
 * selected draft rows. Pure function — no side effects, used by both runCreate
 * (POST) and exportSelection (download as JSON).
 */
function buildApproved() {
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
      // Human-readable mirrors of whatId / dcOpportunityId — not sent to /api/create
      // but useful for someone reviewing the JSON or re-importing manually.
      relatedToName: cls.relatedTo?.name || null,
      relatedToType: cls.relatedTo?.type || null,
      seTaskType: cls.seTaskType,
      isCF: cls.isCF,
      isCR: cls.isCR,
      createDc: shouldCreateDc(cls),
      dcOpportunityId: cls.relatedTo?.type === 'Opportunity' ? cls.relatedTo.id : null,
      splitPercentage: 100,
    });
  }
  return approved;
}

/**
 * Strip presentation-only fields before POSTing to /api/create. Server only
 * reads the canonical payload — extra fields would be ignored but make the
 * request larger.
 */
function stripForApi(approved) {
  return approved.map(({ relatedToName, relatedToType, ...rest }) => rest);
}

/**
 * Download the current selection as a JSON file. Used as a backup mechanism
 * when org62 writes fail and the user wants to re-upload via another method.
 */
function exportSelection() {
  const approved = buildApproved();
  if (approved.length === 0) return;

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    se: state.config ? {
      userId: state.config.seUserId,
      name: state.config.seName,
      email: state.config.seEmail,
      opportunityRole: state.config.seOpportunityRole,
    } : null,
    count: approved.length,
    approved,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  // Local time in the filename so the user sees a familiar timestamp
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16); // YYYY-MM-DDTHH-MM
  a.href = url;
  a.download = `sf-activity-tracker-selection-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function runCreate() {
  const approved = buildApproved();
  if (approved.length === 0) return;

  document.getElementById('progress-card').classList.remove('hidden');
  const log = document.getElementById('progress-log');
  log.replaceChildren();

  try {
    await sse('/api/create', { approved: stripForApi(approved) }, (event, data) => {
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
  const counts = { identified: 0, alreadyLogged: 0, flagged: 0, skip: 0, excluded: 0, unclassified: 0, fresh: 0 };
  let cfHours = 0;
  let crHours = 0;
  for (const row of state.draftRows.values()) {
    const cls = row.classification;
    const key = cls.status === 'already-logged' ? 'alreadyLogged' : cls.status;
    counts[key] = (counts[key] || 0) + 1;
    if (cls._fromCache === false) counts.fresh++;
    if (cls.status === 'identified') {
      const dur = row.event.durationHours || 0;
      if (cls.isCF) cfHours += dur;
      if (cls.isCR) crHours += dur;
    }
  }
  const skippedTotal = counts.skip + counts.excluded;
  paintChip('chip-fresh',        `${counts.fresh} new`,                    counts.fresh > 0);
  paintChip('chip-unclassified', `${counts.unclassified} unclassified`,    counts.unclassified > 0);
  paintChip('chip-identified',   `${counts.identified} to log`,           counts.identified > 0);
  paintChip('chip-logged',     `${counts.alreadyLogged} already logged`, counts.alreadyLogged > 0);
  paintChip('chip-flagged',    `${counts.flagged} flagged`,              counts.flagged > 0);
  paintChip('chip-skipped',    `${skippedTotal} skipped`,                skippedTotal > 0);
  const cfHrs = Math.round(cfHours * 100) / 100;
  const crHrs = Math.round(crHours * 100) / 100;
  paintChip('chip-cf',         `${cfHrs} CF hrs`,                        cfHrs > 0);
  paintChip('chip-cr',         `${crHrs} CR hrs`,                        crHrs > 0);

  syncChipActiveStates();
}

/** Set chip text + disabled state if there's nothing to filter on. */
function paintChip(id, text, enabled) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('chip-disabled', !enabled);
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
  const hasConfig = !!(cfg && cfg.configured && cfg.config);
  if (hasConfig) state.config = cfg.config;
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('config-raw').textContent = JSON.stringify(cfg, null, 2);
  document.getElementById('settings-excluded').value = (cfg.config?.excludedTitles || []).join('\n');

  // Identidad — read-only, derivada del setup. La org auth manda; no editable aquí.
  const idDisplay = document.getElementById('account-identity-display');
  if (idDisplay) {
    idDisplay.replaceChildren();
    if (!hasConfig) {
      idDisplay.appendChild(text('Setup pendiente. Conecta un backend (CLI o MCP) más abajo y luego cierra Settings para volver al wizard y resolver tu user en org62.'));
    } else {
      idDisplay.appendChild(text(`Logueado en org62 como `));
      const b = document.createElement('b'); b.textContent = cfg.config.seName || '?'; idDisplay.appendChild(b);
      idDisplay.appendChild(text(` (${cfg.config.seEmail || '?'}). User Id: ${cfg.config.seUserId || '?'} · TZ ${cfg.config.timeZone || '?'}.`));
      const br = document.createElement('br'); idDisplay.appendChild(br);
      idDisplay.appendChild(text('Esta identidad se auto-detecta del '));
      const code = document.createElement('code'); code.textContent = 'sf'; idDisplay.appendChild(code);
      idDisplay.appendChild(text(' CLI en cada nuevo setup. Si necesitas cambiarla, re-autentícate con '));
      const code2 = document.createElement('code'); code2.textContent = 'sf org login web --alias org62'; idDisplay.appendChild(code2);
      idDisplay.appendChild(text(' y borra '));
      const code3 = document.createElement('code'); code3.textContent = '~/.config/sf-activity-tracker/config.json'; idDisplay.appendChild(code3);
      idDisplay.appendChild(text('.'));
    }
  }

  // SF MCP backend (Fase 1) — load current state into the form
  await refreshSfMcpSection();

  // Backend router (Fase 3) — mode + preferred + active
  await refreshSfBackendSection();

  // During setup, land on the Cuenta tab so the user sees backend config first.
  const lastTab = hasConfig
    ? (localStorage.getItem('sfat:settingsTab') || 'calendar')
    : 'account';
  switchSettingsTab(lastTab);

  // Google API section
  await refreshGoogleApiSection();
  // Calendar picker — only meaningful when Google API is configured
  if (hasConfig) await refreshCalendarPicker();
  // DC filtering rules
  if (hasConfig) await refreshDcFiltersSection();
  // Classification cache stats
  await refreshClassCacheSection();

  const aliasBody = document.querySelector('#alias-table tbody');
  aliasBody.replaceChildren();
  const aliases = cfg.config?.aliasTable || [];
  if (!aliases.length) {
    aliasBody.appendChild(emptyTableRow(2, hasConfig ? 'Sin aliases todavía. Se aprenden corrigiendo el matching.' : 'Disponible tras completar el setup.'));
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
  const corrections = cfg.config?.taxonomyCorrections || [];
  if (!corrections.length) {
    corrBody.appendChild(emptyTableRow(2, hasConfig ? 'Sin correcciones todavía.' : 'Disponible tras completar el setup.'));
  } else {
    for (const c of corrections) {
      const tr = document.createElement('tr');
      tr.appendChild(td(text(c.keyword)));
      tr.appendChild(td(text(c.seTaskType)));
      corrBody.appendChild(tr);
    }
  }

  const cd = document.getElementById('catchall-display');
  cd.textContent = cfg.config?.catchAll ? `${cfg.config.catchAll.type}: ${cfg.config.catchAll.name}` : 'No configurado.';
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

// ─── SF MCP backend (Fase 1: config + OAuth + tools/list test) ──────────────

async function refreshSfMcpSection() {
  try {
    const r = await fetchJson('/api/sf-mcp/config');
    document.getElementById('sf-mcp-client-id').value = r.clientId || '';
    document.getElementById('sf-mcp-callback-port').value = r.callbackPort || 8082;
    document.getElementById('sf-mcp-redirect-host').value = r.redirectHost || 'localhost';
    document.getElementById('sf-mcp-redirect-path').value = r.redirectPath || '/oauth/callback';
    document.getElementById('sf-mcp-redirect-uri-display').textContent = r.redirectUri || '—';
    paintSfMcpStatus(r);
  } catch (e) {
    document.getElementById('sf-mcp-status').textContent = `Error: ${e.message}`;
  }
}

function paintSfMcpStatus(s) {
  const el = document.getElementById('sf-mcp-status');
  if (!el) return;
  if (!s.clientId) {
    el.innerHTML = '<span style="color: var(--muted);">Sin clientId — pega tu Connected App clientId y guarda.</span>';
  } else if (!s.hasTokens) {
    el.innerHTML = '<span style="color: var(--muted);">clientId guardado · no conectado todavía. Pulsa Connect via OAuth.</span>';
  } else {
    const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleString() : 'desconocido';
    el.innerHTML = `<span style="color: #047857;">✓ Conectado</span> · scope: <code>${s.scope || '?'}</code> · access_token expira: ${exp}`;
  }
}

async function saveSfMcpConfig() {
  const clientId = document.getElementById('sf-mcp-client-id').value.trim();
  const callbackPort = parseInt(document.getElementById('sf-mcp-callback-port').value, 10);
  const redirectHost = document.getElementById('sf-mcp-redirect-host').value.trim() || 'localhost';
  const redirectPath = document.getElementById('sf-mcp-redirect-path').value.trim() || '/oauth/callback';
  showSfMcpOutput('Guardando…');
  try {
    const r = await fetchJson('/api/sf-mcp/config', {
      method: 'PUT',
      body: {
        clientId: clientId || null,
        callbackPort: Number.isInteger(callbackPort) ? callbackPort : 8082,
        redirectHost,
        redirectPath,
      },
    });
    await refreshSfMcpSection();
    showSfMcpOutput(`✓ Config guardada. Redirect URI: ${r.redirectUri}`);
  } catch (e) {
    showSfMcpOutput(`✗ ${e.message}`);
  }
}

async function connectSfMcp() {
  showSfMcpOutput('Abriendo browser para OAuth… completa el login y vuelve aquí.');
  try {
    const r = await fetchJson('/api/sf-mcp/oauth/start', { method: 'POST' });
    if (r.ok) {
      await refreshSfMcpSection();
      showSfMcpOutput('✓ Conectado. Ahora pulsa "Test (tools/list)" para descubrir las tools que expone el server.');
    } else {
      showSfMcpOutput(`✗ ${r.error || 'Error desconocido'}`);
    }
  } catch (e) {
    showSfMcpOutput(`✗ ${e.message}`);
  }
}

async function testSfMcp() {
  showSfMcpOutput('Llamando tools/list a reads + mutations…');
  try {
    const r = await fetchJson('/api/sf-mcp/test', { method: 'POST' });
    showSfMcpOutput(JSON.stringify(r, null, 2));
  } catch (e) {
    showSfMcpOutput(`✗ ${e.message}`);
  }
}

async function disconnectSfMcp() {
  if (!confirm('¿Borrar tokens MCP? Tendrás que reconectar la próxima vez.')) return;
  try {
    await fetchJson('/api/sf-mcp/oauth/disconnect', { method: 'POST' });
    await refreshSfMcpSection();
    showSfMcpOutput('✓ Tokens borrados.');
  } catch (e) {
    showSfMcpOutput(`✗ ${e.message}`);
  }
}

function showSfMcpOutput(text) {
  const el = document.getElementById('sf-mcp-output');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = text;
}

// Wire buttons once at DOM ready (the modal is in the DOM from the start).
document.addEventListener('DOMContentLoaded', () => {
  const wire = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  };
  wire('sf-mcp-save-btn', saveSfMcpConfig);
  wire('sf-mcp-connect-btn', connectSfMcp);
  wire('sf-mcp-test-btn', testSfMcp);
  wire('sf-mcp-disconnect-btn', disconnectSfMcp);
});

// ─── Backend router (CLI vs MCP vs auto) ─────────────────────────────────────

async function refreshSfBackendSection() {
  try {
    const cfg = await fetchJson('/api/sf-backend/mode');
    document.querySelectorAll('input[name="sf-backend-mode"]').forEach((r) => {
      r.checked = r.value === cfg.mode;
    });
    document.querySelectorAll('input[name="sf-backend-preferred"]').forEach((r) => {
      r.checked = r.value === (cfg.preferred || 'cli');
    });
    const prefWrap = document.getElementById('sf-backend-preferred-wrap');
    if (prefWrap) prefWrap.style.display = cfg.mode === 'auto' ? '' : 'none';
    renderSfBackendStatus(cfg);
  } catch (e) {
    const el = document.getElementById('sf-backend-status');
    if (el) el.textContent = `Error: ${e.message}`;
  }
}

function renderSfBackendStatus(cfg, results) {
  const el = document.getElementById('sf-backend-status');
  if (!el) return;
  const dot = (ok) => ok === true ? '✓' : ok === false ? '✗' : '·';
  const cliDot = dot(results?.cli?.ok);
  const mcpDot = dot(results?.mcp?.ok);
  const cliErr = results?.cli?.error ? ` (${results.cli.error})` : '';
  const mcpErr = results?.mcp?.error ? ` (${results.mcp.error})` : '';
  const active = cfg.active ? `<b>${cfg.active.toUpperCase()}</b>` : '—';
  const checked = cfg.lastChecked ? ` · last checked ${new Date(cfg.lastChecked).toLocaleString()}` : '';
  el.innerHTML =
    `Mode: <b>${cfg.mode}</b> · Active: ${active}${checked}<br>` +
    `CLI ${cliDot}${cliErr}<br>` +
    `MCP ${mcpDot}${mcpErr}`;
}

async function saveSfBackendMode() {
  const modeEl = document.querySelector('input[name="sf-backend-mode"]:checked');
  const prefEl = document.querySelector('input[name="sf-backend-preferred"]:checked');
  if (!modeEl) return;
  const body = { mode: modeEl.value };
  if (prefEl) body.preferred = prefEl.value;
  try {
    await fetchJson('/api/sf-backend/mode', { method: 'PUT', body: JSON.stringify(body) });
    await refreshSfBackendSection();
  } catch (e) {
    const el = document.getElementById('sf-backend-status');
    if (el) el.textContent = `Error guardando: ${e.message}`;
  }
}

async function testSfBackend() {
  const btn = document.getElementById('sf-backend-test-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  try {
    const r = await fetchJson('/api/sf-backend/test', { method: 'POST' });
    renderSfBackendStatus(r.config, r);
  } catch (e) {
    const el = document.getElementById('sf-backend-status');
    if (el) el.textContent = `Test failed: ${e.message}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test connection (both)'; }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[name="sf-backend-mode"]').forEach((r) => {
    r.addEventListener('change', saveSfBackendMode);
  });
  document.querySelectorAll('input[name="sf-backend-preferred"]').forEach((r) => {
    r.addEventListener('change', saveSfBackendMode);
  });
  const t = document.getElementById('sf-backend-test-btn');
  if (t) t.addEventListener('click', testSfBackend);
});

// ─── AI-prompt copy buttons in setup-help blocks ─────────────────────────────

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-prompt-btn');
  if (!btn) return;
  const block = btn.closest('.ai-prompt-block');
  const pre = block?.querySelector('pre');
  if (!pre) return;
  try {
    await navigator.clipboard.writeText(pre.textContent);
    const prev = btn.textContent;
    btn.textContent = '✓ Copiado';
    btn.classList.add('is-copied');
    setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove('is-copied');
    }, 1500);
  } catch (err) {
    btn.textContent = 'Error';
    setTimeout(() => { btn.textContent = 'Copiar'; }, 1500);
  }
});

/**
 * Switch the active tab in the Settings modal. Persists to localStorage so the
 * next time the user opens Settings they land on the same tab.
 */
function switchSettingsTab(tabKey) {
  document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tabKey);
  });
  document.querySelectorAll('.settings-tab-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.tab === tabKey);
  });
  localStorage.setItem('sfat:settingsTab', tabKey);
}

// Wire tab buttons once at load — the modal markup is in the DOM from the start.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.tab));
  });
});

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

// ─── DC filters section ──────────────────────────────────────────────────────

async function refreshDcFiltersSection() {
  const cfg = state.config || {};
  const f = cfg.dcFilters || {};
  document.getElementById('dcf-closed-lookback').value = f.closedLookbackDays ?? 30;
  document.getElementById('dcf-min-split').value = f.minSplitPercentage ?? 0;
  document.getElementById('dcf-max-split').value = f.maxSplitPercentage ?? 100;

  // Load distinct values from the user's actual DC data + render checkboxes
  let opts;
  try {
    opts = await fetchJson('/api/dc-filters/options');
  } catch (e) {
    document.getElementById('dcf-stages-list').textContent = `Error: ${e.message}`;
    return;
  }

  renderDcfCheckboxList('dcf-stages-list',     opts.stages,             f.excludeOppStages);
  renderDcfCheckboxList('dcf-roles-list',      opts.roles,              f.includeRoles);
  renderDcfCheckboxList('dcf-engagement-list', opts.engagementStatuses, f.includeEngagementStatuses);

  // Wire the save button (idempotent)
  const saveBtn = document.getElementById('dc-filters-save-btn');
  const statusEl = document.getElementById('dc-filters-status');
  saveBtn.onclick = async () => {
    const dcFilters = {
      closedLookbackDays: parseInt(document.getElementById('dcf-closed-lookback').value, 10) || 0,
      minSplitPercentage: clampPct(document.getElementById('dcf-min-split').value, 0),
      maxSplitPercentage: clampPct(document.getElementById('dcf-max-split').value, 100),
      excludeOppStages: getDcfChecked('dcf-stages-list'),
      includeRoles: getDcfChecked('dcf-roles-list'),
      includeEngagementStatuses: getDcfChecked('dcf-engagement-list'),
    };
    if (dcFilters.minSplitPercentage > dcFilters.maxSplitPercentage) {
      statusEl.style.color = '#cf222e';
      statusEl.textContent = 'min split no puede ser mayor que max';
      return;
    }

    try {
      await fetchJson('/api/config', { method: 'PUT', body: { dcFilters } });
      // Changing DC filters changes which opps are visible to the classifier
      // → previous classifications might map to a now-excluded opp. Clear cache.
      await fetchJson('/api/cache/clear', { method: 'POST' });
      state.config.dcFilters = dcFilters;
      statusEl.style.color = '#1a7f37';
      statusEl.textContent = '✓ Reglas guardadas. Classification cache limpiado.';
    } catch (e) {
      statusEl.style.color = '#cf222e';
      statusEl.textContent = `✗ ${e.message}`;
    }
  };
}

/**
 * Render a list of {value, count} options as labeled checkboxes inside the
 * given container. Pre-checks any option whose value matches the savedValues
 * array (case-insensitive comparison so user-entered values still match).
 */
function renderDcfCheckboxList(containerId, options, savedValues) {
  const container = document.getElementById(containerId);
  container.replaceChildren();
  if (!options || options.length === 0) {
    const span = document.createElement('span');
    span.className = 'hint';
    span.textContent = 'No hay valores en tus DCs todavía.';
    container.appendChild(span);
    return;
  }
  const savedSet = new Set((savedValues || []).map((s) => (s || '').toLowerCase().trim()));
  for (const opt of options) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.value = opt.value;
    cb.checked = savedSet.has((opt.value || '').toLowerCase().trim());
    label.appendChild(cb);
    const text = document.createElement('span');
    // opt.label is set for synthetic entries like the "(no definido)" placeholder
    // for blank-value records; otherwise just show the raw value.
    text.textContent = opt.label || opt.value;
    if (opt.label) text.style.fontStyle = 'italic';
    label.appendChild(text);
    const count = document.createElement('span');
    count.className = 'dcf-count';
    count.textContent = `${opt.count}`;
    label.appendChild(count);
    container.appendChild(label);
  }
}

function getDcfChecked(containerId) {
  return [...document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)]
    .map((cb) => cb.dataset.value);
}

function clampPct(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

// ─── Classification cache section ────────────────────────────────────────────

async function refreshClassCacheSection() {
  const statsEl = document.getElementById('class-cache-stats');
  const pruneBtn = document.getElementById('class-cache-prune-btn');
  const clearBtn = document.getElementById('class-cache-clear-btn');

  pruneBtn.onclick = async () => {
    const r = await fetchJson('/api/cache/prune', { method: 'POST' });
    statsEl.textContent = `✓ Pruned ${r.pruned} entries older than 90 days.`;
    setTimeout(refreshClassCacheSection, 800);
  };
  clearBtn.onclick = async () => {
    if (!confirm('Borrar todas las clasificaciones cacheadas? El próximo Analyze re-clasificará todo.')) return;
    await fetchJson('/api/cache/clear', { method: 'POST' });
    statsEl.textContent = '✓ Cache cleared.';
    setTimeout(refreshClassCacheSection, 800);
  };

  try {
    const s = await fetchJson('/api/cache/stats');
    if (s.count === 0) {
      statsEl.textContent = 'Sin clasificaciones cacheadas todavía. La primera vez que analices se irán guardando.';
    } else {
      const oldest = s.oldestAt ? new Date(s.oldestAt).toLocaleDateString('es-ES') : '—';
      const newest = s.newestAt ? new Date(s.newestAt).toLocaleDateString('es-ES') : '—';
      statsEl.textContent = `${s.count} clasificaciones cacheadas · más antigua: ${oldest} · más nueva: ${newest}`;
    }
  } catch (e) {
    statsEl.textContent = `Error: ${e.message}`;
  }
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
