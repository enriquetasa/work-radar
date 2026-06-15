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
const { PC, SC, CX, CY, R, BACKUP_DAYS, uid, fdt, daysSince, isStale, blipXY } = D;
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
    view: 'live',
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
    this.items = D.migrate(Array.isArray(d.items) ? d.items : []);
    this.arch = D.migrate(Array.isArray(d.arch) ? d.arch : []);
    this.lastExport = d.lastExport || 0;
  },
  serialize() {
    return D.serialize(this);
  },
};

/* ---------- Debounced save ---------- */
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => Persist.save(Store.serialize()), 120);
}
function commit() {
  scheduleSave();
  render();
}

/* ---------- Actions ---------- */
const Actions = {
  add(v) {
    const now = Date.now();
    Store.items.push({ id: uid(), ...v, addedAt: now, updatedAt: now, reviewedAt: now });
    commit();
  },
  update(id, v) {
    Store.items = Store.items.map((i) => (i.id === id ? { ...i, ...v, updatedAt: Date.now() } : i));
    commit();
  },
  ping(id) {
    Store.items = Store.items.map((i) => (i.id === id ? { ...i, reviewedAt: Date.now() } : i));
    commit();
  },
  archive(id) {
    const it = Store.items.find((i) => i.id === id);
    if (!it) return;
    Store.arch.unshift({ ...it, archivedAt: Date.now() });
    Store.items = Store.items.filter((i) => i.id !== id);
    if (Store.ui.sel === id) Store.ui.sel = null;
    commit();
  },
  restore(id) {
    const it = Store.arch.find((i) => i.id === id);
    if (!it) return;
    const { archivedAt, ...rest } = it;
    rest.reviewedAt = Date.now();
    Store.items.push(rest);
    Store.arch = Store.arch.filter((i) => i.id !== id);
    commit();
  },
  purge(id) {
    Store.arch = Store.arch.filter((i) => i.id !== id);
    if (Store.ui.sel === id) Store.ui.sel = null;
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

  mergeImported(d) {
    const inItems = D.migrate(Array.isArray(d.items) ? d.items : []);
    const inArch = D.migrate(Array.isArray(d.arch) ? d.arch : []);
    if (!inItems.length && !inArch.length) {
      alert('NO CONTACTS FOUND IN FILE.');
      return;
    }
    if (
      !confirm(
        'MERGE ' +
          inItems.length +
          ' live + ' +
          inArch.length +
          ' archived contacts?\nMatching IDs are overwritten; the rest added.'
      )
    )
      return;
    Store.items = D.mergeById(Store.items, inItems);
    Store.arch = D.mergeById(Store.arch, inArch);
    Store.ui.sel = null;
    commit();
  },

  async importJSON() {
    if (HAS_API) {
      const d = await window.radarAPI.import();
      if (!d) return;
      this.mergeImported(d);
    } else {
      document.getElementById('import-file').click();
    }
  },
};

/* ---------- Selectors ---------- */
function visibleList() {
  return D.selectVisible(Store);
}

/* ---------- Render ---------- */
function renderStats() {
  const live = Store.items;
  document.getElementById('s-crit').textContent = live.filter(
    (i) => i.priority === 'critical'
  ).length;
  document.getElementById('s-high').textContent = live.filter((i) => i.priority === 'high').length;
  document.getElementById('s-review').textContent = live.filter(isStale).length;
  document.getElementById('s-live').textContent = live.length;
  document.getElementById('s-arch').textContent = Store.arch.length;
  const due = Store.lastExport === 0 ? live.length > 0 : daysSince(Store.lastExport) >= BACKUP_DAYS;
  document.getElementById('backup-warn').style.display = due ? 'inline' : 'none';
}

const SVGNS = 'http://www.w3.org/2000/svg';
function renderBlips() {
  const g = document.getElementById('blips');
  while (g.firstChild) g.removeChild(g.firstChild);
  Store.items.forEach((item) => {
    const pos = blipXY(item),
      col = PC[item.priority],
      isSel = Store.ui.sel === item.id,
      stale = isStale(item);
    const sz = isSel ? 5.5 : 4;
    const grp = document.createElementNS(SVGNS, 'g');
    grp.style.cursor = 'pointer';
    grp.addEventListener('click', () => {
      Store.ui.sel = isSel ? null : item.id;
      render();
    });
    if (isSel) {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', pos.x);
      c.setAttribute('cy', pos.y);
      c.setAttribute('r', 13);
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', col);
      c.setAttribute('stroke-width', '1');
      c.setAttribute('stroke-opacity', '.35');
      c.setAttribute('stroke-dasharray', '3 2');
      grp.appendChild(c);
    }
    if (stale) {
      const ring = document.createElementNS(SVGNS, 'circle');
      ring.setAttribute('cx', pos.x);
      ring.setAttribute('cy', pos.y);
      ring.setAttribute('r', 9);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', '#ff9100');
      ring.setAttribute('stroke-width', '1');
      ring.setAttribute('stroke-dasharray', '2 2');
      ring.classList.add('blink');
      grp.appendChild(ring);
    }
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('x', pos.x - sz);
    rect.setAttribute('y', pos.y - sz);
    rect.setAttribute('width', sz * 2);
    rect.setAttribute('height', sz * 2);
    rect.setAttribute('fill', col);
    rect.setAttribute('fill-opacity', '0.55');
    rect.setAttribute('class', 'blip-rect');
    rect.dataset.deg = pos.deg;
    if (isSel) rect.setAttribute('transform', 'rotate(45,' + pos.x + ',' + pos.y + ')');
    grp.appendChild(rect);
    if (isSel) {
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', pos.x + 11);
      t.setAttribute('y', pos.y + 3);
      t.setAttribute('fill', col);
      t.setAttribute('font-size', '7');
      t.setAttribute('letter-spacing', '1');
      t.textContent = item.name.slice(0, 14).toUpperCase();
      grp.appendChild(t);
    }
    g.appendChild(grp);
  });
}

function renderDetail() {
  const dp = document.getElementById('detail-panel');
  const it = [...Store.items, ...Store.arch].find((i) => i.id === Store.ui.sel);
  if (!it || Store.ui.showForm) {
    dp.style.display = 'none';
    return;
  }
  dp.style.display = 'block';
  document.getElementById('detail-name').textContent = it.name.toUpperCase();
  const meta = document.getElementById('detail-meta');
  meta.innerHTML = '';
  const add = (t, c) => {
    const s = document.createElement('span');
    s.textContent = t;
    s.style.color = c;
    meta.appendChild(s);
  };
  const sep = () => {
    const s = document.createElement('span');
    s.textContent = '│';
    s.style.color = '#152e1a';
    meta.appendChild(s);
  };
  add(it.priority.toUpperCase(), PC[it.priority]);
  sep();
  add(
    it.archivedAt ? 'ARCHIVED' : it.status.toUpperCase(),
    it.archivedAt ? '#546e7a' : SC[it.status]
  );
  if (it.category) {
    sep();
    add(it.category.toUpperCase(), '#2e7d4a');
  }
  if (!it.archivedAt && isStale(it)) {
    sep();
    add('NEEDS REVIEW', '#ff9100');
  }
  const dn = document.getElementById('detail-notes');
  if (it.notes) {
    dn.textContent = it.notes;
    dn.style.display = 'block';
  } else dn.style.display = 'none';
  const rev = it.archivedAt ? '' : '  ·  REVIEWED ' + daysSince(it.reviewedAt) + 'd AGO';
  document.getElementById('detail-date').textContent =
    (it.archivedAt ? 'ARCHIVED ' + fdt(it.archivedAt) : 'ACQUIRED ' + fdt(it.addedAt)) + rev;
  const da = document.getElementById('detail-actions');
  da.innerHTML = '';
  const mk = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'dact ' + cls;
    b.textContent = label;
    b.onclick = fn;
    da.appendChild(b);
  };
  if (!it.archivedAt) {
    mk('PING', 'primary', () => Actions.ping(it.id));
    mk('EDIT', '', () => openEdit(it));
    mk('ARCHIVE', 'muted', () => Actions.archive(it.id));
  } else {
    mk('RESTORE', '', () => Actions.restore(it.id));
    mk('PURGE', 'danger', () => {
      if (confirm('PURGE permanently? This cannot be undone.')) Actions.purge(it.id);
    });
  }
  const cb = document.createElement('button');
  cb.className = 'dact close-btn';
  cb.textContent = '✕';
  cb.onclick = () => {
    Store.ui.sel = null;
    render();
  };
  da.appendChild(cb);
}

function renderList() {
  const list = document.getElementById('list'),
    em = document.getElementById('empty-msg');
  list.querySelectorAll('.contact-row').forEach((el) => el.remove());
  const items = visibleList();
  if (!items.length) {
    em.style.display = 'block';
    em.textContent = Store.ui.search
      ? '— NO MATCHING CONTACTS —'
      : Store.ui.view === 'live'
        ? Store.ui.filter === 'review'
          ? '— NOTHING NEEDS REVIEW —'
          : '— NO CONTACTS ON SCOPE —'
        : '— ARCHIVE LOG EMPTY —';
    return;
  }
  em.style.display = 'none';
  items.forEach((item) => {
    const sel = Store.ui.sel === item.id,
      stale = isStale(item);
    const row = document.createElement('div');
    row.className = 'contact-row';
    if (sel) {
      row.style.borderLeftColor = PC[item.priority];
      row.style.background = '#020e0720';
    }
    row.addEventListener('click', () => {
      Store.ui.sel = sel ? null : item.id;
      render();
    });
    const main = document.createElement('div');
    main.className = 'contact-main';
    const left = document.createElement('div');
    left.className = 'contact-left';
    const dot = document.createElement('div');
    dot.className = 'contact-dot';
    dot.style.background = item.archivedAt ? '#546e7a' : PC[item.priority];
    const name = document.createElement('span');
    name.className = 'contact-name';
    name.textContent = item.name.toUpperCase();
    if (sel) name.style.color = '#69f0ae';
    left.append(dot, name);
    const right = document.createElement('div');
    right.className = 'contact-right';
    if (!item.archivedAt && stale) {
      const r = document.createElement('span');
      r.className = 'stale-tag';
      r.textContent = '⚠' + daysSince(item.reviewedAt) + 'd';
      right.appendChild(r);
    }
    if (item.category) {
      const c = document.createElement('span');
      c.style.color = '#1a4d2e';
      c.textContent = item.category.toUpperCase();
      right.appendChild(c);
    }
    const st = document.createElement('span');
    st.style.color = item.archivedAt ? '#546e7a' : SC[item.status];
    st.textContent = item.archivedAt ? 'ARCH' : item.status.toUpperCase().slice(0, 3);
    right.appendChild(st);
    const pr = document.createElement('span');
    pr.style.color = PC[item.priority];
    pr.textContent = item.priority.toUpperCase().slice(0, 4);
    right.appendChild(pr);
    main.append(left, right);
    row.appendChild(main);
    if (item.notes) {
      const n = document.createElement('div');
      n.className = 'contact-notes';
      n.textContent = item.notes;
      row.appendChild(n);
    }
    list.appendChild(row);
  });
}

function render() {
  renderStats();
  document
    .querySelectorAll('.tab')
    .forEach((t) => t.classList.toggle('active', t.dataset.view === Store.ui.view));
  document.getElementById('filters').style.display = Store.ui.view === 'live' ? 'flex' : 'none';
  document
    .querySelectorAll('.filter-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.filter === Store.ui.filter));
  document.getElementById('footer').style.display = Store.ui.view === 'live' ? 'flex' : 'none';
  document.getElementById('form-panel').style.display = Store.ui.showForm ? 'block' : 'none';
  renderBlips();
  renderDetail();
  renderList();
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
  document.getElementById('form-label').textContent = '◈ NEW CONTACT ACQUISITION';
  document.getElementById('form-save').textContent = 'ACQUIRE  (↵)';
  document.getElementById('f-name').value = '';
  document.getElementById('f-cat').value = '';
  document.getElementById('f-notes').value = '';
  setSeg('status', 'active');
  setSeg('priority', 'medium');
  render();
  setTimeout(() => document.getElementById('f-name').focus(), 40);
}
function openEdit(it) {
  Store.ui.showForm = true;
  Store.ui.editId = it.id;
  document.getElementById('form-label').textContent = '◈ MODIFY CONTACT';
  document.getElementById('form-save').textContent = 'UPDATE  (↵)';
  document.getElementById('f-name').value = it.name;
  document.getElementById('f-cat').value = it.category || '';
  document.getElementById('f-notes').value = it.notes || '';
  setSeg('status', it.status);
  setSeg('priority', it.priority);
  render();
  setTimeout(() => document.getElementById('f-name').focus(), 40);
}
function closeForm() {
  Store.ui.showForm = false;
  Store.ui.editId = null;
  render();
}
function saveForm() {
  const v = {
    name: document.getElementById('f-name').value.trim(),
    category: document.getElementById('f-cat').value.trim(),
    notes: document.getElementById('f-notes').value.trim(),
    status: getSeg('status') || 'active',
    priority: getSeg('priority') || 'medium',
  };
  if (!v.name) {
    document.getElementById('f-name').focus();
    return;
  }
  if (Store.ui.editId) Actions.update(Store.ui.editId, v);
  else Actions.add(v);
  closeForm();
}

/* ---------- Wiring ---------- */
function wire() {
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      Store.ui.view = t.dataset.view;
      Store.ui.sel = null;
      render();
    })
  );
  document.querySelectorAll('.filter-btn').forEach((b) =>
    b.addEventListener('click', () => {
      Store.ui.filter = b.dataset.filter;
      render();
    })
  );
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
  document.getElementById('form-save').addEventListener('click', saveForm);
  document.getElementById('f-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveForm();
  });
  document.getElementById('export-btn').addEventListener('click', () => Actions.exportJSON());
  document.getElementById('import-btn').addEventListener('click', () => Actions.importJSON());
  document.getElementById('import-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        Actions.mergeImported(JSON.parse(r.result));
      } catch (err) {
        console.error('import parse failed', err);
        alert('INVALID FILE — not valid JSON.');
      }
    };
    r.readAsText(f);
    e.target.value = '';
  });

  document.addEventListener('keydown', (e) => {
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
    if (typing) return;
    const sel = [...Store.items, ...Store.arch].find((i) => i.id === Store.ui.sel);
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openAdd();
    } else if (e.key === '/') {
      e.preventDefault();
      document.getElementById('search').focus();
    } else if ((e.key === 'e' || e.key === 'E') && sel && !sel.archivedAt) openEdit(sel);
    else if ((e.key === 'p' || e.key === 'P') && sel && !sel.archivedAt) Actions.ping(sel.id);
    else if ((e.key === 'a' || e.key === 'A') && sel && !sel.archivedAt) Actions.archive(sel.id);
  });

  // Native menu commands (Electron)
  if (HAS_API && window.radarAPI.onMenu) {
    window.radarAPI.onMenu((action) => {
      if (action === 'new') openAdd();
      else if (action === 'search') document.getElementById('search').focus();
      else if (action === 'export') Actions.exportJSON();
      else if (action === 'import') Actions.importJSON();
      else if (action === 'reveal' && window.radarAPI.revealBackups)
        window.radarAPI.revealBackups();
    });
  }

  window.addEventListener('focus', render); // re-evaluate staleness across days
}

/* ---------- Animation + decoration ---------- */
function startClock() {
  const tick = () => {
    document.getElementById('clock').textContent = new Date().toISOString().slice(11, 19) + 'Z';
  };
  setInterval(tick, 1000);
  tick();
}
function startSweep() {
  let sweep = 0;
  const ln = document.getElementById('sweep-line');
  (function loop() {
    sweep = (sweep + 1.5) % 360;
    const rad = ((sweep - 90) * Math.PI) / 180;
    ln.setAttribute('x2', CX + Math.cos(rad) * R);
    ln.setAttribute('y2', CY + Math.sin(rad) * R);
    document.querySelectorAll('.blip-rect').forEach((el) => {
      const diff = (sweep - parseFloat(el.dataset.deg) + 360) % 360;
      el.setAttribute('fill-opacity', diff < 22 && diff > 0 ? '0.85' : '0.55');
    });
    requestAnimationFrame(loop);
  })();
}
function drawTicks() {
  const g = document.getElementById('ticks');
  for (let d = 0; d < 360; d += 30) {
    const rad = ((d - 90) * Math.PI) / 180,
      inner = R * 0.95;
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', CX + Math.cos(rad) * inner);
    l.setAttribute('y1', CY + Math.sin(rad) * inner);
    l.setAttribute('x2', CX + Math.cos(rad) * R);
    l.setAttribute('y2', CY + Math.sin(rad) * R);
    l.setAttribute('stroke', '#152e1a');
    l.setAttribute('stroke-width', '1');
    g.appendChild(l);
  }
}

/* ---------- Boot ---------- */
(async function boot() {
  drawTicks();
  wire();
  startClock();
  startSweep();
  await Store.load();
  render();
})();
