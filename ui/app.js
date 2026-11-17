'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { lookups: null, pickers: {}, runId: null, pollTimer: null };
const PREFS_KEY = 'clinicalSeeder.login';
const STAGE_NAMES = { scheduled: 'Scheduled', performed: 'Performed', coded: 'Coded', charged: 'Charged', remitted: 'ERA posted' };
/** The workflow steps, in order, and the stage each one ends at. */
const FLOW = [['Create case', 'scheduled'], ['Discharge', 'performed'], ['Code', 'coded'], ['Charge entry', 'charged'], ['ERA', 'remitted']];
const STAGE_ORDER = FLOW.map(([, stage]) => stage);
const trackerOf = (id) => state.lookups?.trackers.find((t) => t.id === id);
const eraOutcomeName = (id) => state.lookups?.eraOutcomes?.find((o) => o.id === id)?.name ?? id;

// #region HTTP

async function api(path, options = {}) {
    const res = await fetch(`/api/${path}`, {
        method: options.body ? 'POST' : (options.method || 'GET'),
        headers: options.body ? { 'Content-Type': 'application/json' } : {},
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (res.status === 401 && path !== 'login') showLogin();
    if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
    return data;
}

function toast(message, bad = false) {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast${bad ? ' bad' : ''}`;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 3500);
}

function prefs(value) {
    try {
        if (value) localStorage.setItem(PREFS_KEY, JSON.stringify(value));
        return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    } catch {
        return {};
    }
}

// #endregion

// #region Sign in

function showLogin() {
    $('#loginView').hidden = false;
    $('#appView').hidden = true;
    $('#sessionBox').hidden = true;
    const saved = prefs();
    for (const key of ['apiUrl', 'organizationId', 'username']) {
        if (saved[key]) $(`#loginForm [name=${key}]`).value = saved[key];
    }
}

async function showApp(session) {
    $('#loginView').hidden = true;
    $('#appView').hidden = false;
    $('#sessionBox').hidden = false;
    const facility = session.organizationName ? `${session.organizationName} (${session.organizationId})` : `facility ${session.organizationId} (name not verified)`;
    $('#sessionText').textContent = `${session.username} · ${facility} · ${new URL(session.apiUrl).host}`;
    await loadLookups();
}

$('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.target));
    const status = $('#loginStatus');
    status.textContent = 'Signing in and loading the facility lists…';
    status.classList.remove('bad');
    $('#loginForm button').disabled = true;
    try {
        const session = await api('login', { body: { ...form, organizationId: Number(form.organizationId) } });
        prefs({ apiUrl: form.apiUrl, organizationId: form.organizationId, username: form.username });
        e.target.password.value = '';
        status.textContent = '';
        await showApp(session);
    } catch (err) {
        status.textContent = err.message;
        status.classList.add('bad');
    } finally {
        $('#loginForm button').disabled = false;
    }
});

$('#logoutBtn').addEventListener('click', async () => {
    await api('logout', { body: {} }).catch(() => undefined);
    stopPolling();
    showLogin();
});

// #endregion

// #region Lookups and form controls

async function loadLookups(refresh = false) {
    state.lookups = await api(`lookups${refresh ? '?refresh=1' : ''}`);
    const failed = Object.entries(state.lookups.errors || {});
    if (failed.length) toast(`Some lists did not load: ${failed.map(([k, v]) => `${k} (${v})`).join('; ')}`, true);
    for (const el of $$('.picker')) renderPicker(el);
    renderTrackers();
    renderPeriods();
    renderCalendar();
    holdIfCaseRunGoing();
    const rooms = state.lookups.rooms;
    $('#autoRooms').textContent = `Rooms: all ${rooms.length} room(s), in turn${rooms.length && rooms.length <= 8 ? ` (${rooms.map((r) => r.name).join(', ')})` : ''}.`;
    $('#autoAppts').textContent = `Appointment type: random for each case, from ${state.lookups.appointmentTypes.length} type(s).`;
    $('#autoProcs').textContent = `Random CPTs from the facility's fee schedule (${state.lookups.feeSchedule.length} available).`;
}

// #region Calendar

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Month calendar where any number of days can be ticked; today is picked to start with. */
function renderCalendar() {
    if (!state.dates) state.dates = new Set([ymd(new Date())]);
    if (!state.calendarMonth) state.calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const month = state.calendarMonth;
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const today = ymd(new Date());
    const cells = Array.from({ length: first.getDay() }, () => '<span></span>');
    for (let day = 1; day <= daysInMonth; day += 1) {
        const date = ymd(new Date(month.getFullYear(), month.getMonth(), day));
        const weekend = [0, 6].includes(new Date(month.getFullYear(), month.getMonth(), day).getDay());
        cells.push(`<button type="button" data-date="${date}" class="day${state.dates.has(date) ? ' on' : ''}${date === today ? ' today' : ''}${weekend ? ' weekend' : ''}">${day}</button>`);
    }
    $('#calendar').innerHTML = `
        <div class="cal-head">
            <button type="button" class="ghost small" data-move="-1" aria-label="Previous month">‹</button>
            <b>${month.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</b>
            <button type="button" class="ghost small" data-move="1" aria-label="Next month">›</button>
        </div>
        <div class="cal-grid">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<span class="dow">${d}</span>`).join('')}${cells.join('')}</div>
        <div class="cal-foot">
            <button type="button" class="ghost small" data-quick="today">Today</button>
            <button type="button" class="ghost small" data-quick="weekdays">Weekdays this month</button>
            <button type="button" class="ghost small" data-quick="clear">Clear</button>
            <button type="button" class="primary small" data-quick="done">Done</button>
        </div>`;
    showPickedDates();
}

/** The field shows the picked days the way SIS shows dates (MM/DD/YYYY). */
function showPickedDates() {
    const us = (d) => { const [y, m, day] = d.split('-'); return `${m}/${day}/${y}`; };
    const picked = [...state.dates].sort();
    $('#dosField').value = picked.length <= 3
        ? picked.map(us).join(', ')
        : `${picked.length} days: ${us(picked[0])} … ${us(picked[picked.length - 1])}`;
    $('#dosField').title = picked.map(us).join(', ');
}

function toggleCalendar(open) {
    const popover = $('#calendar');
    popover.hidden = !open;
    $('#calendarBtn').setAttribute('aria-expanded', String(open));
    if (open) renderCalendar();
}

$('#calendarBtn').addEventListener('click', () => toggleCalendar($('#calendar').hidden));
$('#dosField').addEventListener('click', () => toggleCalendar(true));
document.addEventListener('click', (e) => {
    // composedPath, not closest(): a day click re-renders the calendar, so its target is no longer in the page.
    const inside = e.composedPath().some((el) => el.classList?.contains('date-input'));
    if (!$('#calendar').hidden && !inside) toggleCalendar(false);
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#calendar').hidden) toggleCalendar(false);
});

$('#calendar').addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target) return;
    const month = state.calendarMonth;
    if (target.dataset.date) {
        state.dates.has(target.dataset.date) ? state.dates.delete(target.dataset.date) : state.dates.add(target.dataset.date);
    } else if (target.dataset.move) {
        state.calendarMonth = new Date(month.getFullYear(), month.getMonth() + Number(target.dataset.move), 1);
    } else if (target.dataset.quick === 'today') {
        state.dates = new Set([ymd(new Date())]);
        state.calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    } else if (target.dataset.quick === 'weekdays') {
        const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        for (let day = 1; day <= days; day += 1) {
            const d = new Date(month.getFullYear(), month.getMonth(), day);
            if (d.getDay() !== 0 && d.getDay() !== 6) state.dates.add(ymd(d));
        }
    } else if (target.dataset.quick === 'clear') {
        state.dates.clear();
    } else if (target.dataset.quick === 'done') {
        return toggleCalendar(false);
    }
    renderCalendar();
});

// #endregion

/** One row per tracker: what it shows, the steps its cases go through, its billing, and how many cases. */
function renderTrackers() {
    const billing = { insured: ['Insurance', 'warn'], selfPay: ['Self pay', 'warn'], either: ['Billing setting below', 'idle'] };
    $('#trackerRows').innerHTML = state.lookups.trackers.map((t) => {
        const last = STAGE_ORDER.indexOf(t.stage);
        const steps = FLOW.map(([name], i) => `<span class="flow-step ${i <= last ? 'on' : ''}">${esc(name)}</span>`).join('<span class="flow-arrow">→</span>');
        const [billText, billClass] = billing[t.billing];
        const needsSetup = t.stage === 'remitted' && state.lookups.eraMissing?.length;
        const setupNote = needsSetup ? `<span class="err">Needs the ERA app values: clone the SIS automation repo next to the seeder, or run <code>npm run setup</code>; then restart it.</span>` : '';
        return `
            <label class="tracker-row" data-tracker="${t.id}">
                <div class="tracker-name"><b>${esc(t.label)}</b><span>${esc(t.shows)}</span>${setupNote}</div>
                <div class="tracker-flow">${steps}<span class="badge ${billClass}">${esc(billText)}</span></div>
                <input type="number" min="0" max="${needsSetup ? 0 : 2000}" name="tracker_${t.id}" value="0" aria-label="${t.stage === 'remitted' ? 'Tracker records' : 'Cases'} for ${esc(t.label)}"${needsSetup ? ' disabled title="Run npm run setup first"' : ''}>
            </label>`;
    }).join('');
    $$('#trackerRows input').forEach((i) => i.addEventListener('input', updateTotal));
    updateTotal();
}

function updateTotal() {
    const counts = Object.fromEntries($$('#trackerRows input').map((i) => [i.name.replace('tracker_', ''), Number(i.value) || 0]));
    // Remittance Posting counts tracker records; each one holds Patients per ERA patients (cases).
    const total = Object.entries(counts).reduce((a, [id, n]) => a + (id === 'remittancePosting' ? n * patientsPerEra() : n), 0);
    $$('#trackerRows .tracker-row').forEach((row) => row.classList.toggle('active', counts[row.dataset.tracker] > 0));
    const charged = state.lookups.trackers.some((t) => STAGE_ORDER.indexOf(t.stage) >= STAGE_ORDER.indexOf('charged') && counts[t.id] > 0);
    $('#casesForm').periodMode.disabled = !charged;
    $('#periodHint').textContent = charged ? 'Charges of this run are posted into this period/batch.' : 'Only needed for Insurance Billing, Patient Statements or Remittance Posting cases.';
    $('#casesTotal').textContent = total ? `${total} case(s) in total` : '';
    updateEraHint(counts.remittancePosting || 0);
}

/** "2 Remittance Posting records × 4 patients = 8 patients" under Patients per ERA. */
function updateEraHint(records) {
    const perEra = patientsPerEra();
    $('#eraGroupHint').textContent = records
        ? `${records} Remittance Posting record(s) × ${perEra} patient(s) each = ${records * perEra} patient(s), one check number per record.`
        : 'The Remittance Posting count above is the number of tracker records; each record (one ERA, one check number) gets this many patients.';
}

/** The Patients per ERA box as a whole number from 1 to 10 (blank or out of range is clamped). */
function patientsPerEra() {
    const n = Math.floor(Number($('#casesForm').patientsPerEra.value));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : 1;
}

$('#casesForm').patientsPerEra.addEventListener('input', () => state.lookups && updateTotal());
$('#casesForm').patientsPerEra.addEventListener('change', (e) => {
    e.target.value = patientsPerEra();
    if (state.lookups) updateTotal();
});

function fillSelect(select, items = []) {
    const keep = select.querySelector('option[value=""]')?.outerHTML ?? '';
    select.innerHTML = keep + items.map((item) => typeof item === 'string'
        ? `<option>${esc(item)}</option>`
        : `<option value="${item.id}">${esc(item.name)}</option>`).join('');
}

/**
 * A searchable single-select dropdown: the list opens when the box is clicked or focused, typing narrows it to
 * matching names (the match highlighted), and picking one closes it and shows that name. × clears it back to
 * "any, at random". Arrow keys move, Enter picks, Escape closes (and puts the picked name back).
 */
function renderPicker(el) {
    const key = el.dataset.list;
    const items = state.lookups[key] || [];
    const selected = state.pickers[key] ?? new Set();
    state.pickers[key] = selected;
    const noun = (el.dataset.label || 'items').toLowerCase();
    el.innerHTML = `
        <div class="picker-head"><span>${esc(el.dataset.label)}</span><span class="chip"></span></div>
        <div class="combo">
            <div class="combo-field">
                <input type="text" autocomplete="off" role="combobox" aria-expanded="false">
                <button type="button" class="combo-clear" aria-label="Clear" title="Back to any" hidden>×</button>
                <span class="combo-caret" aria-hidden="true">▾</span>
            </div>
            <ul class="combo-list" role="listbox" hidden></ul>
        </div>`;
    const combo = $('.combo', el);
    const input = $('input', el);
    const list = $('.combo-list', el);
    const clear = $('.combo-clear', el);
    const count = $('.picker-head .chip', el);
    let active = -1;
    let shown = [];

    const current = () => items.find((i) => selected.has(i.id));
    const mark = (name, f) => {
        const at = f ? name.toLowerCase().indexOf(f) : -1;
        return at < 0 ? esc(name) : `${esc(name.slice(0, at))}<b>${esc(name.slice(at, at + f.length))}</b>${esc(name.slice(at + f.length))}`;
    };
    /** The box shows the picked name (or the hint), the head says "any" or "1 selected". */
    const drawValue = () => {
        const picked = current();
        input.value = picked ? picked.name : '';
        input.placeholder = `Click or type to search ${items.length} ${noun}…`;
        clear.hidden = !picked;
        count.textContent = picked ? '1 selected' : 'any';
        count.classList.toggle('on', !!picked);
    };
    const drawList = (filter) => {
        const f = filter.trim().toLowerCase();
        shown = items.filter((i) => !f || i.name.toLowerCase().includes(f)).slice(0, 300);
        active = Math.min(Math.max(active, 0), shown.length - 1);
        list.innerHTML = shown.map((i, n) => `<li role="option" data-id="${i.id}" aria-selected="${selected.has(i.id)}" class="${n === active ? 'active' : ''}">
                <span class="tick">${selected.has(i.id) ? '✓' : ''}</span><span>${mark(i.name, f)}</span></li>`).join('')
            || `<li class="muted empty">No ${esc(noun)} match "${esc(filter.trim())}".</li>`;
    };
    const open = () => {
        if (!list.hidden) return;
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        // Opening shows the whole list with the current pick highlighted; the box text is selected for typing over.
        active = Math.max(0, items.findIndex((i) => selected.has(i.id)));
        drawList('');
        input.select();
        $('.combo-list li.active', el)?.scrollIntoView({ block: 'nearest' });
    };
    const close = () => {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        active = -1;
        drawValue();
    };
    const choose = (id) => {
        selected.clear();
        selected.add(id);
        close();
        input.blur();
    };

    input.addEventListener('focus', open);
    input.addEventListener('click', open);
    input.addEventListener('input', () => {
        active = 0;
        if (list.hidden) {
            list.hidden = false;
            input.setAttribute('aria-expanded', 'true');
        }
        drawList(input.value);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            open();
            active = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
            drawList(input.value === current()?.name ? '' : input.value);
            $('.combo-list li.active', el)?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (!list.hidden && shown[active]) choose(shown[active].id);
        } else if (e.key === 'Escape') {
            close();
            input.blur();
        }
    });
    // mousedown, not click: picking must not blur the input and close the list first.
    list.addEventListener('mousedown', (e) => {
        const li = e.target.closest('li[data-id]');
        if (!li) return;
        e.preventDefault();
        choose(Number(li.dataset.id));
    });
    clear.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selected.clear();
        close();
    });
    $('.combo-caret', el).addEventListener('mousedown', (e) => {
        e.preventDefault();
        list.hidden ? input.focus() : close();
    });
    document.addEventListener('mousedown', (e) => {
        if (!combo.contains(e.target) && !list.hidden) close();
    });
    drawValue();
}

function renderPeriods() {
    const form = $('#casesForm');
    fillSelect(form.periodId, state.lookups.periods);
    const syncBatches = () => {
        const period = state.lookups.periods.find((p) => p.id === Number(form.periodId.value));
        fillSelect(form.batchId, period?.batches ?? []);
    };
    form.periodId.onchange = syncBatches;
    syncBatches();
    form.periodMode.onchange = () => { $('#existingPeriod').hidden = form.periodMode.value !== 'existing'; };
}

// #endregion

// #region Cases

function caseRequest() {
    const form = $('#casesForm');
    const trackers = Object.fromEntries(state.lookups.trackers.map((t) => [t.id, Number(form[`tracker_${t.id}`].value) || 0]));
    const ids = (key) => [...(state.pickers[key] ?? [])];
    const amount = Number(form.chargeAmount.value);
    const cptCodes = state.lookups.feeSchedule.map((f) => f.cptCode);
    return {
        trackers,
        suffix: form.suffix.value,
        dates: [...state.dates].sort(),
        physicianIds: ids('physicians'),
        proceduresPerCase: Number(form.proceduresPerCase.value) || 1,
        amounts: amount > 0 ? Object.fromEntries(cptCodes.map((c) => [c, amount])) : {},
        insuranceCount: Number(form.insuranceCount.value),
        eraOutcome: form.eraOutcome.value,
        patientsPerEra: patientsPerEra(),
        periodBatch: form.periodMode.value === 'existing' ? { mode: 'existing', periodId: Number(form.periodId.value), batchId: Number(form.batchId.value) } : { mode: 'create' },
        diagnosisCode: form.diagnosisCode.value,
        concurrency: Number(form.concurrency.value) || 4,
    };
}

function renderChecks(checks) {
    const box = $('#checks');
    box.hidden = false;
    box.innerHTML = checks.map((c) => `<div class="check ${c.ok ? '' : 'bad'}"><span class="badge ${c.ok ? 'ok' : 'bad'}">${c.ok ? 'OK' : 'Fix'}</span><b>${esc(c.name)}</b><span class="muted">${esc(c.detail)}</span></div>`).join('');
    return checks.every((c) => c.ok);
}

$('#checkBtn').addEventListener('click', async () => {
    try {
        const { checks } = await api('cases/check', { body: caseRequest() });
        if (renderChecks(checks)) toast('Setup looks good.');
    } catch (err) {
        toast(err.message, true);
    }
});

$('#casesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.dates.size) return toast('Pick at least one date of service on the calendar.', true);
    const request = caseRequest();
    // One run at a time: the button stays disabled from the click until the run has finished.
    if ($('#runCasesBtn').disabled) return;
    setCasesBusy(true, 'Starting…');
    try {
        const { checks } = await api('cases/check', { body: request });
        if (!renderChecks(checks)) {
            setCasesBusy(false);
            return toast('Fix the items marked "Fix" first.', true);
        }
        const { id } = await api('cases/run', { body: request });
        holdWhileRunning(id);
        watchRun(id);
    } catch (err) {
        setCasesBusy(false);
        toast(err.message, true);
    }
});

/** Create cases is disabled (and says why) while a case run of this sign-in is going. */
function setCasesBusy(busy, text = 'Cases running…') {
    const button = $('#runCasesBtn');
    button.disabled = busy;
    button.textContent = busy ? text : 'Create cases';
}

/**
 * Keeps Create cases disabled until the run `id` has finished, whichever run or tab is on screen meanwhile: it checks
 * the run on its own every 2 s, independent of the run monitor.
 */
function holdWhileRunning(id) {
    clearTimeout(state.busyTimer);
    setCasesBusy(true);
    const check = async () => {
        try {
            const run = await api(`runs/${encodeURIComponent(id)}`);
            if (run.status === 'running') {
                state.busyTimer = setTimeout(check, 2000);
                return;
            }
        } catch {
            // signed out or the server restarted: nothing is running for this page any more
        }
        setCasesBusy(false);
    };
    state.busyTimer = setTimeout(check, 2000);
}

/** After sign-in or a page reload: a case run of this sign-in that is still going keeps the button disabled. */
async function holdIfCaseRunGoing() {
    try {
        const list = await api('runs');
        const going = list.find((r) => r.kind === 'cases' && r.status === 'running');
        if (going) holdWhileRunning(going.id);
    } catch {
        // history is optional here
    }
}

// #endregion

// #region Period & batch

$('#periodBatchesForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
        const { id } = await api('periodBatches/run', { body: { count: Number(f.count), suffix: f.suffix, periodBatch: { month: f.month } } });
        watchRun(id);
    } catch (err) {
        toast(err.message, true);
    }
});

// #endregion

// #region Run monitor

function stopPolling() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
}

function watchRun(id) {
    stopPolling();
    state.runId = id;
    $('#runView').hidden = false;
    $('#runView').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const tick = async () => {
        try {
            const run = await api(`runs/${encodeURIComponent(id)}`);
            if (state.runId !== id) return;
            renderRun(run);
            if (run.status === 'running') state.pollTimer = setTimeout(tick, 1200);
            else toast(run.status === 'done' && !run.summary.failed ? 'Run finished.' : `Run ${run.status}: ${run.summary.failed} failed.`, run.summary.failed > 0 || run.status === 'failed');
        } catch (err) {
            toast(err.message, true);
        }
    };
    tick();
}

function renderRun(run) {
    state.lastRun = run;
    const s = run.summary;
    const running = run.status === 'running';
    $('#runTitle').innerHTML = `${esc(run.title)} <span class="badge ${running ? 'run' : run.status === 'done' && !s.failed ? 'ok' : 'bad'}">${esc(running ? 'running' : run.status)}</span>`;
    const took = run.finishedAt ? `${Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000)}s` : 'in progress';
    $('#runMeta').textContent = `Tag ${run.tag} · facility ${run.environment.organizationId} · started ${new Date(run.startedAt).toLocaleString()} · ${took}`;
    $('#progressBar').style.width = `${s.total ? Math.round((s.done / s.total) * 100) : 0}%`;
    $('#stopBtn').hidden = !running;
    $('#retryBtn').hidden = running || !s.failed || run.kind !== 'cases';
    // Only when the whole run failed (e.g. in setup, before any case): the same request again under a fresh tag.
    $('#rerunBtn').hidden = running || run.kind !== 'cases' || run.status !== 'failed' || !run.request;
    $('#restoreRcmBtn').hidden = running || run.kind !== 'cases' || !(run.rcmChanges ?? []).length;
    const csv = $('#csvLink');
    csv.hidden = run.kind !== 'cases';
    csv.href = `/api/runs/${encodeURIComponent(run.id)}/cases.csv`;

    const stat = (value, label) => `<div class="stat"><b>${value}</b><span>${esc(label)}</span></div>`;
    let stats = stat(`${s.ok}/${s.total}`, 'completed as asked') + stat(s.failed, 'failed');
    if (s.byTracker) stats += Object.values(s.byTracker).filter((v) => v.wanted).map((v) => stat(`${v.inTracker ?? v.reached}/${v.wanted}`, `in ${v.label}${v.inTracker !== undefined && v.inTracker < v.reached ? ` · ${v.reached - v.inTracker} ERA(s) still arriving` : ''}${v.failed ? ` · ${v.failed} failed` : ''}`)).join('');
    $('#runStats').innerHTML = stats;
    $('#runNotes').innerHTML = (run.phase ? `<p><b>${esc(run.phase)}</b></p>` : '') + (run.setup?.notes ?? []).map((n) => `<p>${esc(n)}</p>`).join('') + (run.error ? `<p class="error">${esc(run.error)}</p>` : '');

    $('#caseFilter').hidden = run.kind !== 'cases';
    run.kind === 'cases' ? renderCases(run) : renderItems(run);
    $('#logCount').textContent = `(${run.log.length} latest calls)`;
    $('#logTable').innerHTML = '<thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>ms</th><th>Error</th></tr></thead><tbody>'
        + run.log.slice().reverse().map((l) => `<tr><td>${esc(new Date(l.time).toLocaleTimeString())}</td><td>${esc(l.method)}</td><td>${esc(l.path)}</td><td><span class="badge ${l.status === 'ERR' || l.status >= 400 ? 'bad' : 'ok'}">${esc(l.status)}</span></td><td>${l.ms}</td><td class="err">${esc(l.error)}</td></tr>`).join('') + '</tbody>';
}

function renderCases(run) {
    const onlyFailed = $('#onlyFailed').checked;
    const q = $('#caseSearch').value.trim().toLowerCase();
    const rows = run.cases.filter((c) => (!onlyFailed || c.error)
        && (!q || [c.firstName, c.lastName, c.patientId, c.caseSummaryId, c.cptCodes.join(' '), c.checkNumber, trackerOf(c.tracker)?.label].join(' ').toLowerCase().includes(q)));
    const status = (c) => {
        if (c.error) return '<span class="badge bad">failed</span>';
        if (c.cancelled) return '<span class="badge idle">Cancelled</span>';
        if (c.reached === c.target && c.target === 'remitted' && c.inTracker !== undefined) {
            return c.inTracker ? '<span class="badge ok">In tracker</span>' : '<span class="badge warn">ERA posted · not in tracker yet</span>';
        }
        if (c.reached === c.target) return `<span class="badge ok">${esc(STAGE_NAMES[c.target])}</span>`;
        return c.steps.length || c.reached ? '<span class="badge run">working</span>' : '<span class="badge idle">queued</span>';
    };
    $('#runTable').innerHTML = `<thead><tr><th>#</th><th>Tracker</th><th>Patient</th><th>Patient ID</th><th>Case ID</th><th>DOS</th><th>Billing</th><th>Steps</th><th>Status</th></tr></thead><tbody>`
        + rows.slice(0, 1000).map((c) => `<tr class="${c.error ? 'failed' : ''}">
            <td>${c.index}</td>
            <td><b>${esc(trackerOf(c.tracker)?.label ?? c.tracker)}</b></td>
            <td>${esc(c.lastName)}, ${esc(c.firstName)}<br><span class="muted">${esc(c.dateOfBirth)}${c.cptCodes.length ? ` · ${esc(c.cptCodes.join(', '))}` : ''}${c.checkNumber ? ` · check ${esc(c.checkNumber)}` : ''}${c.eraOutcome ? ` · ${esc(eraOutcomeName(c.eraOutcome))}` : ''}</span></td>
            <td>${esc(c.patientId)}</td><td>${esc(c.caseSummaryId)}</td><td class="nowrap">${esc(c.dateOfService)}</td><td>${c.selfPay ? 'Self pay' : esc(c.patientInsurances.length ? `${c.patientInsurances.length} insurance(s)` : 'Insurance')}</td>
            <td><div class="steps">${c.steps.map((s) => `<span class="dot ${s.ok ? 'ok' : 'bad'}" title="${esc(`${s.name} — ${s.ok ? `${s.ms} ms` : s.error}`)}"></span>`).join('')}</div></td>
            <td>${status(c)}${c.error ? `<div class="err">${esc(c.error)}</div>` : ''}</td>
        </tr>`).join('') + '</tbody>';
}

function renderItems(run) {
    const done = { cleanup: 'cancelled', features: 'set', rcmRestore: 'restored', interfaces: 'sent' }[run.kind] ?? 'created';
    $('#runTable').innerHTML = '<thead><tr><th>#</th><th>Name</th><th>ID</th><th>Result</th></tr></thead><tbody>'
        + run.items.map((item, i) => `<tr class="${item.ok ? '' : 'failed'}"><td>${i + 1}</td><td>${esc(item.name)}</td><td>${esc(item.id)}</td><td>${item.ok ? `<span class="badge ok">${done}</span>` : `<span class="badge bad">failed</span><div class="err">${esc(item.error)}</div>`}</td></tr>`).join('') + '</tbody>';
}

$('#onlyFailed').addEventListener('change', () => state.lastRun && renderCases(state.lastRun));
$('#caseSearch').addEventListener('input', () => state.lastRun && renderCases(state.lastRun));
$('#stopBtn').addEventListener('click', () => api(`runs/${encodeURIComponent(state.runId)}/stop`, { body: {} }).then(() => toast('Stopping after the cases in progress…')));
$('#rerunBtn').addEventListener('click', async () => {
    try {
        const { id } = await api(`runs/${encodeURIComponent(state.runId)}/rerun`, { body: {} });
        holdWhileRunning(id);
        watchRun(id);
    } catch (err) {
        toast(err.message, true);
    }
});

$('#restoreRcmBtn').addEventListener('click', async () => {
    try {
        const { id } = await api(`runs/${encodeURIComponent(state.runId)}/restore-rcm`, { body: {} });
        watchRun(id);
    } catch (err) {
        toast(err.message, true);
    }
});

$('#retryBtn').addEventListener('click', async () => {
    try {
        const { retried } = await api(`runs/${encodeURIComponent(state.runId)}/retry`, { body: {} });
        toast(`Retrying ${retried} case(s) from the step they stopped at.`);
        if (retried) holdWhileRunning(state.runId);
        watchRun(state.runId);
    } catch (err) {
        toast(err.message, true);
    }
});

// #endregion

// #region Interfaces

const iface = { cases: [], picked: new Set() };
const caseKey = (c) => `${c.runId}|${c.caseSummaryId}`;

$('#loadSeededCases').addEventListener('click', async () => {
    try {
        const { cases, categories, adtSource } = await api('interfaces/cases');
        iface.cases = cases;
        iface.picked.clear();
        $('#claimCategory').innerHTML = Object.entries(categories).map(([code, text]) => `<option value="${code}" ${code === 'P1' ? 'selected' : ''}>${code}: ${esc(text)}</option>`).join('');
        if (!$('#adtSource').value) $('#adtSource').value = adtSource;
        for (const id of ['seededSearch', 'insuredOnlyLabel', 'seededBox', 'claimStatusOptions', 'claimStatusActions']) $(`#${id}`).hidden = false;
        $('#seededInfo').textContent = `${cases.length} seeded case(s) on this facility`;
        renderSeeded();
    } catch (err) {
        toast(err.message, true);
    }
});

$('#seededSearch').addEventListener('input', () => renderSeeded());
$('#insuredOnly').addEventListener('change', () => renderSeeded());

function renderSeeded() {
    const q = $('#seededSearch').value.trim().toLowerCase();
    const insuredOnly = $('#insuredOnly').checked;
    const charged = new Set(['charged', 'remitted']);
    const rows = iface.cases.filter((c) => (!insuredOnly || (c.insurances.length && charged.has(c.reached)))
        && (!q || [c.firstName, c.lastName, c.caseSummaryId, c.tracker, c.runTag, trackerOf(c.tracker)?.label].join(' ').toLowerCase().includes(q)));
    $('#seededTable').innerHTML = '<thead><tr><th></th><th>Patient</th><th>Case ID</th><th>DOS</th><th>Tracker</th><th>Insurance</th><th>Run</th></tr></thead><tbody>'
        + rows.slice(0, 500).map((c) => `<tr><td><input type="checkbox" data-case="${esc(caseKey(c))}" ${iface.picked.has(caseKey(c)) ? 'checked' : ''}></td>
            <td>${esc(c.lastName)}, ${esc(c.firstName)}<br><span class="muted">${esc(c.dateOfBirth)} · ${esc(c.cptCodes.join(', '))}</span></td>
            <td>${esc(c.caseSummaryId)}</td><td class="nowrap">${esc(c.dateOfService)}</td><td>${esc(trackerOf(c.tracker)?.label ?? c.tracker)}</td>
            <td>${esc(c.insurances[0] ?? 'Self pay')}</td><td class="muted">${esc(c.runTag)}</td></tr>`).join('')
        + (rows.length ? '' : '<tr><td colspan="7" class="muted">No seeded cases match. Seed Insurance Billing or Remittance Posting cases first, or untick "insured, charged cases only".</td></tr>')
        + '</tbody>';
    $('#seededPicked').textContent = `${iface.picked.size} case(s) picked`;
}

$('#seededTable').addEventListener('change', (e) => {
    const key = e.target.dataset?.case;
    if (!key) return;
    if (e.target.checked) iface.picked.add(key);
    else iface.picked.delete(key);
    $('#seededPicked').textContent = `${iface.picked.size} case(s) picked`;
});

$('#sendClaimStatus').addEventListener('click', async () => {
    if (!iface.picked.size) return toast('Pick at least one case.', true);
    const cases = [...iface.picked].map((k) => { const [runId, id] = k.split('|'); return { runId, caseSummaryId: Number(id) }; });
    try {
        const { id } = await api('interfaces/claim-status/run', { body: { cases, category: $('#claimCategory').value, remark: $('#claimRemark').value, icn: $('#claimIcn').value } });
        watchRun(id);
    } catch (err) {
        toast(err.message, true);
    }
});

$('#sendAdt').addEventListener('click', async () => {
    try {
        const { id } = await api('interfaces/adt/run', { body: { count: Number($('#adtCount').value) || 1, suffix: $('#adtTag').value, sourceIdentifier: $('#adtSource').value, withInsurance: $('#adtInsurance').checked } });
        watchRun(id);
    } catch (err) {
        toast(err.message, true);
    }
});

// #endregion

// #region Tabs and history

$$('.tabs button').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tabs button').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.tabpanel').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    if (tab.dataset.tab === 'history') loadHistory();
}));

async function loadHistory() {
    const list = await api('runs');
    $('#historyTable tbody').innerHTML = list.map((r) => `<tr>
        <td>${esc(new Date(r.startedAt).toLocaleString())}</td><td>${esc(r.title)}</td>
        <td>${esc(r.environment.username)} · ${esc(r.environment.organizationId)} · ${esc((() => { try { return new URL(r.environment.apiUrl).host; } catch { return r.environment.apiUrl; } })())}</td>
        <td><span class="badge ${r.status === 'done' ? 'ok' : r.status === 'running' ? 'run' : 'bad'}">${esc(r.status)}</span></td>
        <td><button class="ghost small" data-run="${esc(r.id)}">Open</button></td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">No runs yet.</td></tr>';
}

$('#historyTable').addEventListener('click', (e) => {
    const id = e.target.dataset?.run;
    if (id) watchRun(id);
});
$('#refreshHistory').addEventListener('click', loadHistory);

// #endregion

api('session').then(showApp).catch(showLogin);
