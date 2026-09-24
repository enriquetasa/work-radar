'use strict';
/* ============================================================
   WORK RADAR — renderer
   Persistence: Electron file IO via window.radarAPI when present,
   otherwise falls back to localStorage (so this still runs in a
   plain browser). All disk access in Electron is in the main process.
   ============================================================ */

// Pure domain logic lives in domain.js (loaded as window.WorkRadarDomain),
// so it can be unit-tested under node:test without a DOM.
const D = window.WorkRadarDomain;
const AV = window.WorkRadarAuthView;
const SV = window.WorkRadarSyncView;
const { PC, SC, uid, fdt, stripTombstones } = D;
const HAS_API = typeof window !== 'undefined' && !!window.radarAPI;

/* ---------- Persistence adapter ---------- */
const Persist = {
  async load() {
    if (HAS_API) return await window.radarAPI.load();
    try {
      return JSON.parse(localStorage.getItem('workradar') || 'null');
    } catch (e) {
      console.error('localStorage read failed', e);
      return null;
    }
  },
  async save(obj) {
    if (HAS_API) {
      const res = await window.radarAPI.save(obj);
      if (!res || !res.ok) {
        console.error('radar save failed', res && res.error);
        alert('SAVE FAILED — export a backup now.');
      }
      return;
    }
    try {
      localStorage.setItem('workradar', JSON.stringify(obj));
    } catch (e) {
      console.error('localStorage write failed', e);
      alert('STORAGE WRITE FAILED — export a backup now.');
    }
  },
};

/* ---------- Store ---------- */
const Store = {
  items: [],
  arch: [],
  lastExport: 0,
  ui: {
    view: 'today',
    filter: 'all',
    sort: 'priority',
    search: '',
    sel: null,
    showForm: false,
    editId: null,
  },

  async load() {
    const d = await Persist.load();
    if (!d) {
      // First run in browser mode: attempt legacy v1 keys.
      if (!HAS_API) {
        try {
          this.items = D.migrate(JSON.parse(localStorage.getItem('wr-items') || '[]'));
        } catch (e) {
          console.error('legacy wr-items migration failed', e);
        }
        try {
          this.arch = D.migrate(JSON.parse(localStorage.getItem('wr-arch') || '[]'));
        } catch (e) {
          console.error('legacy wr-arch migration failed', e);
        }
      }
      return;
    }
    // Merge against an empty state so any id that ended up in both items
    // and arch (possible under the old mergeById import, which this
    // replaces) collapses to one record instead of showing up twice.
    const deduped = D.mergeState(
      {
        items: D.migrate(Array.isArray(d.items) ? d.items : []),
        arch: D.migrate(Array.isArray(d.arch) ? d.arch : []),
      },
      { items: [], arch: [] }
    );
    this.items = deduped.items;
    this.arch = deduped.arch;
    this.lastExport = d.lastExport || 0;
  },
  serialize() {
    return D.serialize(this);
  },
};

/* ---------- Debounced save ---------- */
let saveTimer = null;
// Set when Store.load() fails at boot (see boot() below). Store.items/arch
// then stay at their empty initial value, so saving would overwrite the
// user's real data file with nothing; refuse until the app is restarted.
let loadFailed = false;
function scheduleSave() {
  if (loadFailed) {
    console.error('save skipped: Store.load() failed at boot, refusing to overwrite data file');
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => Persist.save(Store.serialize()), 120);
}
function commit() {
  scheduleSave();
  render();
}

/* ---------- Actions ---------- */
const Actions = {
  // Keep timestamp rules in the tested domain layer.
  add(v) {
    Store.items.push(D.createItem(v, Date.now(), uid));
    commit();
  },
  update(id, v) {
    Store.items = Store.items.map((i) => (i.id === id ? D.updateItem(i, v, Date.now()) : i));
    commit();
  },
  // Every mutation below goes through a pure domain.js function so the
  // updatedAt bump (and, for purge, the tombstone) is unit-tested rather
  // than only reachable through the DOM — see the "Item mutations" section
  // of domain.js.
  review(id, nextDate) {
    const now = Date.now();
    Store.items = Store.items.map((i) => (i.id === id ? D.reviewItem(i, now, nextDate) : i));
    commit();
  },
  snooze(id, date) {
    Store.items = Store.items.map((i) => (i.id === id ? D.snoozeItem(i, date, Date.now()) : i));
    commit();
  },
  archive(id) {
    const it = Store.items.find((i) => i.id === id);
    if (!it) return;
    const now = Date.now();
    Store.arch.unshift(D.archiveItem(it, now));
    Store.items = Store.items.filter((i) => i.id !== id);
    if (Store.ui.sel === id) Store.ui.sel = null;
    commit();
  },
  restore(id) {
    const it = Store.arch.find((i) => i.id === id);
    if (!it) return;
    const now = Date.now();
    Store.items.push(D.restoreItem(it, now));
    Store.arch = Store.arch.filter((i) => i.id !== id);
    commit();
  },
  // PURGE never removes the record — it marks it a tombstone (deletedAt).
  // Tombstones stay in the data file (so a later merge still sees the
  // deletion — see domain.js mergeState) but are hidden everywhere in the
  // UI via D.stripTombstones / D.selectVisible.
  purge(id) {
    const now = Date.now();
    Store.arch = Store.arch.map((i) => (i.id === id ? D.purgeItem(i, now) : i));
    if (Store.ui.sel === id) Store.ui.sel = null;
    commit();
  },
  addLogEntry(id, text) {
    const now = Date.now();
    Store.items = Store.items.map((i) => (i.id === id ? D.addLogEntry(i, text, now, uid) : i));
    commit();
  },

  async exportJSON() {
    const data = Store.serialize();
    if (HAS_API) {
      const res = await window.radarAPI.export(data);
      if (res && res.ok) {
        Store.lastExport = Date.now();
        commit();
      }
    } else {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'work-radar-backup-' + fdt(Date.now()) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      Store.lastExport = Date.now();
      commit();
    }
  },

  async exportPDF() {
    const html = D.buildReportHTML(Store.items);
    if (HAS_API) {
      const res = await window.radarAPI.exportPDF(html);
      if (!res || !res.ok) {
        console.error('PDF export failed', res && res.error);
        if (res && res.error) alert('PDF EXPORT FAILED — ' + res.error);
      }
    } else {
      // Browser fallback: open in a new tab and let the user print to PDF.
      const w = window.open();
      w.document.write(html);
      w.document.close();
    }
  },

  mergeImported(d) {
    const inItems = D.migrate(Array.isArray(d.items) ? d.items : []);
    const inArch = D.migrate(Array.isArray(d.arch) ? d.arch : []);
    if (!inItems.length && !inArch.length) {
      alert('NO CONTACTS FOUND IN FILE.');
      return;
    }
    // Count live/archived contacts, not tombstones — a file holding only
    // purged records should say "0 archived", not count them as archived
    // contacts (see D.stripTombstones).
    const liveCount = D.stripTombstones(inItems).length;
    const archCount = D.stripTombstones(inArch).length;
    const deletions = inItems.length - liveCount + (inArch.length - archCount);
    if (
      !confirm(
        'MERGE ' +
          liveCount +
          ' live + ' +
          archCount +
          ' archived contacts' +
          (deletions
            ? ' (plus ' + deletions + ' deletion' + (deletions !== 1 ? 's' : '') + ')'
            : '') +
          '?\nFor matching IDs, the most recently edited version wins.'
      )
    )
      return;
    const merged = D.mergeState(
      { items: Store.items, arch: Store.arch },
      { items: inItems, arch: inArch }
    );
    Store.items = merged.items;
    Store.arch = merged.arch;
    Store.ui.sel = null;
    commit();
  },

  async importJSON() {
    if (HAS_API) {
      const d = await window.radarAPI.import();
      if (!d) return;
      try {
        this.mergeImported(d);
      } catch (err) {
        console.error('import merge failed', err);
        alert('IMPORT FAILED — the file merged with unexpected data. See console for details.');
      }
    } else {
      document.getElementById('import-file').click();
    }
  },
};

/* ---------- Auth (sync sign-in — see docs/supabase-sync-plan.md) ----------
   Entirely optional: authStatus() reports { configured: false } when the
   main process has no Supabase URL/key configured, and this stays fully
   inert in that case — no UI is ever unhidden. Flow: email input →
   "CHECK YOUR INBOX" (optimistic, set the instant the form is submitted)
   → signed-in state, driven by the 'auth:stateChanged' push from main
   once exchangeCodeForSession actually completes. Sign Out lives in the
   Radar menu, not here (main.js only adds that menu item when sync is
   configured). */
const Auth = {
  // init() can run again after an in-process key save; bind listeners once.
  _listenersBound: false,
  async init() {
    if (!HAS_API || !window.radarAPI.authStatus) return;
    let status;
    try {
      status = await window.radarAPI.authStatus();
    } catch (err) {
      console.error('authStatus failed', err);
      return;
    }
    if (!status || !status.configured) return; // sync not configured — leave the panel hidden
    document.getElementById('auth-panel').hidden = false;
    this.render(status);
    if (this._listenersBound) return;
    this._listenersBound = true;
    if (window.radarAPI.onAuthStateChanged) {
      window.radarAPI.onAuthStateChanged((s) => this.render(s));
    }
    document.getElementById('auth-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
  },
  render(status) {
    // The view/clear-error decision is pure — see renderer/auth-view.js
    // for why only the signedIn and pending branches clear #auth-error.
    const view = AV.computeAuthView(status);
    if (view.clearError) document.getElementById('auth-error').hidden = true;
    document.getElementById('auth-form').hidden = !view.form;
    document.getElementById('auth-pending').hidden = !view.pending;
    document.getElementById('auth-signed-in').hidden = !view.signedIn;
    if (view.signedIn) {
      document.getElementById('auth-email-label').textContent = 'Cloud connected';
      document.getElementById('auth-signed-in').title = status.email || '';
    }
  },
  showError(message) {
    document.getElementById('auth-pending').hidden = true;
    document.getElementById('auth-signed-in').hidden = true;
    document.getElementById('auth-form').hidden = false;
    const err = document.getElementById('auth-error');
    err.textContent = message;
    err.hidden = false;
  },
  async submit() {
    const input = document.getElementById('auth-email');
    const email = input.value.trim();
    if (!email) {
      input.focus();
      return;
    }
    // Optimistic: main won't resolve authSignIn until the whole
    // magic-link round trip finishes (or fails/times out), so flip to
    // "check your inbox" right away rather than waiting on it.
    document.getElementById('auth-form').hidden = true;
    document.getElementById('auth-error').hidden = true;
    document.getElementById('auth-pending').hidden = false;
    try {
      const res = await window.radarAPI.authSignIn(email);
      if (!res || !res.ok) {
        console.error('sign-in failed', res && res.error);
        this.showError((res && res.error) || 'SIGN-IN FAILED');
      }
      // On success, the 'auth:stateChanged' push already re-rendered as
      // signed-in — nothing else to do here.
    } catch (err) {
      console.error('sign-in failed', err);
      this.showError('SIGN-IN FAILED');
    }
  },
};

/* ---------- Sync-config key prompt (see docs/supabase-sync-plan.md's
   notes on the built-in default project URL + first-run key prompt)
   ----------
   Shown once at startup, only when main reports no publishable key was
   found from any source — syncConfigNeedsKey() already folds in "env
   vars fully configure it", so this never shows in that case. Saving
   hands the trimmed key to main for validation (sync/key-validation.js)
   and persistence; main never echoes the key back, and this never logs
   it either. "NOT NOW" just hides the overlay for this run — nothing is
   persisted, so the prompt returns next launch. On a successful save,
   Auth.init() is re-run: its own early return on `!status.configured`
   is exactly why it did nothing the first time boot() called it, so
   this is the only place that ever lets it proceed for a session that
   started out unconfigured — no app restart needed. */
const SyncConfigPrompt = {
  isOpen() {
    const overlay = document.getElementById('sync-key-overlay');
    return !!overlay && !overlay.hidden;
  },
  async init() {
    if (!HAS_API || !window.radarAPI.syncConfigNeedsKey) return;
    let needsKey = false;
    try {
      needsKey = await window.radarAPI.syncConfigNeedsKey();
    } catch (err) {
      console.error('syncConfigNeedsKey failed', err);
      return;
    }
    if (!needsKey) return;
    document.getElementById('sync-key-overlay').hidden = false;
    // aria-modal does not prevent focus or clicks behind the overlay.
    document.getElementById('app').inert = true;
    document.getElementById('sync-key-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.save();
    });
    document.getElementById('sync-key-skip').addEventListener('click', () => this.dismiss());
    document.getElementById('sync-key-input').focus();
  },
  dismiss() {
    document.getElementById('sync-key-overlay').hidden = true;
    document.getElementById('app').inert = false;
  },
  showError(message) {
    const err = document.getElementById('sync-key-error');
    err.textContent = message;
    err.hidden = false;
    // Send focus back to the input so a screen-reader user (and anyone
    // tabbing through) lands right back where they need to fix it,
    // rather than wherever focus happened to be (e.g. the disabled Save
    // button — see save() below).
    document.getElementById('sync-key-input').focus();
  },
  async save() {
    const input = document.getElementById('sync-key-input');
    const key = input.value.trim();
    if (!key) {
      input.focus();
      return;
    }
    const saveBtn = document.getElementById('sync-key-save');
    if (saveBtn.disabled) return; // a save is already in flight — ignore a duplicate submit
    saveBtn.disabled = true;
    document.getElementById('sync-key-error').hidden = true;
    try {
      const res = await window.radarAPI.syncConfigSaveKey(key);
      if (!res || !res.ok) {
        console.error('sync-config key save failed', res && res.error);
        this.showError((res && res.error) || 'COULD NOT SAVE KEY');
        return;
      }
      input.value = '';
      this.dismiss();
      await Auth.init();
    } catch (err) {
      console.error('syncConfigSaveKey failed', err);
      this.showError('COULD NOT SAVE KEY');
    } finally {
      saveBtn.disabled = false;
    }
  },
};

/* ---------- Sync status (Phases 4-5 — see docs/supabase-sync-plan.md)
   ----------
   Mostly push-only from main: the indicator starts hidden and stays that
   way until main pushes a real state over 'sync:stateChanged' — which it
   only does once sync is configured AND the user is signed in (main hides
   it again with `{ state: null }` on sign-out). init() below also asks
   for the current status once via syncStatus(), the same way Auth.init()
   calls authStatus() — see that call's own comment for why the push alone
   isn't enough. `onSyncReload`
   is main telling the renderer "I just merged in a pull — your in-memory
   Store is now behind the data file", so it reloads and re-renders
   rather than trusting its own state. */
const Sync = {
  init() {
    if (!HAS_API || !window.radarAPI.onSyncStateChanged) return;
    window.radarAPI.onSyncStateChanged((status) => this.render(status));
    if (window.radarAPI.onSyncReload) {
      window.radarAPI.onSyncReload(() => this.reload());
    }
    // Ask for the current status once, the same way Auth.init() calls
    // authStatus() — the push alone can otherwise reach nobody (main can
    // start the engine and push a status before this listener above is
    // even registered, and identical pushes are deduped), leaving the
    // indicator stuck hidden for the rest of the session (found in
    // review) — same again after a window reload.
    if (window.radarAPI.syncStatus) {
      window.radarAPI
        .syncStatus()
        .then((state) => this.render({ state }))
        .catch((err) => console.error('syncStatus failed', err));
    }
  },
  render(status) {
    const view = SV.computeSyncView(status);
    const el = document.getElementById('sync-status');
    el.hidden = view.hidden;
    el.textContent = view.label;
    el.className = 'auth-status' + (view.className ? ' ' + view.className : '');
    el.title =
      status && status.state === 'synced' ? 'Your projects are synced across devices' : view.label;
    const signedIn = document.getElementById('auth-signed-in');
    signedIn.classList.toggle('sync-has-status', !view.hidden);
  },
  async reload() {
    try {
      // Merges the file's contents into Store rather than replacing it
      // (Store.load() does the latter) — a plain replace can lose an
      // edit made in this renderer that hasn't reached disk yet: a save
      // still in-flight when this runs would have Store rolled back to
      // the pre-edit copy, and a save still sitting in scheduleSave's
      // 120ms debounce window would later serialize the *reloaded*
      // (pre-edit) Store, overwriting the edit for good (found in
      // review — the same class of save race this whole phase exists to
      // fix, just on the renderer's side of the file instead of main's).
      // The merge logic itself is domain.js's pure mergeDiskIntoStore
      // (pulled out of here in a later review pass so it's unit-tested
      // rather than only reachable through the DOM) — safe for the same
      // reason the rest of sync is: the same last-writer-wins rule that
      // already reconciles two machines, applied here to reconcile "the
      // renderer's in-memory view" against "what main just wrote".
      const fromDisk = await Persist.load();
      if (fromDisk) {
        const merged = D.mergeDiskIntoStore(fromDisk, Store);
        Store.items = merged.items;
        Store.arch = merged.arch;
        Store.lastExport = merged.lastExport;
      }
      render();
    } catch (err) {
      console.error('reload after sync merge failed', err);
    }
  },
};

/* ---------- Selectors ---------- */
function visibleList() {
  return D.selectVisible(Store);
}

/* ---------- Render ---------- */
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(label, fn, cls = '') {
  const el = node('button', 'dact ' + cls, label);
  el.type = 'button';
  el.addEventListener('click', fn);
  return el;
}
function dateLabel(date) {
  if (!date) return 'Not scheduled';
  return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
function dateAfter(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return D.localDate(date.getTime());
}
function renderDetail() {
  const panel = document.getElementById('detail-panel');
  const it = [...stripTombstones(Store.items), ...stripTombstones(Store.arch)].find(
    (i) => i.id === Store.ui.sel
  );
  panel.hidden = !it || Store.ui.showForm;
  document.getElementById('inspector').hidden = !it && !Store.ui.showForm;
  if (panel.hidden) return;
  document.getElementById('detail-name').textContent = it.name;
  const meta = document.getElementById('detail-meta');
  meta.replaceChildren();
  for (const [label, color] of [
    [it.archivedAt ? 'Archived' : it.status, SC[it.status]],
    [it.priority + ' priority', PC[it.priority]],
    [it.category, ''],
  ]) {
    if (!label) continue;
    const el = node('span', '', label);
    if (color) el.style.color = color;
    meta.append(el);
  }
  const context = document.getElementById('detail-context');
  context.replaceChildren();
  if (it.waitingOn) context.append(node('p', '', 'Waiting on ' + it.waitingOn));
  if (it.checkpoint || it.checkpointOn) {
    const checkpoint = node('div', 'checkpoint');
    checkpoint.append(
      node('span', 'eyebrow', 'Next checkpoint'),
      node('p', '', it.checkpoint || 'Follow up')
    );
    if (it.checkpointOn)
      checkpoint.append(node('span', 'checkpoint-date', dateLabel(it.checkpointOn)));
    if (!it.archivedAt)
      checkpoint.append(
        button(
          'Complete checkpoint',
          () => Actions.update(it.id, { checkpoint: '', checkpointOn: '' }),
          'quiet'
        )
      );
    context.append(checkpoint);
  }
  const notes = document.getElementById('detail-notes');
  notes.textContent = it.notes || '';
  notes.hidden = !it.notes;
  const schedule = document.getElementById('detail-schedule');
  schedule.replaceChildren();
  const actions = document.getElementById('detail-actions');
  actions.replaceChildren();
  if (!it.archivedAt) {
    const rhythm = it.reviewIntervalDays
      ? 'Every ' + it.reviewIntervalDays + ' days'
      : 'Only when scheduled';
    schedule.append(
      node('span', 'eyebrow', 'Review rhythm'),
      node('p', '', rhythm + ' · Next: ' + dateLabel(D.reviewDate(it)))
    );
    const label = node('label', '', 'Next review after this check-in');
    label.htmlFor = 'review-choice';
    const select = node('select');
    select.id = 'review-choice';
    for (const [value, text] of [
      ['rhythm', 'Use review rhythm'],
      ['1', 'Tomorrow'],
      ['3', 'In 3 days'],
      ['7', 'In a week'],
      ['30', 'In 30 days'],
      ['custom', 'Choose a date…'],
    ]) {
      const option = node('option', '', text);
      option.value = value;
      select.append(option);
    }
    const date = node('input');
    date.type = 'date';
    date.hidden = true;
    date.min = D.localDate();
    date.setAttribute('aria-label', 'Custom next review date');
    const chosenDate = () =>
      select.value === 'custom'
        ? date.value
        : select.value === 'rhythm'
          ? undefined
          : dateAfter(Number(select.value));
    const validChoice = () => select.value !== 'custom' || date.reportValidity();
    const snooze = button('Snooze review', () => {
      if (validChoice()) Actions.snooze(it.id, chosenDate());
    });
    snooze.disabled = true;
    select.addEventListener('change', () => {
      date.hidden = select.value !== 'custom';
      date.required = !date.hidden;
      snooze.disabled = select.value === 'rhythm';
      if (!date.hidden) date.focus();
    });
    const controls = node('div', 'review-controls');
    controls.append(select, date);
    const reviewActions = node('div', 'review-actions');
    reviewActions.append(
      button(
        'Reviewed',
        () => {
          if (validChoice()) Actions.review(it.id, chosenDate());
        },
        'primary'
      ),
      snooze
    );
    schedule.append(
      label,
      controls,
      reviewActions,
      node(
        'p',
        'field-help',
        'Reviewing resets this rhythm. Checkpoints stay open until completed.'
      )
    );
    if (Store.ui.view === 'all') actions.append(button('Edit project', () => openEdit(it)));
    actions.append(button('Archive', () => Actions.archive(it.id), 'quiet'));
  } else {
    actions.append(
      button('Restore', () => Actions.restore(it.id)),
      button(
        'Delete permanently',
        () => {
          if (confirm('Delete this project from this and synced devices?')) Actions.purge(it.id);
        },
        'danger'
      )
    );
  }
  document.getElementById('detail-date').textContent = it.archivedAt
    ? 'Archived ' + fdt(it.archivedAt)
    : 'Last reviewed ' + fdt(it.reviewedAt || it.addedAt);
  const log = document.getElementById('detail-log');
  log.replaceChildren();
  const entries = (it.log || []).slice().reverse();
  if (entries.length) {
    log.append(node('h3', 'eyebrow', 'Activity · ' + entries.length));
    entries.forEach((entry) => {
      const row = node('div', 'detail-log-entry');
      row.append(
        node('span', 'detail-log-ts', fdt(entry.ts)),
        node('span', 'detail-log-text', entry.text)
      );
      log.append(row);
    });
  }
  const compose = document.getElementById('detail-log-compose');
  compose.replaceChildren();
  if (!it.archivedAt) {
    const input = node('input', 'detail-log-input');
    input.placeholder = 'Add a status update…';
    input.setAttribute('aria-label', 'Status update');
    const submit = () => {
      if (input.value.trim()) Actions.addLogEntry(it.id, input.value.trim());
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    compose.append(input, button('Add update', submit));
  }
}
function renderList() {
  const list = document.getElementById('list');
  list.querySelectorAll('.contact-row, .contact-list-entry').forEach((el) => el.remove());
  const items = visibleList();
  const empty = document.getElementById('empty-msg');
  empty.hidden = items.length > 0;
  empty.replaceChildren();
  if (!items.length) {
    const today = Store.ui.view === 'today';
    empty.append(
      node('span', 'empty-symbol', '◈'),
      node(
        'h2',
        '',
        today
          ? 'You’re up to date.'
          : Store.ui.search || Store.ui.filter !== 'all'
            ? 'No matching projects.'
            : Store.ui.view === 'archive'
              ? 'Your archive is empty.'
              : 'A clear radar.'
      ),
      node(
        'p',
        '',
        today
          ? 'Nothing is due for review or follow-up today. Your other projects are in All.'
          : 'Keep track of what matters, at your own pace.'
      )
    );
    if (today) empty.append(button('See all projects', () => switchView('all'), 'quiet'));
  }
  items.forEach((item) => {
    const row = node('button', 'contact-row' + (Store.ui.sel === item.id ? ' selected' : ''));
    row.type = 'button';
    if (Store.ui.sel === item.id) row.style.borderLeftColor = PC[item.priority];
    row.setAttribute('aria-expanded', String(Store.ui.sel === item.id));
    row.setAttribute('aria-controls', 'detail-panel');
    row.addEventListener('click', () => {
      Store.ui.sel = Store.ui.sel === item.id ? null : item.id;
      Store.ui.showForm = false;
      render();
      if (Store.ui.sel) document.getElementById('detail-close').focus();
    });
    const main = node('div', 'contact-main');
    const left = node('div', 'contact-left');
    const dot = node('span', 'contact-dot');
    dot.style.background = item.archivedAt ? '#546e7a' : PC[item.priority];
    left.append(dot, node('span', 'contact-name', item.name));
    const right = node('span', 'contact-right', item.archivedAt ? 'Archived' : item.status);
    right.style.color = item.archivedAt ? '#546e7a' : SC[item.status];
    main.append(left, right);
    row.append(main);
    const context = [
      item.category,
      item.waitingOn ? 'Waiting on ' + item.waitingOn : item.checkpoint || item.notes,
    ]
      .filter(Boolean)
      .join(' · ');
    if (context) row.append(node('div', 'contact-context', context));
    const reasons = item.archivedAt ? [] : D.attentionReasons(item);
    if (reasons.length) row.append(node('div', 'attention-reasons', reasons.join(' · ')));
    else if (!item.archivedAt)
      row.append(node('div', 'upcoming', 'Next review: ' + dateLabel(D.reviewDate(item))));
    if (Store.ui.view === 'all') {
      const entry = node('div', 'contact-list-entry');
      const edit = button('Edit', () => openEdit(item), 'project-edit');
      edit.dataset.projectId = item.id;
      edit.setAttribute('aria-label', 'Edit ' + item.name);
      entry.append(row, edit);
      list.append(entry);
    } else {
      list.append(row);
    }
  });
}
function render() {
  const today = Store.ui.view === 'today';
  const archive = Store.ui.view === 'archive';
  document
    .getElementById('body')
    .classList.toggle('editing-project', Store.ui.showForm && Store.ui.view === 'all');
  document.getElementById('today-count').textContent = stripTombstones(Store.items).filter((i) =>
    D.isDueToday(i)
  ).length;
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.view === Store.ui.view || (archive && t.dataset.view === 'all');
    t.classList.toggle('active', active);
    t.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('all-controls').hidden = today;
  document.getElementById('filter').hidden = archive;
  document.getElementById('archive-btn').hidden = today;
  document.getElementById('archive-btn').textContent = archive ? '← All projects' : 'Archive';
  document.getElementById('view-title').textContent = today
    ? "Today's radar"
    : archive
      ? 'Archive'
      : 'All projects';
  document.getElementById('view-subtitle').textContent = today
    ? 'What needs your attention, and why.'
    : archive
      ? 'Finished for now. Restore a project whenever you need it.'
      : 'Everything you’re keeping in sight.';
  document.getElementById('view-date').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  document.getElementById('kbd-hint').textContent =
    Store.ui.showForm && Store.ui.view === 'all'
      ? 'Ctrl/Cmd+Enter save · Esc cancel'
      : 'N new · / search · ' +
        (Store.ui.view === 'all' ? 'E edit · ' : '') +
        'R reviewed · Esc close';
  document.getElementById('form-panel').hidden = !Store.ui.showForm;
  renderList();
  renderDetail();
}
function switchView(view) {
  Store.ui.showForm = false;
  Store.ui.editId = null;
  Store.ui.view = view;
  Store.ui.sel = null;
  Store.ui.search = '';
  Store.ui.filter = 'all';
  document.getElementById('search').value = '';
  document.getElementById('filter').value = 'all';
  render();
}
function focusSearch() {
  if (Store.ui.view !== 'all') switchView('all');
  document.getElementById('search').focus();
}

/* ---------- Form ---------- */
function setSeg(group, val) {
  document.querySelectorAll('[data-group="' + group + '"]').forEach((b) => {
    const on = b.dataset.val === val;
    b.classList.toggle('active-seg', on);
    const col = group === 'priority' ? PC[b.dataset.val] : SC[b.dataset.val];
    b.style.background = on ? col + '18' : 'none';
    b.style.borderColor = on ? col : '#0f2816';
    b.style.color = on ? col : '#1a4d2e';
    b.setAttribute('aria-pressed', String(on));
  });
}
function getSeg(group) {
  let v = null;
  document.querySelectorAll('[data-group="' + group + '"]').forEach((b) => {
    if (b.classList.contains('active-seg')) v = b.dataset.val;
  });
  return v;
}

function openAdd() {
  Store.ui.showForm = true;
  Store.ui.editId = null;
  Store.ui.sel = null;
  document.getElementById('form-label').textContent = 'New project';
  document.getElementById('form-save').textContent = 'Create project';
  document.getElementById('f-name').value = '';
  document.getElementById('f-cat').value = '';
  document.getElementById('f-notes').value = '';
  fillSchedule({ reviewIntervalDays: 14 });
  setSeg('status', 'active');
  setSeg('priority', 'medium');
  render();
  document.getElementById('f-name').focus();
}
function openEdit(it) {
  if (Store.ui.view !== 'all' || it.archivedAt) return;
  Store.ui.editScrollTop = document.getElementById('list').scrollTop;
  Store.ui.sel = it.id;
  Store.ui.showForm = true;
  Store.ui.editId = it.id;
  document.getElementById('form-label').textContent = 'Edit project · ' + it.name;
  document.getElementById('form-save').textContent = 'Save changes';
  document.getElementById('f-name').value = it.name;
  document.getElementById('f-cat').value = it.category || '';
  document.getElementById('f-notes').value = it.notes || '';
  fillSchedule(it);
  setSeg('status', it.status);
  setSeg('priority', it.priority);
  render();
  document.getElementById('f-name').focus();
}
function fillSchedule(it) {
  const interval = it.reviewIntervalDays;
  document.getElementById('f-rhythm').value =
    interval === null ? 'manual' : [3, 7, 14, 30].includes(interval) ? String(interval) : 'custom';
  document.getElementById('f-interval').value = interval || 14;
  document.getElementById('f-review').value = it.nextReviewOn || '';
  document.getElementById('f-waiting').value = it.waitingOn || '';
  document.getElementById('f-checkpoint').value = it.checkpoint || '';
  document.getElementById('f-checkpoint-date').value = it.checkpointOn || '';
  updateRhythm();
}
function updateRhythm() {
  const custom = document.getElementById('f-rhythm').value === 'custom';
  document.getElementById('custom-rhythm').hidden = !custom;
  document.getElementById('f-interval').disabled = !custom;
  document.getElementById('f-interval').required = custom;
}
function closeForm() {
  const editId = Store.ui.editId;
  Store.ui.showForm = false;
  Store.ui.editId = null;
  if (editId) Store.ui.sel = null;
  render();
  if (editId) {
    document.getElementById('list').scrollTop = Store.ui.editScrollTop || 0;
    const edit = [...document.querySelectorAll('.project-edit')].find(
      (el) => el.dataset.projectId === editId
    );
    if (edit) edit.focus({ preventScroll: true });
    else document.getElementById('search').focus();
  }
}
function saveForm() {
  if (!document.getElementById('form-panel').reportValidity()) return;
  const rhythm = document.getElementById('f-rhythm').value;
  const v = {
    name: document.getElementById('f-name').value.trim(),
    category: document.getElementById('f-cat').value.trim(),
    notes: document.getElementById('f-notes').value.trim(),
    status: getSeg('status') || 'active',
    priority: getSeg('priority') || 'medium',
    reviewIntervalDays:
      rhythm === 'manual'
        ? null
        : Number(rhythm === 'custom' ? document.getElementById('f-interval').value : rhythm),
    nextReviewOn: document.getElementById('f-review').value,
    waitingOn: document.getElementById('f-waiting').value.trim(),
    checkpoint: document.getElementById('f-checkpoint').value.trim(),
    checkpointOn: document.getElementById('f-checkpoint-date').value,
  };
  if (!v.name) {
    document.getElementById('f-name').focus();
    return;
  }
  if (Store.ui.editId) Actions.update(Store.ui.editId, v);
  else {
    Actions.add(v);
    Store.ui.sel = Store.items[Store.items.length - 1].id;
  }
  closeForm();
}

/* ---------- Wiring ---------- */
function wire() {
  document
    .querySelectorAll('.tab')
    .forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  document
    .getElementById('archive-btn')
    .addEventListener('click', () => switchView(Store.ui.view === 'archive' ? 'all' : 'archive'));
  document.getElementById('filter').addEventListener('change', (e) => {
    Store.ui.filter = e.target.value;
    renderList();
  });
  document.getElementById('detail-close').addEventListener('click', () => {
    Store.ui.sel = null;
    render();
  });
  document.getElementById('f-rhythm').addEventListener('change', () => {
    updateRhythm();
    document.getElementById('f-review').value = '';
  });
  document.getElementById('f-interval').addEventListener('input', () => {
    document.getElementById('f-review').value = '';
  });
  document.getElementById('browser-menu').hidden = HAS_API;
  document
    .querySelectorAll('.seg-btn')
    .forEach((b) => b.addEventListener('click', () => setSeg(b.dataset.group, b.dataset.val)));
  document.getElementById('sort').addEventListener('change', (e) => {
    Store.ui.sort = e.target.value;
    render();
  });
  document.getElementById('search').addEventListener('input', (e) => {
    Store.ui.search = e.target.value;
    renderList();
  });
  document.getElementById('add-btn').addEventListener('click', openAdd);
  document.getElementById('form-abort').addEventListener('click', closeForm);
  document.getElementById('form-panel').addEventListener('submit', (e) => {
    e.preventDefault();
    saveForm();
  });
  document.getElementById('export-json-btn').addEventListener('click', () => Actions.exportJSON());
  document.getElementById('export-pdf-btn').addEventListener('click', () => Actions.exportPDF());
  document.getElementById('import-btn').addEventListener('click', () => Actions.importJSON());
  document.getElementById('import-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(r.result);
      } catch (err) {
        console.error('import parse failed', err);
        alert('INVALID FILE — not valid JSON.');
        return;
      }
      try {
        Actions.mergeImported(parsed);
      } catch (err) {
        console.error('import merge failed', err);
        alert('IMPORT FAILED — the file merged with unexpected data. See console for details.');
      }
    };
    r.readAsText(f);
    e.target.value = '';
  });

  document.addEventListener('keydown', (e) => {
    // Block app shortcuts while the modal is open; Escape dismisses it.
    if (SyncConfigPrompt.isOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        SyncConfigPrompt.dismiss();
      }
      return;
    }
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (Store.ui.showForm) closeForm();
      else if (document.activeElement.id === 'search') document.getElementById('search').blur();
      else if (Store.ui.search) {
        Store.ui.search = '';
        document.getElementById('search').value = '';
        render();
      } else if (Store.ui.sel) {
        Store.ui.sel = null;
        render();
      }
      return;
    }
    if (
      Store.ui.showForm &&
      Store.ui.view === 'all' &&
      (e.ctrlKey || e.metaKey) &&
      e.key === 'Enter'
    ) {
      e.preventDefault();
      saveForm();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const sel = [...stripTombstones(Store.items), ...stripTombstones(Store.arch)].find(
      (i) => i.id === Store.ui.sel
    );
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openAdd();
    } else if (e.key === '/') {
      e.preventDefault();
      focusSearch();
    } else if ((e.key === 'e' || e.key === 'E') && sel && !sel.archivedAt) openEdit(sel);
    else if (['r', 'R', 'p', 'P'].includes(e.key) && sel && !sel.archivedAt) Actions.review(sel.id);
    else if ((e.key === 'a' || e.key === 'A') && sel && !sel.archivedAt) Actions.archive(sel.id);
  });

  // Native menu commands (Electron)
  if (HAS_API && window.radarAPI.onMenu) {
    window.radarAPI.onMenu((action) => {
      if (action === 'new') openAdd();
      else if (action === 'search') focusSearch();
      else if (action === 'export') Actions.exportJSON();
      else if (action === 'exportPDF') Actions.exportPDF();
      else if (action === 'import') Actions.importJSON();
      else if (action === 'reveal' && window.radarAPI.revealBackups)
        window.radarAPI.revealBackups();
    });
  }

  let renderedDay = D.localDate();
  const refreshAttention = () => {
    document.getElementById('today-count').textContent = stripTombstones(Store.items).filter((i) =>
      D.isDueToday(i)
    ).length;
    document.getElementById('view-date').textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    renderList(); // Keep any draft form, review choice, or activity update intact.
    renderedDay = D.localDate();
  };
  window.addEventListener('focus', refreshAttention);
  setInterval(() => {
    if (renderedDay !== D.localDate()) refreshAttention();
  }, 30000);
}

/* ---------- Boot ---------- */
(async function boot() {
  wire();
  Auth.init().catch((err) => console.error('Auth.init failed', err));
  Sync.init();
  SyncConfigPrompt.init().catch((err) => console.error('SyncConfigPrompt.init failed', err));
  try {
    await Store.load();
  } catch (err) {
    // Store.items/arch are still their empty initial value here. Without
    // this guard the error is silently swallowed (nothing logs it, render()
    // never runs so the UI looks stuck), and the next add/commit would save
    // that empty Store over the user's data file — a data-loss path.
    loadFailed = true;
    console.error('Store.load failed — refusing to save until the app is restarted', err);
    alert(
      'LOAD FAILED — your data could not be read. Changes will NOT be saved.\n' +
        'Restart the app; if this keeps happening, check the console and your data file.'
    );
  }
  render();
})();
