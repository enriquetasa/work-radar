'use strict';
const D = window.WorkRadarDomain;
const AV = window.WorkRadarAuthView;
const SV = window.WorkRadarSyncView;
const { PC, SC, uid, fdt, stripTombstones } = D;
const HAS_API = typeof window !== 'undefined' && !!window.radarAPI;

// Persistence
const Persist = {
  async load() {
    if (HAS_API) return window.radarAPI.load();
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
      return res;
    }
    try {
      localStorage.setItem('workradar', JSON.stringify(obj));
    } catch (e) {
      console.error('localStorage write failed', e);
      alert('STORAGE WRITE FAILED — export a backup now.');
    }
  },
};

// Store
const Store = {
  items: [],
  arch: [],
  lastExport: 0,
  itemRevisions: [],
  attachments: [],
  attachmentRecords: [],
  profileId: null,
  categoryOptions: null,
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
      // Try legacy browser keys on first run.
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
    if (Number.isFinite(Number(d.schema)) && Number(d.schema) > D.SCHEMA) {
      throw new Error('This data file was created by a newer version of Work Radar.');
    }
    // Collapse records that legacy imports placed in both lists.
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
    this.itemRevisions = Array.isArray(d.itemRevisions) ? d.itemRevisions : [];
    this.attachments = Array.isArray(d.attachments) ? d.attachments : [];
    this.attachmentRecords = Array.isArray(d.attachmentRecords) ? d.attachmentRecords : [];
    this.profileId = d.profileId || null;
    this.categoryOptions = Array.isArray(d.categoryOptions)
      ? D.normalizeCategories(d.categoryOptions)
      : null;
  },
  serialize() {
    return D.serialize(this);
  },
};

// Keep unfinished check-ins when controls refresh or a project is closed.
const detailDrafts = new Map();
function detailDraft(id) {
  if (!detailDrafts.has(id))
    detailDrafts.set(id, { note: '', reviewChoice: 'rhythm', reviewDate: '' });
  return detailDrafts.get(id);
}

// Save queue
let saveQueue = Promise.resolve();
let saveGeneration = 0;
function invalidatePendingSaves() {
  saveGeneration += 1;
}
// A failed load disables saves to prevent overwriting unreadable data.
let loadFailed = false;
function mergeSavedMetadata(data) {
  if (!data) return;
  const merge = (current, incoming) => {
    const rows = [
      ...(Array.isArray(current) ? current : []),
      ...(Array.isArray(incoming) ? incoming : []),
    ];
    return [...new Map(rows.filter((row) => row && row.id).map((row) => [row.id, row])).values()];
  };
  Store.itemRevisions = merge(Store.itemRevisions, data.itemRevisions);
  Store.attachments = merge(Store.attachments, data.attachments);
  Store.attachmentRecords = merge(Store.attachmentRecords, data.attachmentRecords);
}
function scheduleSave(options = {}) {
  if (loadFailed) {
    console.error('save skipped: Store.load() failed at boot, refusing to overwrite data file');
    return;
  }
  const payload = { ...Store.serialize(), ...options };
  const generation = saveGeneration;
  saveQueue = saveQueue
    .then(async () => {
      if (generation !== saveGeneration) return;
      const result = await Persist.save(payload);
      if (generation !== saveGeneration) return;
      if (result && result.data) {
        mergeSavedMetadata(result.data);
        const selected = [...Store.items, ...Store.arch].find((item) => item.id === Store.ui.sel);
        if (selected && !Store.ui.showForm) renderHistory(selected);
      }
    })
    .catch((err) => console.error('queued save failed', err));
}

function commit(options = {}) {
  scheduleSave(options);
  render();
}
function clearRendererProfile() {
  detailDrafts.clear();
  Settings.close();
  Store.categoryOptions = null;
  Store.items = [];
  Store.arch = [];
  Store.itemRevisions = [];
  Store.attachments = [];
  Store.attachmentRecords = [];
  Store.profileId = null;
  Store.lastExport = 0;
  Store.ui.sel = null;
  Store.ui.search = '';
  Store.ui.showForm = false;
  Store.ui.editId = null;
}
async function reloadRendererProfile() {
  clearRendererProfile();
  await Store.load();
  render();
}

// Actions
const Actions = {
  add(v) {
    Store.items.push(D.createItem(v, Date.now(), uid));
    commit({ historyAction: 'create' });
  },
  update(id, v) {
    Store.items = Store.items.map((i) => (i.id === id ? D.updateItem(i, v, Date.now()) : i));
    commit({ historyAction: 'edit' });
  },
  review(id, nextDate) {
    const now = Date.now();
    Store.items = Store.items.map((i) => (i.id === id ? D.reviewItem(i, now, nextDate) : i));
    commit({ historyAction: 'review' });
  },
  snooze(id, date) {
    Store.items = Store.items.map((i) => (i.id === id ? D.snoozeItem(i, date, Date.now()) : i));
    commit({ historyAction: 'snooze' });
  },
  archive(id) {
    const it = Store.items.find((i) => i.id === id);
    if (!it) return;
    const now = Date.now();
    Store.arch.unshift(D.archiveItem(it, now));
    Store.items = Store.items.filter((i) => i.id !== id);
    if (Store.ui.sel === id) Store.ui.sel = null;
    commit({ historyAction: 'archive' });
  },
  restore(id) {
    const it = Store.arch.find((i) => i.id === id);
    if (!it) return;
    const now = Date.now();
    Store.items.push(D.restoreItem(it, now));
    Store.arch = Store.arch.filter((i) => i.id !== id);
    commit({ historyAction: 'restore' });
  },
  // Keep tombstones for sync while hiding them from the UI.
  purge(id) {
    const now = Date.now();
    Store.arch = Store.arch.map((i) => (i.id === id ? D.purgeItem(i, now) : i));
    if (Store.ui.sel === id) Store.ui.sel = null;
    if (HAS_API && window.radarAPI.attachmentsRemoveForItem)
      window.radarAPI
        .attachmentsRemoveForItem(id)
        .catch((err) => console.error('attachment purge failed', err));
    commit({ historyAction: 'purge' });
  },
  addLogEntry(id, text) {
    const now = Date.now();
    Store.items = Store.items.map((i) => (i.id === id ? D.addLogEntry(i, text, now, uid) : i));
    commit({ historyAction: 'log' });
  },
  restoreRevision(itemId, revision) {
    const current = [...Store.items, ...Store.arch].find((item) => item.id === itemId);
    if (!revision || !revision.snapshot) return false;
    const snapshot = JSON.parse(JSON.stringify(revision.snapshot));
    const base = current || { ...snapshot, id: itemId, log: [] };
    const restored = {
      ...base,
      ...snapshot,
      id: itemId,
      archivedAt: snapshot.archivedAt || undefined,
      deletedAt: snapshot.deletedAt || undefined,
      log: base.log || [],
      updatedAt: Math.max(Date.now(), (base.updatedAt || 0) + 1),
    };
    Store.items = Store.items.filter((item) => item.id !== itemId);
    Store.arch = Store.arch.filter((item) => item.id !== itemId);
    (restored.archivedAt ? Store.arch : Store.items).push(restored);
    commit({ historyAction: 'restore', restoredFromRevisionId: revision.id });
    return true;
  },

  async exportJSON() {
    await saveQueue;
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

  async exportFull() {
    if (!HAS_API || !window.radarAPI.exportFull) return this.exportJSON();
    await saveQueue;
    const result = await window.radarAPI.exportFull(Store.serialize());
    if (!result || !result.ok)
      alert('FULL BACKUP FAILED — ' + ((result && result.error) || 'cancelled'));
  },

  async importFull() {
    if (!HAS_API || !window.radarAPI.importFull) return;
    const data = await window.radarAPI.importFull();
    if (!data) return;
    if (data.error) {
      alert('FULL BACKUP FAILED — ' + data.error);
      return;
    }
    return this.mergeImported(data, { skipConfirm: data.__fullImportConfirmed === true });
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
      const w = window.open();
      w.document.write(html);
      w.document.close();
    }
  },

  mergeImported(d, { skipConfirm = false } = {}) {
    if (Number.isFinite(Number(d && d.schema)) && Number(d.schema) > D.SCHEMA) {
      alert('IMPORT FAILED — this backup was created by a newer version of Work Radar.');
      return false;
    }
    const inItems = D.migrate(Array.isArray(d.items) ? d.items : []);
    const inArch = D.migrate(Array.isArray(d.arch) ? d.arch : []);
    if (!inItems.length && !inArch.length && !Array.isArray(d.categoryOptions)) {
      alert('NO PROJECTS OR CATEGORY SETTINGS FOUND IN FILE.');
      return false;
    }
    const liveCount = D.stripTombstones(inItems).length;
    const archCount = D.stripTombstones(inArch).length;
    const deletions = inItems.length - liveCount + (inArch.length - archCount);
    if (
      !skipConfirm &&
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
      return false;
    const merged = D.mergeState(
      { items: Store.items, arch: Store.arch },
      { items: inItems, arch: inArch }
    );
    Store.categoryOptions = D.normalizeCategories([
      ...D.categoryOptions(Store),
      ...D.categoryOptions({ ...d, items: inItems, arch: inArch }),
    ]);
    Store.items = merged.items;
    Store.arch = merged.arch;
    const mergeById = (left, right) => {
      const out = new Map(
        [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]
          .filter((row) => row && row.id)
          .map((row) => [row.id, row])
      );
      return [...out.values()];
    };
    Store.itemRevisions = mergeById(Store.itemRevisions, d.itemRevisions);
    Store.attachments = mergeById(Store.attachments, d.attachments);
    Store.attachmentRecords = mergeById(Store.attachmentRecords, d.attachmentRecords);
    Store.ui.sel = null;
    commit({ historyAction: 'import' });
    return true;
  },

  async importJSON() {
    if (HAS_API) {
      const d = await window.radarAPI.import();
      if (!d) return false;
      try {
        return this.mergeImported(d);
      } catch (err) {
        console.error('import merge failed', err);
        alert('IMPORT FAILED — the file merged with unexpected data. See console for details.');
      }
    } else {
      document.getElementById('import-file').click();
    }
  },
};

// Authentication
const Auth = {
  _listenersBound: false,
  lastSignedIn: false,
  status: { configured: false, signedIn: false, pending: false },
  async init() {
    if (!HAS_API || !window.radarAPI.authStatus) return;
    let status;
    try {
      status = await window.radarAPI.authStatus();
    } catch (err) {
      console.error('authStatus failed', err);
      return;
    }
    this.status = status || { configured: false, signedIn: false, pending: false };
    document.getElementById('auth-panel').hidden = false;
    this.render(this.status);
    if (this._listenersBound) return;
    this._listenersBound = true;
    if (window.radarAPI.onAuthStateChanged)
      window.radarAPI.onAuthStateChanged((next) => {
        const previous = this.status || {};
        this.lastSignedIn = Boolean(previous.signedIn || previous.userId);
        this.status = next
          ? { ...next, configured: next.configured ?? previous.configured ?? false }
          : { configured: previous.configured ?? false, signedIn: false, pending: false };
        this.render(this.status);
        const accountChanged = previous.userId && previous.userId !== this.status.userId;
        if (!this.status.signedIn || this.status.profileRequired || accountChanged) {
          invalidatePendingSaves();
          clearRendererProfile();
          render();
        }
        if (this.status.signedIn) {
          if (this.status.profileRequired) Onboarding.requireAssociation();
          else {
            window.radarAPI
              .onboardingMarkSignedIn?.()
              .catch((err) => console.error('onboarding update failed', err));
            Onboarding.finish();
            reloadRendererProfile().catch((err) =>
              console.error('profile reload after sign-in failed', err)
            );
          }
        } else {
          Onboarding.finish();
          reloadRendererProfile().catch((err) =>
            console.error('profile reload after sign-out failed', err)
          );
        }
      });
    document.getElementById('auth-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    document.getElementById('account-signout').addEventListener('click', () => this.signOut());
    document.getElementById('auth-signed-in').addEventListener('click', () => Account.toggle());
    document.getElementById('briefing-open-btn').addEventListener('click', () => {
      Account.close();
      Briefing.open();
    });
  },
  render(status) {
    this.status = status || { configured: false, signedIn: false, pending: false };
    const view = AV.computeAuthView(this.status);
    const form = document.getElementById('auth-form');
    const signedIn = document.getElementById('auth-signed-in');
    document.getElementById('auth-error').hidden = view.clearError
      ? true
      : document.getElementById('auth-error').hidden;
    form.hidden = !view.form;
    document.getElementById('auth-pending').hidden = !view.pending;
    signedIn.hidden = !view.signedIn;
    const local = document.getElementById('local-status');
    local.hidden = !!this.status.signedIn;
    if (!this.status.configured) {
      form.hidden = true;
      document.getElementById('auth-pending').hidden = true;
      signedIn.hidden = true;
      return;
    }
    if (view.signedIn) {
      const email = this.status.email || '';
      document.getElementById('auth-email-label').textContent = email;
      document.getElementById('account-email').textContent = email;
      signedIn.title = email;
    } else if (this.status.configured) {
      const localOnly = Onboarding.state?.mode === 'local';
      const retry =
        !localOnly &&
        (this.lastSignedIn || Onboarding.state?.mode === 'account' || this.status.expired === true);
      const label = retry ? 'Sign in again' : 'Sign in';
      document.getElementById('auth-email-label').textContent = label;
      document.getElementById('account-email').textContent = '';
      document.getElementById('auth-submit').textContent = label;
      document.getElementById('auth-email').placeholder = retry
        ? 'Sign in again to sync'
        : 'Email for sync';
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
    document.getElementById('auth-form').hidden = true;
    document.getElementById('auth-error').hidden = true;
    document.getElementById('auth-pending').hidden = false;
    try {
      const res = await window.radarAPI.authSignIn(email);
      if (!res || !res.ok) this.showError((res && res.error) || 'SIGN-IN FAILED');
    } catch (err) {
      console.error('sign-in failed', err);
      this.showError('SIGN-IN FAILED');
    }
  },
  async signOut() {
    Account.close();
    invalidatePendingSaves();
    clearRendererProfile();
    render();
    try {
      await window.radarAPI.authSignOut();
    } catch (err) {
      console.error('sign-out failed', err);
    }
  },
};

const Account = {
  toggle() {
    const menu = document.getElementById('account-menu');
    const button = document.getElementById('auth-signed-in');
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
  },
  close() {
    const menu = document.getElementById('account-menu');
    if (menu) menu.hidden = true;
    const button = document.getElementById('auth-signed-in');
    if (button) button.setAttribute('aria-expanded', 'false');
  },
};

const Onboarding = {
  state: null,
  step: 'welcome',
  _handlersBound: false,
  async init() {
    const overlay = document.getElementById('welcome-overlay');
    if (!overlay) return;
    this.bindHandlers();
    let state = null;
    if (HAS_API && window.radarAPI.onboardingGet) {
      try {
        state = await window.radarAPI.onboardingGet();
      } catch (err) {
        console.error('onboarding load failed', err);
      }
    } else {
      try {
        state = JSON.parse(localStorage.getItem('workradar-onboarding') || 'null');
      } catch {
        state = null;
      }
    }
    this.state = state || { status: 'new', step: 'welcome' };
    Auth.render(Auth.status);
    if (Auth.status.signedIn && Auth.status.profileRequired) {
      this.requireAssociation();
      return;
    }
    if (
      !WorkRadarOnboardingView.shouldShow(
        this.state,
        Store.items.length > 0 || Store.arch.length > 0 || Store.itemRevisions.length > 0,
        Auth.status.signedIn
      )
    )
      return;
    overlay.hidden = false;
    document.getElementById('app').inert = true;
    document.getElementById('welcome-signin').hidden = !Auth.status.configured;
    if (this.state.step === 'signin' && this.state.status === 'in_progress') this.showSignIn();
    else this.showWelcome();
  },
  bindHandlers() {
    if (this._handlersBound) return;
    this._handlersBound = true;
    document.getElementById('welcome-local').onclick = () => this.chooseLocal();
    document.getElementById('welcome-import').onclick = () => this.importBackup();
    document.getElementById('welcome-signin').onclick = () => this.showSignIn();
    document.getElementById('welcome-back').onclick = () => this.showWelcome();
    document.getElementById('welcome-signin-form').onsubmit = (e) => {
      e.preventDefault();
      this.submitSignIn();
    };
    document.getElementById('welcome-create').onclick = () => {
      this.finish();
      openAdd();
    };
    document.getElementById('welcome-dismiss').onclick = () => this.finish();
    document.getElementById('welcome-associate').onclick = () => this.associate(false);
    document.getElementById('welcome-keep-local').onclick = () => this.associate(true);
  },
  async persist(patch) {
    this.state = { ...this.state, ...patch };
    if (HAS_API && window.radarAPI.onboardingUpdate) await window.radarAPI.onboardingUpdate(patch);
    else localStorage.setItem('workradar-onboarding', JSON.stringify(this.state));
  },
  showSignIn() {
    this.step = 'signin';
    document.getElementById('welcome-start-actions').hidden = true;
    document.getElementById('welcome-final-actions').hidden = true;
    document.getElementById('welcome-signin-form').hidden = false;
    document.getElementById('welcome-title').textContent = WorkRadarOnboardingView.title('signin');
    document.getElementById('welcome-email').focus();
    this.persist({ status: 'in_progress', step: 'signin' }).catch((err) =>
      console.error('onboarding save failed', err)
    );
  },
  showWelcome() {
    this.step = 'welcome';
    document.getElementById('welcome-start-actions').hidden = false;
    document.getElementById('welcome-final-actions').hidden = true;
    document.getElementById('welcome-signin-form').hidden = true;
    document.getElementById('welcome-association').hidden = true;
    document.getElementById('welcome-title').textContent = WorkRadarOnboardingView.title('welcome');
    document.getElementById('welcome-local').focus();
  },
  async submitSignIn() {
    const email = document.getElementById('welcome-email').value.trim();
    const status = document.getElementById('welcome-signin-status');
    if (!email) {
      document.getElementById('welcome-email').focus();
      return;
    }
    if (!Auth.status.configured) {
      status.textContent = 'Cloud sign-in is unavailable in this build. Continue locally.';
      return;
    }
    status.textContent = 'Sending sign-in link…';
    const res = await window.radarAPI.authSignIn(email);
    if (!res || !res.ok) {
      status.textContent = (res && res.error) || 'Sign-in failed. You can continue locally.';
      return;
    }
    status.textContent =
      'Check your inbox. Keep Work Radar running while you open the link on this computer.';
  },
  async importBackup() {
    const imported =
      HAS_API && window.radarAPI.importFull
        ? await Actions.importFull()
        : await Actions.importJSON();
    if (imported) this.finish();
  },
  async chooseLocal() {
    if (HAS_API && window.radarAPI.onboardingChooseLocal)
      await window.radarAPI.onboardingChooseLocal();
    else
      await this.persist({
        status: 'complete',
        step: 'done',
        mode: 'local',
        completedAt: Date.now(),
      });
    this.state = { ...this.state, status: 'complete', step: 'done', mode: 'local' };
    this.showFinal();
  },
  requireAssociation() {
    const overlay = document.getElementById('welcome-overlay');
    if (!overlay) return;
    this.bindHandlers();
    overlay.hidden = false;
    document.getElementById('app').inert = true;
    document.getElementById('welcome-start-actions').hidden = true;
    document.getElementById('welcome-signin-form').hidden = true;
    document.getElementById('welcome-final-actions').hidden = true;
    document.getElementById('welcome-association').hidden = false;
    document.getElementById('welcome-title').textContent = 'ASSOCIATE LOCAL PROJECTS';
    document.getElementById('welcome-associate').focus();
  },
  async associate(separate = false) {
    const status = document.getElementById('welcome-association-status');
    try {
      const result = separate
        ? await window.radarAPI.profileUseSeparate()
        : await window.radarAPI.profileAssociate();
      if (!result || !result.ok) {
        status.textContent = (result && result.error) || 'Could not associate this profile';
        return;
      }
      document.getElementById('welcome-association').hidden = true;
      await window.radarAPI.onboardingMarkSignedIn();
      this.finish();
    } catch (err) {
      console.error('profile association failed', err);
      status.textContent = 'Could not associate this profile';
    }
  },
  showFinal() {
    document.getElementById('welcome-association').hidden = true;
    document.getElementById('welcome-start-actions').hidden = true;
    document.getElementById('welcome-signin-form').hidden = true;
    document.getElementById('welcome-final-actions').hidden = false;
    document.getElementById('welcome-title').textContent = 'READY WHEN YOU ARE';
    document.getElementById('welcome-create').focus();
  },
  reopen() {
    const overlay = document.getElementById('welcome-overlay');
    if (!overlay) return;
    this.showWelcome();
    overlay.hidden = false;
    document.getElementById('app').inert = true;
  },
  finish() {
    document.getElementById('welcome-overlay').hidden = true;
    document.getElementById('app').inert = false;
  },
};

const Settings = {
  open() {
    Account.close();
    const list = document.getElementById('category-list');
    list.replaceChildren();
    for (const name of D.categoryOptions(Store)) this.addRow(name);
    this.updateEmptyState();
    document.getElementById('settings-dialog').showModal();
    (list.querySelector('input') || document.getElementById('category-add')).focus();
  },
  close() {
    const dialog = document.getElementById('settings-dialog');
    if (dialog.open) dialog.close();
  },
  updateEmptyState() {
    document.getElementById('category-empty').hidden =
      document.getElementById('category-list').childElementCount > 0;
  },
  addRow(name = '') {
    const row = node('div', 'category-row');
    const input = node('input');
    input.value = name;
    input.required = true;
    input.autocomplete = 'off';
    input.placeholder = 'Category name';
    input.setAttribute('aria-label', 'Category name');
    input.addEventListener('input', () => {
      document
        .querySelectorAll('#category-list input')
        .forEach((field) => field.setCustomValidity(''));
    });
    const remove = button(
      'Delete',
      () => {
        const next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        document
          .querySelectorAll('#category-list input')
          .forEach((field) => field.setCustomValidity(''));
        this.updateEmptyState();
        (next?.querySelector('input') || document.getElementById('category-add')).focus();
      },
      'form-act danger'
    );
    row.append(input, remove);
    document.getElementById('category-list').append(row);
    this.updateEmptyState();
    return input;
  },
  save(event) {
    event.preventDefault();
    const inputs = [...document.querySelectorAll('#category-list input')];
    const seen = new Set();
    for (const input of inputs) {
      const key = input.value.trim().toLowerCase();
      input.setCustomValidity(
        !key ? 'Enter a category name.' : seen.has(key) ? 'This category is already listed.' : ''
      );
      seen.add(key);
    }
    if (!document.getElementById('settings-form').reportValidity()) return;
    if (loadFailed) {
      alert(
        'Settings cannot be saved until your project data loads successfully. Restart the app.'
      );
      return;
    }
    Store.categoryOptions = D.normalizeCategories(inputs.map((input) => input.value));
    if (Store.ui.showForm) fillCategories(document.getElementById('f-cat').value);
    commit();
    this.close();
  },
};

const Briefing = {
  preferences: null,
  signedIn: false,
  async open() {
    const overlay = document.getElementById('briefing-overlay');
    if (!overlay) return;
    overlay.hidden = false;
    document.getElementById('app').inert = true;
    const response =
      HAS_API && window.radarAPI.briefingPreferences
        ? await window.radarAPI.briefingPreferences()
        : {
            preferences: {
              enabled: false,
              time: '08:00',
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
            },
            signedIn: false,
          };
    const prefs = response?.preferences || response;
    this.preferences = prefs;
    this.signedIn = response?.signedIn === true;
    document.getElementById('briefing-test').disabled = !this.signedIn;
    this.renderCloudStatus(response);
    this.renderDeliveryStatus(response);
    this.fill(prefs);
    await this.preview();
  },
  close() {
    document.getElementById('briefing-overlay').hidden = true;
    document.getElementById('app').inert = false;
  },
  fill(prefs) {
    document.getElementById('briefing-enabled').checked = prefs.enabled === true;
    document.getElementById('briefing-time').value = prefs.time || '08:00';
    document.getElementById('briefing-timezone').value =
      prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.querySelectorAll('#briefing-days input').forEach((input) => {
      input.checked = prefs.weekdays.includes(input.value);
    });
  },
  values() {
    return {
      enabled: document.getElementById('briefing-enabled').checked,
      time: document.getElementById('briefing-time').value,
      timezone: document.getElementById('briefing-timezone').value.trim(),
      weekdays: [...document.querySelectorAll('#briefing-days input:checked')].map(
        (input) => input.value
      ),
    };
  },
  showError(message) {
    const error = document.getElementById('briefing-error');
    error.textContent = message || '';
    error.hidden = !message;
  },
  renderCloudStatus(response = {}) {
    const cloud = document.getElementById('briefing-cloud-status');
    if (!response.signedIn) {
      cloud.textContent = 'Sign in with a verified email to send a test briefing.';
      return;
    }
    cloud.textContent = response.cloudError || 'Cloud briefing settings are connected.';
  },
  deliveryLabel(delivery, label) {
    if (!delivery) return '';
    const prefix = label ? label + ': ' : '';
    if (delivery.state === 'sent') return prefix + 'Sent';
    if (delivery.state === 'skipped') {
      const reason = {
        empty: 'nothing due',
        disabled: 'briefing disabled',
        unverified_email: 'verified email unavailable',
      }[delivery.reason];
      return prefix + 'Skipped' + (reason ? ' — ' + reason : '');
    }
    if (delivery.state === 'failed')
      return prefix + 'Failed' + (delivery.error ? ' — ' + delivery.error : '');
    return prefix + (delivery.state || 'Pending');
  },
  renderDeliveryStatus(response = {}) {
    const status = document.getElementById('briefing-delivery-status');
    const values = [
      this.deliveryLabel(response.latestTest, 'Latest test'),
      this.deliveryLabel(response.latestDelivery, 'Latest scheduled delivery'),
    ].filter(Boolean);
    status.textContent = values.join(' · ');
  },
  async preview() {
    const preview = document.getElementById('briefing-preview');
    this.showError('');
    if (!HAS_API || !window.radarAPI.briefingPreview) {
      preview.textContent = 'Preview is available in the desktop app.';
      return;
    }
    try {
      const result = await window.radarAPI.briefingPreview({ preferences: this.values() });
      if (!result || !result.ok || !result.briefing) {
        preview.textContent = 'Preview unavailable.';
        this.showError((result && result.error) || 'Could not load briefing preview');
        return;
      }
      const view = WorkRadarBriefingView.formatPreview(result.briefing);
      preview.replaceChildren();
      preview.append(node('strong', '', view.heading));
      view.rows.forEach((row) => {
        const line = node(
          'p',
          '',
          row.name + ' — ' + row.reason + (row.waitingOn ? ' · Waiting on ' + row.waitingOn : '')
        );
        preview.append(line);
      });
      preview.append(
        node(
          'small',
          '',
          'Preview uses this device’s saved projects; cloud email uses synced projects. Timezone: ' +
            result.briefing.timezone
        )
      );
    } catch (err) {
      preview.textContent = 'Preview unavailable.';
      this.showError('Could not load briefing preview');
      console.error('briefing preview failed', err);
    }
  },
  async save(event, { close = true } = {}) {
    event?.preventDefault();
    const result = await window.radarAPI.briefingSetPreferences(this.values());
    if (!result || !result.ok) {
      this.showError((result && result.error) || 'Could not save briefing settings');
      return result;
    }
    this.signedIn = result.signedIn === true;
    this.renderCloudStatus(result);
    if (this.signedIn && !result.cloudSynced) {
      this.showError(
        result.cloudError || 'Settings were saved locally but not synced to your account.'
      );
      return result;
    }
    this.showError('');
    if (close) this.close();
    return result;
  },
  async testSend() {
    const saved = await this.save(null, { close: false });
    if (!saved || !saved.ok || (saved.signedIn && !saved.cloudSynced)) return;
    const button = document.getElementById('briefing-test');
    button.disabled = true;
    this.showError('');
    try {
      const result = await window.radarAPI.briefingTest();
      if (!result || result.status === 'failed' || !result.ok) {
        this.showError((result && result.error) || 'Test delivery failed');
      } else if (result.status === 'skipped') {
        const reason = {
          empty: 'nothing is due today',
          disabled: 'briefing is disabled',
          unverified_email: 'a verified email is unavailable',
        }[result.reason];
        this.showError('Test skipped' + (reason ? ' — ' + reason : '') + '.');
      } else {
        this.showError('Test email sent.');
      }
      const response = await window.radarAPI.briefingPreferences();
      this.renderDeliveryStatus(response || {});
    } catch (err) {
      this.showError('Test delivery failed');
      console.error('briefing test failed', err);
    } finally {
      button.disabled = !this.signedIn;
    }
  },
  wire() {
    document.getElementById('briefing-close').onclick = () => this.close();
    document.getElementById('briefing-refresh').onclick = () => this.preview();
    document.getElementById('briefing-test').onclick = () => this.testSend();
    document.getElementById('briefing-form').onsubmit = (event) => this.save(event);
  },
};
// Sync key prompt
const SyncConfigPrompt = {
  isOpen() {
    const overlay = document.getElementById('sync-key-overlay');
    return !!overlay && !overlay.hidden;
  },
  async init() {
    if (!HAS_API || !window.radarAPI.syncConfigNeedsKey) return;
    // Finish onboarding before showing sync configuration.
    if (window.radarAPI.onboardingGet) {
      try {
        const onboarding = await window.radarAPI.onboardingGet();
        if (!onboarding || onboarding.status !== 'complete' || onboarding.mode === 'local') return;
      } catch (err) {
        console.error('onboarding state unavailable; delaying sync prompt', err);
        return;
      }
    }
    let needsKey = false;
    try {
      needsKey = await window.radarAPI.syncConfigNeedsKey();
    } catch (err) {
      console.error('syncConfigNeedsKey failed', err);
      return;
    }
    if (!needsKey) return;
    document.getElementById('sync-key-overlay').hidden = false;
    // The modal also needs inert to block background interaction.
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
    // Return focus to the invalid field.
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

// Sync status
const Sync = {
  init() {
    if (!HAS_API || !window.radarAPI.onSyncStateChanged) return;
    window.radarAPI.onSyncStateChanged((status) => this.render(status));
    if (window.radarAPI.onSyncReload) {
      window.radarAPI.onSyncReload(() => this.reload());
    }
    // Recover status events emitted before the renderer subscribed.
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
      // Merge the same profile; replace state when switching profiles.
      const fromDisk = await Persist.load();
      if (
        fromDisk &&
        Number.isFinite(Number(fromDisk.schema)) &&
        Number(fromDisk.schema) > D.SCHEMA
      )
        throw new Error('This data file was created by a newer version of Work Radar.');
      if (fromDisk) {
        const profileChanged =
          Object.hasOwn(fromDisk, 'profileId') && fromDisk.profileId !== Store.profileId;
        if (profileChanged) detailDrafts.clear();
        const merged = profileChanged
          ? {
              items: D.migrate(Array.isArray(fromDisk.items) ? fromDisk.items : []),
              arch: D.migrate(Array.isArray(fromDisk.arch) ? fromDisk.arch : []),
              lastExport: fromDisk.lastExport || 0,
              itemRevisions: Array.isArray(fromDisk.itemRevisions) ? fromDisk.itemRevisions : [],
              attachments: Array.isArray(fromDisk.attachments) ? fromDisk.attachments : [],
              attachmentRecords: Array.isArray(fromDisk.attachmentRecords)
                ? fromDisk.attachmentRecords
                : [],
              profileId: fromDisk.profileId ?? null,
              categoryOptions: fromDisk.categoryOptions ?? null,
            }
          : D.mergeDiskIntoStore(fromDisk, Store);
        Store.items = merged.items;
        Store.arch = merged.arch;
        Store.lastExport = merged.lastExport;
        Store.itemRevisions = Array.isArray(merged.itemRevisions)
          ? merged.itemRevisions
          : Store.itemRevisions;
        Store.attachments = Array.isArray(merged.attachments)
          ? merged.attachments
          : Store.attachments;
        Store.attachmentRecords = Array.isArray(merged.attachmentRecords)
          ? merged.attachmentRecords
          : Store.attachmentRecords;
        Store.profileId = merged.profileId ?? null;
        Store.categoryOptions = merged.categoryOptions ?? null;
      } else {
        clearRendererProfile();
      }
      render();
    } catch (err) {
      console.error('reload after sync merge failed', err);
    }
  },
};

// Selectors
function recoveryItems() {
  const current = new Map(
    [...Store.items, ...Store.arch].filter((item) => item.deletedAt).map((item) => [item.id, item])
  );
  for (const revision of Store.itemRevisions || []) {
    if (!revision || !revision.itemId || !revision.snapshot || !revision.snapshot.deletedAt)
      continue;
    if (!current.has(revision.itemId))
      current.set(revision.itemId, { ...revision.snapshot, id: revision.itemId, log: [] });
  }
  return [...current.values()].sort(
    (a, b) => (b.deletedAt || 0) - (a.deletedAt || 0) || a.name.localeCompare(b.name)
  );
}
function visibleList() {
  return Store.ui.view === 'recovery' ? recoveryItems() : D.selectVisible(Store);
}

// Rendering
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
const RADAR_CATEGORY_COLORS = [
  '#00e676',
  '#26c6da',
  '#ff9100',
  '#ab47bc',
  '#ffee58',
  '#42a5f5',
  '#ec407a',
  '#66bb6a',
  '#ff7043',
  '#7e57c2',
  '#26a69a',
  '#d4e157',
];
const RADAR_UNCATEGORIZED_COLOR = '#78909c';

function radarCategoryColors(items) {
  const categories = D.normalizeCategories(items.map((item) => item.category));
  return new Map(
    categories.map((category, index) => [
      category,
      RADAR_CATEGORY_COLORS[index % RADAR_CATEGORY_COLORS.length],
    ])
  );
}

function selectProject(item) {
  Store.ui.sel = Store.ui.sel === item.id ? null : item.id;
  Store.ui.showForm = false;
  render();
  if (Store.ui.sel) document.getElementById('detail-close').focus();
}

function closeDetail() {
  const selectedId = Store.ui.sel;
  Store.ui.sel = null;
  render();
  const target = [...document.querySelectorAll('[data-item-id]')].find(
    (element) => element.dataset.itemId === selectedId && element.getClientRects().length
  );
  (target || document.querySelector('.tab.active')).focus();
}

function renderRadar() {
  const items = stripTombstones(Store.items);
  const blips = document.getElementById('radar-blips');
  const legend = document.getElementById('radar-legend');
  const layout = document.getElementById('radar-layout');
  const empty = document.getElementById('radar-empty');
  blips.replaceChildren();
  legend.replaceChildren();
  layout.hidden = items.length === 0;
  empty.hidden = items.length > 0;
  if (!items.length) return;

  const colors = radarCategoryColors(items);
  const colorsByKey = new Map(
    [...colors.entries()].map(([category, color]) => [category.toLowerCase(), color])
  );
  const categoryName = (item) => (typeof item.category === 'string' ? item.category.trim() : '');
  const categoryLabel = (item) => categoryName(item) || 'No category';
  const categoryColor = (item) =>
    categoryName(item)
      ? colorsByKey.get(categoryName(item).toLowerCase()) || RADAR_UNCATEGORIZED_COLOR
      : RADAR_UNCATEGORIZED_COLOR;

  items.forEach((item) => {
    const point = D.blipXY(item);
    const review = D.reviewDate(item);
    const reviewText = review ? 'Review ' + dateLabel(review) : 'No review scheduled';
    const blip = node('button', 'radar-blip' + (Store.ui.sel === item.id ? ' selected' : ''));
    blip.classList.toggle('label-left', point.x > D.CX);
    blip.type = 'button';
    blip.dataset.itemId = item.id;
    blip.setAttribute('aria-controls', 'detail-panel');
    blip.style.left = (point.x / (D.CX * 2)) * 100 + '%';
    blip.style.top = (point.y / (D.CY * 2)) * 100 + '%';
    blip.style.setProperty('--category-color', categoryColor(item));
    blip.setAttribute(
      'aria-label',
      `${item.name}, ${item.priority} priority, ${categoryLabel(item)}, ${reviewText}`
    );
    blip.setAttribute('aria-pressed', String(Store.ui.sel === item.id));
    blip.title = `${item.name} · ${item.priority} · ${categoryLabel(item)} · ${reviewText}`;
    blip.addEventListener('click', () => selectProject(item));
    blip.append(node('span', 'radar-blip-core'), node('span', 'radar-blip-label', item.name));
    blips.append(blip);
  });

  legend.append(node('h2', 'eyebrow', 'Categories'));
  const legendEntries = [...colors.entries()];
  if (items.some((item) => !categoryName(item)))
    legendEntries.push(['No category', RADAR_UNCATEGORIZED_COLOR]);
  legendEntries.forEach(([category, color]) => {
    const row = node('div', 'radar-legend-row');
    const swatch = node('span', 'radar-legend-swatch');
    swatch.style.background = color;
    row.append(swatch, node('span', '', category));
    legend.append(row);
  });
}
function renderDetail() {
  const panel = document.getElementById('detail-panel');
  const active = document.activeElement;
  const focusId = panel.contains(active) ? active.id : '';
  const selection =
    active.selectionStart == null ? null : [active.selectionStart, active.selectionEnd];
  const inspector = document.getElementById('inspector');
  const scrollTop = inspector.scrollTop;
  renderDetailContent();
  const target = focusId && document.getElementById(focusId);
  if (!panel.hidden && target) {
    target.focus({ preventScroll: true });
    if (selection && target.setSelectionRange) target.setSelectionRange(...selection);
  }
  inspector.scrollTop = scrollTop;
}
function renderDetailContent() {
  const panel = document.getElementById('detail-panel');
  const it = (
    Store.ui.view === 'recovery'
      ? recoveryItems()
      : [...stripTombstones(Store.items), ...stripTombstones(Store.arch)]
  ).find((i) => i.id === Store.ui.sel);
  panel.hidden = !it || Store.ui.showForm;
  document
    .getElementById('body')
    .classList.toggle('viewing-radar-project', Store.ui.view === 'radar' && !panel.hidden);
  document.getElementById('inspector').hidden = !it && !Store.ui.showForm;
  if (panel.hidden) return;
  const draft = detailDraft(it.id);
  if (Store.ui.view === 'recovery') {
    document.getElementById('detail-name').textContent = it.name;
    document
      .getElementById('detail-meta')
      .replaceChildren(node('span', '', 'Deleted ' + fdt(it.deletedAt)));
    document
      .getElementById('detail-context')
      .replaceChildren(
        node(
          'p',
          'field-help',
          'This project remains recoverable because its edit history is retained.'
        )
      );
    document.getElementById('detail-notes').hidden = true;
    document.getElementById('detail-schedule').replaceChildren();
    const actions = document.getElementById('detail-actions');
    actions.replaceChildren(
      button(
        'Restore latest version',
        () => {
          const revisions = Store.itemRevisions
            .filter((revision) => revision.itemId === it.id)
            .sort(
              (a, b) =>
                (b.serverReceivedAt || b.clientTime || 0) -
                (a.serverReceivedAt || a.clientTime || 0)
            );
          const latest = revisions.find((revision) => !revision.snapshot?.deletedAt);
          if (
            latest &&
            confirm('Restore the latest recoverable version of this deleted project?')
          ) {
            Actions.restoreRevision(it.id, latest);
            Store.ui.view = latest.snapshot?.archivedAt ? 'archive' : 'all';
            render();
          }
        },
        'primary'
      )
    );
    renderHistory(it);
    document.getElementById('detail-attachments').replaceChildren();
    return;
  }
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
    date.id = 'review-custom-date';
    select.value = draft.reviewChoice;
    date.value = draft.reviewDate;
    date.hidden = select.value !== 'custom';
    date.required = !date.hidden;
    date.addEventListener('input', () => {
      draft.reviewDate = date.value;
    });
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
    snooze.id = 'review-snooze';
    snooze.disabled = select.value === 'rhythm';
    select.addEventListener('change', () => {
      draft.reviewChoice = select.value;
      date.hidden = select.value !== 'custom';
      date.required = !date.hidden;
      snooze.disabled = select.value === 'rhythm';
      if (!date.hidden) date.focus();
    });
    const controls = node('div', 'review-controls');
    controls.append(select, date);
    const reviewActions = node('div', 'review-actions');
    const reviewed = button(
      'Reviewed',
      () => {
        if (validChoice()) Actions.review(it.id, chosenDate());
      },
      'primary'
    );
    reviewed.id = 'review-submit';
    reviewActions.append(reviewed, snooze);
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
  renderHistory(it);
  renderAttachments(it).catch((err) => console.error('attachment list failed', err));
  const compose = document.getElementById('detail-log-compose');
  compose.replaceChildren();
  if (!it.archivedAt) {
    const input = node('input', 'detail-log-input');
    input.id = 'detail-update';
    input.value = draft.note;
    input.addEventListener('input', () => {
      draft.note = input.value;
    });
    input.placeholder = 'Add a status update…';
    input.setAttribute('aria-label', 'Status update');
    const submit = () => {
      if (!input.value.trim()) return;
      const text = input.value.trim();
      draft.note = '';
      Actions.addLogEntry(it.id, text);
      document.getElementById('detail-update').focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    const addUpdate = button('Add update', submit);
    addUpdate.id = 'detail-update-submit';
    compose.append(input, addUpdate);
  }
}
function renderHistory(item) {
  const host = document.getElementById('detail-history');
  if (!host) return;
  host.replaceChildren();
  const revisions = Store.itemRevisions
    .filter((revision) => revision.itemId === item.id)
    .sort((a, b) => (b.clientTime || 0) - (a.clientTime || 0));
  host.append(node('h3', 'eyebrow', 'History · ' + revisions.length + ' saved versions'));
  if (!revisions.length) {
    host.append(node('p', 'field-help', 'History starts with the next saved change.'));
    return;
  }
  revisions.slice(0, 100).forEach((revision) => {
    const row = node('div', 'history-row');
    const label = node(
      'button',
      'history-version',
      (revision.action || 'edit') + ' · ' + fdt(revision.clientTime)
    );
    label.type = 'button';
    label.addEventListener('click', () => {
      const compare = document.getElementById('history-compare');
      compare.replaceChildren();
      const snapshot = revision.snapshot || {};
      Object.keys({ ...snapshot, ...item })
        .filter(
          (key) =>
            !['log', 'id'].includes(key) &&
            JSON.stringify(snapshot[key]) !== JSON.stringify(item[key])
        )
        .sort()
        .forEach((field) => {
          const change = node(
            'p',
            '',
            field + ': ' + String(snapshot[field] ?? '—') + ' → ' + String(item[field] ?? '—')
          );
          compare.append(change);
        });
      if (!compare.childNodes.length)
        compare.append(node('p', 'field-help', 'This version matches the current project.'));
    });
    row.append(
      label,
      node(
        'span',
        'history-state',
        revision.status === 'pending'
          ? 'Pending sync'
          : revision.status === 'superseded'
            ? 'Superseded'
            : revision.action === 'restore'
              ? 'Restored'
              : 'Saved'
      )
    );
    const restore = button(
      'Restore',
      () => {
        if (confirm('Restore this version as a new edit?')) {
          Actions.restoreRevision(item.id, revision);
          renderDetail();
        }
      },
      'quiet'
    );
    restore.disabled = Boolean(revision.snapshot?.deletedAt);
    if (restore.disabled) restore.title = 'Deleted snapshots cannot be restored directly';
    row.append(restore);
    host.append(row);
  });
  host.append(node('div', 'history-compare'));
  host.lastChild.id = 'history-compare';
}

async function renderAttachments(item) {
  const host = document.getElementById('detail-attachments');
  if (!host) return;
  host.replaceChildren(node('h3', 'eyebrow', 'Attachments'));
  const add = button(
    '+ Add file',
    async () => {
      if (!HAS_API || !window.radarAPI.attachmentsPickAdd) return;
      const result = await window.radarAPI.attachmentsPickAdd(item.id);
      if (result && !result.ok && !result.canceled) alert('ATTACHMENT FAILED — ' + result.error);
      if (result?.ok && window.radarAPI.attachmentsProcessQueue)
        await window.radarAPI.attachmentsProcessQueue();
      renderAttachments(item);
    },
    'quiet'
  );
  host.append(add);
  if (!HAS_API || !window.radarAPI.attachmentsList) {
    host.append(node('p', 'field-help', 'Attachments are available in the desktop app.'));
    return;
  }
  const result = await window.radarAPI.attachmentsList(item.id);
  if (!result || !result.ok || !result.attachments.length) {
    host.append(node('p', 'field-help', 'No files attached.'));
    return;
  }
  result.attachments.forEach((attachment) => {
    const row = node('div', 'attachment-row');
    const info = node(
      'span',
      'attachment-info',
      attachment.displayName + ' · ' + Math.ceil(attachment.byteSize / 1024) + ' KB'
    );
    const state = node(
      'span',
      'attachment-state',
      attachment.ownerId ? attachment.status || 'pending' : 'On this device'
    );
    const open = button(
      'Open',
      async () => {
        const opened = await window.radarAPI.attachmentsOpen(attachment.id);
        if (opened && !opened.ok) alert('ATTACHMENT UNAVAILABLE — ' + opened.error);
      },
      'quiet'
    );
    const remove = button(
      'Remove',
      async () => {
        if (confirm('Remove this attachment?')) {
          await window.radarAPI.attachmentsRemove(attachment.id);
          renderAttachments(item);
        }
      },
      'quiet'
    );
    row.append(info, state, open, remove);
    host.append(row);
  });
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
    row.dataset.itemId = item.id;
    row.setAttribute('aria-expanded', String(Store.ui.sel === item.id));
    row.setAttribute('aria-controls', 'detail-panel');
    row.addEventListener('click', () => selectProject(item));
    const main = node('div', 'contact-main');
    const left = node('div', 'contact-left');
    const dot = node('span', 'contact-dot');
    dot.style.background = item.archivedAt ? '#546e7a' : PC[item.priority];
    left.append(dot, node('span', 'contact-name', item.name));
    const right = node(
      'span',
      'contact-right',
      Store.ui.view === 'recovery' ? 'Deleted' : item.archivedAt ? 'Archived' : item.status
    );
    right.style.color =
      Store.ui.view === 'recovery' ? '#8b4b4b' : item.archivedAt ? '#546e7a' : SC[item.status];
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
  const radar = Store.ui.view === 'radar';
  const archive = Store.ui.view === 'archive';
  const recovery = Store.ui.view === 'recovery';
  document.getElementById('body').classList.toggle('editing-project', Store.ui.showForm);
  document.getElementById('today-count').textContent = stripTombstones(Store.items).filter((i) =>
    D.isDueToday(i)
  ).length;
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.view === Store.ui.view || (archive && t.dataset.view === 'all');
    t.classList.toggle('active', active);
    t.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('all-controls').hidden = today || radar || recovery;
  document.getElementById('filter').hidden = archive || recovery;
  document.getElementById('archive-btn').hidden = today || radar || recovery;
  document.getElementById('archive-btn').textContent = archive ? '← All projects' : 'Archive';
  document.getElementById('view-title').textContent = today
    ? "Today's radar"
    : radar
      ? 'Radar'
      : recovery
        ? 'Recovery'
        : archive
          ? 'Archive'
          : 'All projects';
  document.getElementById('view-subtitle').textContent = today
    ? 'What needs your attention, and why.'
    : radar
      ? 'Priority and review timing, seen at a glance.'
      : recovery
        ? 'Deleted projects with retained history can be restored here.'
        : archive
          ? 'Finished for now. Restore a project whenever you need it.'
          : 'Everything you’re keeping in sight.';
  document.getElementById('view-date').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  document.getElementById('kbd-hint').textContent = Store.ui.showForm
    ? 'Ctrl/Cmd+Enter save · Esc cancel'
    : 'N new · / search · ' +
      (Store.ui.view === 'all' ? 'E edit · ' : '') +
      'R reviewed · Esc close';
  document.getElementById('form-panel').hidden = !Store.ui.showForm;
  document.getElementById('list').hidden = radar;
  document.getElementById('radar-view').hidden = !radar;
  if (radar) renderRadar();
  else renderList();
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

// Project form
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

function fillCategories(selected = '') {
  const select = document.getElementById('f-cat');
  const names = D.categoryOptions(Store);
  const choices = [
    node('option', '', 'No category'),
    ...names.map((name) => node('option', '', name)),
  ];
  choices[0].value = '';
  if (selected && !names.includes(selected)) {
    const current = node('option', '', selected + ' (current)');
    current.value = selected;
    choices.push(current);
  }
  select.replaceChildren(...choices);
  select.value = selected;
}

function openAdd() {
  Store.ui.showForm = true;
  Store.ui.editId = null;
  Store.ui.sel = null;
  document.getElementById('form-label').textContent = 'New project';
  document.getElementById('form-save').textContent = 'Create project';
  document.getElementById('f-name').value = '';
  fillCategories();
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
  fillCategories(it.category || '');
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

// Event wiring
function wire() {
  document.getElementById('settings-open').addEventListener('click', () => Settings.open());
  document.getElementById('category-manage').addEventListener('click', () => Settings.open());
  document
    .getElementById('category-add')
    .addEventListener('click', () => Settings.addRow().focus());
  document.getElementById('settings-cancel').addEventListener('click', () => Settings.close());
  document
    .getElementById('settings-form')
    .addEventListener('submit', (event) => Settings.save(event));
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
  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.querySelectorAll('[data-review-days]').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById('f-review').value = dateAfter(Number(button.dataset.reviewDays));
    });
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
  document.getElementById('export-full-btn').addEventListener('click', () => Actions.exportFull());
  document.getElementById('import-full-btn').addEventListener('click', () => Actions.importFull());
  document.getElementById('import-btn').addEventListener('click', () => Actions.importJSON());
  if (HAS_API && window.radarAPI.attachmentsProcessQueue) {
    const refreshAttachments = () => {
      const refresh = window.radarAPI.attachmentsRefresh?.();
      const queue = window.radarAPI.attachmentsProcessQueue?.();
      Promise.allSettled([refresh, queue]).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected')
            console.error('attachment refresh failed', result.reason);
        }
      });
    };
    window.addEventListener('focus', refreshAttachments);
    if (typeof window.setInterval === 'function') window.setInterval(refreshAttachments, 60000);
  }

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
        const imported = Actions.mergeImported(parsed);
        if (imported && Onboarding.state && Onboarding.state.status !== 'complete')
          Onboarding.finish();
      } catch (err) {
        console.error('import merge failed', err);
        alert('IMPORT FAILED — the file merged with unexpected data. See console for details.');
      }
    };
    r.readAsText(f);
    e.target.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (document.getElementById('settings-dialog').open) return;
    // Disable app shortcuts while the modal is open.
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
        closeDetail();
      }
      return;
    }
    if (Store.ui.showForm && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
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
    else if (['r', 'R', 'p', 'P'].includes(e.key) && sel && !sel.archivedAt)
      document.getElementById('review-submit')?.click();
    else if ((e.key === 'a' || e.key === 'A') && sel && !sel.archivedAt) Actions.archive(sel.id);
  });

  if (HAS_API && window.radarAPI.onMenu) {
    window.radarAPI.onMenu((action) => {
      if (document.getElementById('settings-dialog').open) return;
      if (action === 'new') openAdd();
      else if (action === 'search') focusSearch();
      else if (action === 'export') Actions.exportJSON();
      else if (action === 'exportPDF') Actions.exportPDF();
      else if (action === 'exportFull') Actions.exportFull();
      else if (action === 'import') Actions.importJSON();
      else if (action === 'importFull') Actions.importFull();
      else if (action === 'reveal' && window.radarAPI.revealBackups)
        window.radarAPI.revealBackups();
      else if (action === 'welcome') Onboarding.reopen();
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
    if (Store.ui.view === 'radar') renderRadar();
    else renderList(); // Keep any draft form, review choice, or activity update intact.
    renderedDay = D.localDate();
  };
  window.addEventListener('focus', refreshAttention);
  setInterval(() => {
    if (renderedDay !== D.localDate()) refreshAttention();
  }, 30000);
}

// Boot
(async function boot() {
  wire();
  await Auth.init().catch((err) => console.error('Auth.init failed', err));
  Briefing.wire();
  Sync.init();
  SyncConfigPrompt.init().catch((err) => console.error('SyncConfigPrompt.init failed', err));
  try {
    await Store.load();
  } catch (err) {
    // Never save after a failed load; the in-memory store may be incomplete.
    loadFailed = true;
    console.error('Store.load failed — refusing to save until the app is restarted', err);
    alert(
      'LOAD FAILED — your data could not be read. Changes will NOT be saved.\n' +
        'Restart the app; if this keeps happening, check the console and your data file.'
    );
  }
  render();
  Onboarding.init().catch((err) => console.error('Onboarding.init failed', err));
})();
