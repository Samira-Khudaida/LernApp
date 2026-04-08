// ── Storage (localStorage + IndexedDB backup) ────────────────────────────────
const DB = {
  // ── IndexedDB setup ────────────────────────────────────────────────────
  _idb: null,

  async _openIDB() {
    if (this._idb) return this._idb;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('lernapp_v1', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
      req.onsuccess  = e => { this._idb = e.target.result; resolve(this._idb); };
      req.onerror    = () => reject(req.error);
    });
  },

  async _idbPut(key, val) {
    try {
      const db = await this._openIDB();
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
    } catch { /* silently ignore – localStorage is still the primary store */ }
  },

  async _idbGet(key) {
    try {
      const db = await this._openIDB();
      return await new Promise(res => {
        const req = db.transaction('kv').objectStore('kv').get(key);
        req.onsuccess = () => res(req.result ?? null);
        req.onerror   = () => res(null);
      });
    } catch { return null; }
  },

  // Called once on startup – restores localStorage from IDB if it was wiped
  async restoreIfNeeded() {
    for (const key of ['la_decks', 'la_cards']) {
      if (!localStorage.getItem(key)) {
        const val = await this._idbGet(key);
        if (val) localStorage.setItem(key, JSON.stringify(val));
      }
    }
  },

  // ── Public API (synchronous, same interface as before) ──────────────────
  get decks() { return JSON.parse(localStorage.getItem('la_decks') || '[]'); },
  get cards() { return JSON.parse(localStorage.getItem('la_cards') || '[]'); },

  save(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
    this._idbPut(key, val); // async fire-and-forget backup
  },

  saveDeck(deck) {
    const decks = this.decks;
    const i = decks.findIndex(d => d.id === deck.id);
    if (i >= 0) decks[i] = deck; else decks.push(deck);
    this.save('la_decks', decks);
  },
  deleteDeck(id) {
    this.save('la_decks', this.decks.filter(d => d.id !== id));
    this.save('la_cards', this.cards.filter(c => c.deckId !== id));
  },
  saveCard(card) {
    const cards = this.cards;
    const i = cards.findIndex(c => c.id === card.id);
    if (i >= 0) cards[i] = card; else cards.push(card);
    this.save('la_cards', cards);
  },
  deleteCard(id) {
    this.save('la_cards', this.cards.filter(c => c.id !== id));
  },
  cardsForDeck(deckId) { return this.cards.filter(c => c.deckId === deckId); },
  getDeck(id) { return this.decks.find(d => d.id === id); },
  getCard(id) { return this.cards.find(c => c.id === id); },
};

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

function newDeck(name, desc) {
  return { id: uid(), name, description: desc || '', createdAt: Date.now() };
}

function newCard(deckId, front, back) {
  return {
    id: uid(), deckId, front, back,
    status: 0, correctStreak: 0, totalReviews: 0,
    lastReviewed: null, intervalDays: 1,
  };
}

// ── Computed deck stats ─────────────────────────────────────────────────────
function deckStats(deck) {
  const cards = DB.cardsForDeck(deck.id);
  const red    = cards.filter(c => c.status === 0).length;
  const yellow = cards.filter(c => c.status === 1).length;
  const green  = cards.filter(c => c.status === 2).length;
  const total  = cards.length;
  const pct    = total ? Math.round(green / total * 100) : 0;
  return { cards, red, yellow, green, total, pct };
}

// ── Rate a card (SM-2 inspired) ─────────────────────────────────────────────
function rateCard(card, rating) {
  card.totalReviews++;
  card.lastReviewed = Date.now();
  if (rating === 2) {           // green – Gut
    card.correctStreak++;
    if (card.status < 2) card.status++;
    card.intervalDays = card.correctStreak === 1 ? 1
                      : card.correctStreak === 2 ? 3
                      : Math.round(card.intervalDays * 2.1 * 10) / 10;
  } else if (rating === 1) {    // yellow – Schwer
    card.correctStreak = Math.max(0, card.correctStreak - 1);
    card.intervalDays  = Math.max(1, Math.round(card.intervalDays * 0.5 * 10) / 10);
    if (card.status === 0) card.status = 1;
  } else {                       // red – Nochmal
    card.correctStreak = 0;
    card.intervalDays  = 1;
    card.status        = 0;
  }
  DB.saveCard(card);
}

// ── Study queue: red first, then yellow, then green; unreviewed first ────────
function studyQueue(deckId) {
  return DB.cardsForDeck(deckId).sort((a, b) => {
    if (a.status !== b.status) return a.status - b.status;
    const la = a.lastReviewed || 0;
    const lb = b.lastReviewed || 0;
    return la - lb;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTER / VIEW ENGINE
// ═══════════════════════════════════════════════════════════════════════════
const App = {
  currentView: null,
  state: {},

  go(view, state = {}) {
    this.state = state;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const el = document.getElementById('view-' + view);
    if (el) el.classList.add('active');
    this.currentView = view;
    // Update bottom nav
    document.querySelectorAll('.bottom-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    // Update header
    this.renderHeader(view, state);
    // Render content
    this['render_' + view]?.(state);
  },

  renderHeader(view, state) {
    const backBtn = document.getElementById('header-back');
    const title   = document.getElementById('header-title');

    const titles = {
      decks:    '<i class="bi bi-stack me-2"></i>LernApp',
      import:   '<i class="bi bi-box-arrow-in-down me-2"></i>Import / Export',
      detail:   DB.getDeck(state.deckId)?.name || 'Deck',
      newDeck:  'Neues Deck',
      editDeck: 'Deck bearbeiten',
      newCard:  'Neue Karte',
      editCard: 'Karte bearbeiten',
      study:    'Lernen',
      progress: 'Fortschritt',
    };
    title.innerHTML = titles[view] || 'LernApp';

    const hasBack = !['decks','import'].includes(view);
    backBtn.style.display = hasBack ? '' : 'none';
    backBtn.onclick = () => {
      if (view === 'detail') App.go('decks');
      else if (['newCard','editCard','editDeck','study','progress'].includes(view))
        App.go('detail', { deckId: state.deckId });
      else if (view === 'newDeck') App.go('decks');
      else App.go('decks');
    };
  },

  render_import() {
    document.getElementById('fab').style.display = 'none';
    ImportView.switchTab('csv');
    ImportView._refreshDeckSelects();
  },

  // ── View: Decks List ────────────────────────────────────────────────────
  render_decks() {
    const decks = DB.decks;
    const fab   = document.getElementById('fab');
    fab.style.display = '';
    fab.onclick = () => App.go('newDeck');

    if (!decks.length) {
      document.getElementById('decks-list').innerHTML = `
        <div class="empty-state">
          <i class="bi bi-inbox d-block mb-3"></i>
          <h5 class="text-muted">Noch keine Decks</h5>
          <p class="text-muted small">Tippe auf + um dein erstes Deck zu erstellen.</p>
        </div>`;
      return;
    }

    document.getElementById('decks-list').innerHTML = decks.map(deck => {
      const s = deckStats(deck);
      const rw = s.total ? (s.red / s.total * 100).toFixed(0) : 0;
      const yw = s.total ? (s.yellow / s.total * 100).toFixed(0) : 0;
      const gw = s.total ? (s.green / s.total * 100).toFixed(0) : 0;
      return `
      <div class="card shadow-sm mb-3 deck-card" onclick="App.go('detail',{deckId:'${deck.id}'})">
        <div class="card-body pb-2">
          <div class="d-flex justify-content-between align-items-start">
            <h6 class="mb-1 fw-bold"><i class="bi bi-layers me-2 text-primary"></i>${esc(deck.name)}</h6>
            <span class="text-muted small">${s.total} Karte${s.total !== 1 ? 'n' : ''}</span>
          </div>
          ${deck.description ? `<p class="text-muted small mb-2">${esc(deck.description)}</p>` : ''}
          ${s.total ? `
          <div class="progress mb-1" style="height:8px;border-radius:6px;overflow:hidden;">
            <div class="progress-bar bg-danger"  style="width:${rw}%"></div>
            <div class="progress-bar bg-warning" style="width:${yw}%"></div>
            <div class="progress-bar bg-success" style="width:${gw}%"></div>
          </div>
          <div class="d-flex gap-3 small">
            <span class="text-danger"><i class="bi bi-circle-fill me-1" style="font-size:.45rem;"></i>${s.red}</span>
            <span class="text-warning"><i class="bi bi-circle-fill me-1" style="font-size:.45rem;"></i>${s.yellow}</span>
            <span class="text-success"><i class="bi bi-circle-fill me-1" style="font-size:.45rem;"></i>${s.green}</span>
            <span class="ms-auto text-muted">${s.pct}% gelernt</span>
          </div>` : '<span class="text-muted small">Noch keine Karten</span>'}
        </div>
      </div>`;
    }).join('');
  },

  // ── View: Deck Detail ───────────────────────────────────────────────────
  render_detail({ deckId }) {
    const deck  = DB.getDeck(deckId);
    const cards = DB.cardsForDeck(deckId);
    const s     = deckStats(deck);
    document.getElementById('fab').style.display = 'none';

    // Study + add buttons
    document.getElementById('detail-study-btn').onclick =
      () => cards.length ? App.go('study', { deckId }) : null;
    document.getElementById('detail-study-btn').disabled = !cards.length;
    document.getElementById('detail-add-btn').onclick =
      () => App.go('newCard', { deckId });
    document.getElementById('detail-progress-btn').onclick =
      () => App.go('progress', { deckId });
    document.getElementById('detail-edit-btn').onclick =
      () => App.go('editDeck', { deckId });
    document.getElementById('detail-share-btn').onclick =
      () => ImportView.showShareModal(deckId);
    document.getElementById('detail-export-csv-btn').onclick =
      () => { ImportView._refreshDeckSelects(); ImportView.exportCSVById(deckId); };
    document.getElementById('detail-export-json-btn').onclick =
      () => { ImportView.exportJSONById(deckId); };
    document.getElementById('detail-delete-btn').onclick = () => {
      if (confirm(`Deck „${deck.name}" wirklich löschen?`)) {
        DB.deleteDeck(deckId);
        App.go('decks');
      }
    };

    // Stats bar
    if (s.total) {
      const rw = (s.red/s.total*100).toFixed(0);
      const yw = (s.yellow/s.total*100).toFixed(0);
      const gw = (s.green/s.total*100).toFixed(0);
      document.getElementById('detail-stats').innerHTML = `
        <div class="card mb-3 shadow-sm p-3">
          <div class="progress mb-2" style="height:12px;border-radius:8px;overflow:hidden;">
            <div class="progress-bar bg-danger"  style="width:${rw}%"></div>
            <div class="progress-bar bg-warning" style="width:${yw}%"></div>
            <div class="progress-bar bg-success" style="width:${gw}%"></div>
          </div>
          <div class="d-flex justify-content-between small fw-semibold">
            <span class="text-danger"><i class="bi bi-circle-fill me-1" style="font-size:.45rem;"></i>${s.red} Unbekannt</span>
            <span class="text-warning"><i class="bi bi-circle-fill me-1" style="font-size:.45rem;"></i>${s.yellow} In Bearb.</span>
            <span class="text-success"><i class="bi bi-circle-fill me-1" style="font-size:.45rem;"></i>${s.green} Gelernt</span>
          </div>
        </div>`;
    } else {
      document.getElementById('detail-stats').innerHTML = '';
    }

    // Cards list
    document.getElementById('detail-cards').innerHTML = cards.length
      ? cards.map(c => {
          const labels = ['Unbekannt','In Bearbeitung','Gelernt'];
          return `
          <div class="card shadow-sm mb-2 card-status-${c.status}">
            <div class="card-body py-2">
              <div class="d-flex justify-content-between align-items-start mb-1">
                <span class="badge badge-status-${c.status} rounded-pill">
                  <i class="bi bi-circle-fill me-1" style="font-size:.45rem;"></i>${labels[c.status]}
                </span>
                <div class="d-flex gap-2">
                  <button class="btn btn-sm btn-link p-0 text-secondary"
                    onclick="App.go('editCard',{deckId:'${deckId}',cardId:'${c.id}'})">
                    <i class="bi bi-pencil"></i></button>
                  <button class="btn btn-sm btn-link p-0 text-danger"
                    onclick="App.deleteCard('${c.id}','${deckId}')">
                    <i class="bi bi-trash"></i></button>
                </div>
              </div>
              <p class="mb-1 fw-semibold small">${esc(c.front)}</p>
              <p class="mb-0 text-muted small">${esc(c.back)}</p>
              ${c.correctStreak > 1 ? `<small class="text-success">🔥 ${c.correctStreak}er Serie</small>` : ''}
            </div>
          </div>`;
        }).join('')
      : `<div class="empty-state">
           <i class="bi bi-card-list d-block mb-3"></i>
           <p class="text-muted">Noch keine Karten. Tippe auf „+ Karte" um zu starten.</p>
         </div>`;
  },

  deleteCard(cardId, deckId) {
    if (confirm('Karte löschen?')) {
      DB.deleteCard(cardId);
      App.go('detail', { deckId });
    }
  },

  // ── View: New / Edit Deck ───────────────────────────────────────────────
  render_newDeck() {
    document.getElementById('fab').style.display = 'none';
    document.getElementById('deck-form-name').value = '';
    document.getElementById('deck-form-desc').value = '';
    document.getElementById('deck-form').onsubmit = (e) => {
      e.preventDefault();
      const name = document.getElementById('deck-form-name').value.trim();
      const desc = document.getElementById('deck-form-desc').value.trim();
      if (!name) return;
      DB.saveDeck(newDeck(name, desc));
      App.go('decks');
    };
  },

  render_editDeck({ deckId }) {
    document.getElementById('fab').style.display = 'none';
    const deck = DB.getDeck(deckId);
    document.getElementById('deck-edit-name').value = deck.name;
    document.getElementById('deck-edit-desc').value = deck.description || '';
    document.getElementById('deck-edit-form').onsubmit = (e) => {
      e.preventDefault();
      deck.name = document.getElementById('deck-edit-name').value.trim();
      deck.description = document.getElementById('deck-edit-desc').value.trim();
      if (!deck.name) return;
      DB.saveDeck(deck);
      App.go('detail', { deckId });
    };
  },

  // ── View: New / Edit Card ───────────────────────────────────────────────
  render_newCard({ deckId }) {
    document.getElementById('fab').style.display = 'none';
    document.getElementById('card-form-front').value = '';
    document.getElementById('card-form-back').value = '';
    document.getElementById('card-form').onsubmit = (e) => {
      e.preventDefault();
      const front = document.getElementById('card-form-front').value.trim();
      const back  = document.getElementById('card-form-back').value.trim();
      if (!front || !back) return;
      DB.saveCard(newCard(deckId, front, back));
      // Add another or go back
      document.getElementById('card-form-front').value = '';
      document.getElementById('card-form-back').value = '';
      document.getElementById('card-form-front').focus();
      showToast('Karte gespeichert!');
    };
    document.getElementById('card-form-done').onclick = () => App.go('detail', { deckId });
  },

  render_editCard({ deckId, cardId }) {
    document.getElementById('fab').style.display = 'none';
    const card = DB.getCard(cardId);
    document.getElementById('card-edit-front').value = card.front;
    document.getElementById('card-edit-back').value  = card.back;
    document.getElementById('card-edit-form').onsubmit = (e) => {
      e.preventDefault();
      card.front = document.getElementById('card-edit-front').value.trim();
      card.back  = document.getElementById('card-edit-back').value.trim();
      if (!card.front || !card.back) return;
      DB.saveCard(card);
      App.go('detail', { deckId });
    };
    document.getElementById('card-edit-done').onclick = () => App.go('detail', { deckId });
  },

  // ── View: Study Mode ────────────────────────────────────────────────────
  _study: { cards: [], idx: 0, flipped: false, ratings: {} },

  render_study({ deckId }) {
    document.getElementById('fab').style.display = 'none';
    const queue = studyQueue(deckId);
    const st    = this._study;
    st.cards    = queue;
    st.idx      = 0;
    st.flipped  = false;
    st.ratings  = {};
    st.deckId   = deckId;

    // wire up buttons
    document.getElementById('study-flip-btn').onclick = () => this._flipCard();
    document.getElementById('flashcard-inner').onclick = () => { if (!st.flipped) this._flipCard(); };
    document.getElementById('btn-rate-0').onclick = () => this._rate(0);
    document.getElementById('btn-rate-1').onclick = () => this._rate(1);
    document.getElementById('btn-rate-2').onclick = () => this._rate(2);
    document.getElementById('study-restart-btn').onclick = () => App.go('study', { deckId });
    document.getElementById('study-progress-btn').onclick = () => App.go('progress', { deckId });

    document.getElementById('study-finish').classList.add('d-none');
    document.getElementById('study-main').classList.remove('d-none');

    this._showStudyCard();
  },

  _showStudyCard() {
    const { cards, idx, ratings } = this._study;
    if (!cards.length) return;
    const card = cards[idx];
    const total = cards.length;

    document.getElementById('flashcard-inner').classList.remove('is-flipped');
    this._study.flipped = false;

    setTimeout(() => {
      document.getElementById('study-front-text').textContent = card.front;
      document.getElementById('study-back-text').textContent  = card.back;
      const labels = ['Unbekannt','In Bearbeitung','Gelernt'];
      document.getElementById('study-card-badge').innerHTML =
        `<span class="badge badge-status-${card.status}">${labels[card.status]}</span>`;
    }, 150);

    document.getElementById('study-flip-area').classList.remove('d-none');
    document.getElementById('study-rate-area').classList.add('d-none');

    // Progress bar
    const rated = Object.keys(ratings).length;
    const red    = Object.values(ratings).filter(r => r === 0).length;
    const yellow = Object.values(ratings).filter(r => r === 1).length;
    const green  = Object.values(ratings).filter(r => r === 2).length;
    document.getElementById('study-progress-label').textContent = `${idx + 1} / ${total}`;
    document.getElementById('study-bar-red').style.width    = (red/total*100)    + '%';
    document.getElementById('study-bar-yellow').style.width = (yellow/total*100) + '%';
    document.getElementById('study-bar-green').style.width  = (green/total*100)  + '%';
    document.getElementById('study-stat-red').textContent    = red;
    document.getElementById('study-stat-yellow').textContent = yellow;
    document.getElementById('study-stat-green').textContent  = green;
  },

  _flipCard() {
    if (this._study.flipped) return;
    this._study.flipped = true;
    document.getElementById('flashcard-inner').classList.add('is-flipped');
    setTimeout(() => {
      document.getElementById('study-flip-area').classList.add('d-none');
      document.getElementById('study-rate-area').classList.remove('d-none');
    }, 280);
  },

  _rate(rating) {
    const st = this._study;
    const card = st.cards[st.idx];
    st.ratings[card.id] = rating;
    rateCard(card, rating);

    if (st.idx < st.cards.length - 1) {
      st.idx++;
      this._showStudyCard();
    } else {
      this._showFinish();
    }
  },

  _showFinish() {
    const { ratings, cards } = this._study;
    const red    = Object.values(ratings).filter(r => r === 0).length;
    const yellow = Object.values(ratings).filter(r => r === 1).length;
    const green  = Object.values(ratings).filter(r => r === 2).length;
    const total  = cards.length;

    document.getElementById('study-main').classList.add('d-none');
    document.getElementById('study-finish').classList.remove('d-none');

    document.getElementById('finish-red').textContent    = red;
    document.getElementById('finish-yellow').textContent = yellow;
    document.getElementById('finish-green').textContent  = green;

    // final bar
    document.getElementById('study-bar-red').style.width    = (red/total*100)    + '%';
    document.getElementById('study-bar-yellow').style.width = (yellow/total*100) + '%';
    document.getElementById('study-bar-green').style.width  = (green/total*100)  + '%';
    document.getElementById('study-progress-label').textContent = `${total} / ${total}`;
  },

  // ── View: Progress ──────────────────────────────────────────────────────
  render_progress({ deckId }) {
    document.getElementById('fab').style.display = 'none';
    const deck  = DB.getDeck(deckId);
    const cards = DB.cardsForDeck(deckId);
    const s     = deckStats(deck);

    // ── SVG ring ────────────────────────────────────────────────────────
    const circ = 314.16;
    const dash = s.total ? ((s.green / s.total) * circ).toFixed(1) : 0;
    document.getElementById('prog-ring-dash').setAttribute('stroke-dasharray', `${dash} ${circ}`);
    document.getElementById('prog-ring-pct').textContent   = s.pct + '%';
    document.getElementById('prog-ring-label').textContent = `${s.green}/${s.total} gelernt`;
    document.getElementById('prog-count-red-sm').textContent    = s.red    + ' ●';
    document.getElementById('prog-count-yellow-sm').textContent = s.yellow + ' ●';
    document.getElementById('prog-count-green-sm').textContent  = s.green  + ' ●';

    // ── Real Traffic Light ───────────────────────────────────────────────
    // Light state based on overall progress
    const rl = document.getElementById('tl-red');
    const yl = document.getElementById('tl-yellow');
    const gl = document.getElementById('tl-green');
    const lb = document.getElementById('tl-label');
    rl.className = 'tl-light tl-red';
    yl.className = 'tl-light tl-yellow';
    gl.className = 'tl-light tl-green';
    if (s.pct >= 80) {
      gl.classList.add('on'); lb.textContent = 'Super!';
    } else if (s.pct >= 40) {
      yl.classList.add('on'); lb.textContent = 'Weiter so!';
    } else {
      rl.classList.add('on'); lb.textContent = 'Los geht\'s!';
    }

    // ── Stacked bar + ampel lights ───────────────────────────────────────
    const rw = s.total ? (s.red/s.total*100).toFixed(0) : 0;
    const yw = s.total ? (s.yellow/s.total*100).toFixed(0) : 0;
    const gw = s.total ? (s.green/s.total*100).toFixed(0) : 0;
    document.getElementById('prog-bar-red').style.width    = rw + '%';
    document.getElementById('prog-bar-yellow').style.width = yw + '%';
    document.getElementById('prog-bar-green').style.width  = gw + '%';
    document.getElementById('prog-light-red').className    = `ampel-light red    ${s.red    > 0 ? 'on' : ''}`;
    document.getElementById('prog-light-yellow').className = `ampel-light yellow ${s.yellow > 0 ? 'on' : ''}`;
    document.getElementById('prog-light-green').className  = `ampel-light green  ${s.green  > 0 ? 'on' : ''}`;
    document.getElementById('prog-count-red').textContent    = s.red;
    document.getElementById('prog-count-yellow').textContent = s.yellow;
    document.getElementById('prog-count-green').textContent  = s.green;

    // ── Segmented Lernpfad Track ─────────────────────────────────────────
    const SECTION = 8;   // cards per section
    const sections = [];
    for (let i = 0; i < cards.length; i += SECTION) {
      sections.push(cards.slice(i, i + SECTION));
    }
    if (!sections.length) sections.push([]);

    document.getElementById('prog-track-subtitle').textContent =
      `${sections.length} Abschnitt${sections.length !== 1 ? 'e' : ''} · ${s.total} Karten`;

    // A section is "unlocked" if the PREVIOUS section is ≥ 70 % green
    const sectionGreenPct = sections.map(sec => {
      if (!sec.length) return 0;
      return Math.round(sec.filter(c => c.status === 2).length / sec.length * 100);
    });

    const dotColor = ['#dc3545', '#ffc107', '#198754'];   // red/yellow/green
    const dotColorNew = '#dee2e6';                          // grey = never reviewed

    document.getElementById('lernpfad-track').innerHTML = sections.map((sec, idx) => {
      const unlocked = idx === 0 || sectionGreenPct[idx - 1] >= 70;
      const secGreen = sectionGreenPct[idx];
      // Section header color
      const hdrClass = secGreen >= 70 ? 'section-done'
                     : secGreen >= 30 ? 'section-progress'
                     : idx > 0 && !unlocked ? 'section-locked'
                     : 'section-new';

      const dots = sec.map(c => {
        const col = c.totalReviews === 0 ? dotColorNew : dotColor[c.status];
        return `<span class="card-dot" style="background:${col};" title="${esc(c.front)}"></span>`;
      }).join('');

      const lockIcon = !unlocked
        ? '<i class="bi bi-lock-fill tl-lock-icon"></i>'
        : '';

      return `
        <div class="lernpfad-section ${hdrClass}${!unlocked ? ' locked' : ''}">
          <div class="section-num">${idx + 1}.</div>
          <div class="section-dots">${dots}${lockIcon}</div>
          <div class="section-pct">${unlocked ? secGreen + '%' : ''}</div>
        </div>`;
    }).join('');

    // ── Table ────────────────────────────────────────────────────────────
    const labels = ['Unbekannt','In Bearbeitung','Gelernt'];
    document.getElementById('prog-table').innerHTML = cards.map(c => {
      const nextRev = c.totalReviews === 0
        ? '<span class="badge bg-secondary">Neu</span>'
        : c.status === 2
          ? `in ${Math.ceil(c.intervalDays)} Tag${c.intervalDays >= 2 ? 'en' : ''}`
          : 'Heute';
      return `<tr>
        <td class="small">${esc(c.front)}</td>
        <td><span class="badge badge-status-${c.status}">${labels[c.status]}</span></td>
        <td>${c.correctStreak > 0 ? `🔥 ${c.correctStreak}` : '—'}</td>
        <td class="text-muted small">${nextRev}</td>
      </tr>`;
    }).join('');
  },
};

// ── Keyboard shortcuts (study) ──────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (App.currentView !== 'study') return;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!App._study.flipped) App._flipCard(); }
  else if (e.key === '1') App._rate(0);
  else if (e.key === '2') App._rate(1);
  else if (e.key === '3') App._rate(2);
});

// ── Toast ───────────────────────────────────────────────────────────────────
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Restore from IndexedDB if localStorage was cleared
  await DB.restoreIfNeeded();

  // Bottom nav
  document.querySelectorAll('.bottom-nav-item').forEach(btn => {
    btn.addEventListener('click', () => App.go(btn.dataset.view));
  });

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Check for shared deck in URL hash (#g=GIST_ID)
  const hash = location.hash;
  if (hash.startsWith('#g=')) {
    ImportView.detectURLImport(hash.slice(3));
  }

  App.go('decks');
});
