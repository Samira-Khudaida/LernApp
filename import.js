// ── Import / Export View ─────────────────────────────────────────────────────
const ImportView = {
  _apkgCards: null,
  _urlImportData: null,
  _currentShareUrl: null,

  // ══════════════════════════════════════════════════════════════════════════
  //  QR-Code / Gist Sharing  (kein CDN nötig)
  // ══════════════════════════════════════════════════════════════════════════

  async showShareModal(deckId) {
    const deck  = DB.getDeck(deckId);
    const cards = DB.cardsForDeck(deckId);

    // Show modal immediately with loading spinner
    document.getElementById('share-qr-wrap').innerHTML =
      '<div class="d-flex justify-content-center align-items-center" style="height:220px;">' +
      '<div class="spinner-border text-primary"></div></div>';
    document.getElementById('share-url-input').value  = 'Wird hochgeladen…';
    document.getElementById('share-code-box').textContent = '—';
    this._currentShareUrl = null;

    const modal = new bootstrap.Modal(document.getElementById('shareModal'));
    modal.show();

    try {
      const gistId = await this._uploadGist(deck, cards);
      const appUrl = `${location.origin}${location.pathname}#g=${gistId}`;
      this._currentShareUrl = appUrl;

      // QR-Code als Bild – kein JS-Library nötig
      const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&ecc=M&data=${encodeURIComponent(appUrl)}`;
      document.getElementById('share-qr-wrap').innerHTML =
        `<img src="${qrSrc}" width="220" height="220" style="border-radius:12px;"
              onerror="this.outerHTML='<p class=\\'text-muted small\\'>QR-Bild konnte nicht geladen werden.<br>Bitte Link kopieren.</p>'">`;

      document.getElementById('share-url-input').value = appUrl;
      // Show first 8 chars as short code
      document.getElementById('share-code-box').textContent = gistId.slice(0, 8).toUpperCase();

    } catch (err) {
      document.getElementById('share-qr-wrap').innerHTML =
        `<div class="text-danger small p-3">${err.message}</div>`;
      document.getElementById('share-url-input').value = 'Fehler – bitte nochmal versuchen.';
    }
  },

  async _uploadGist(deck, cards) {
    const content = JSON.stringify({ deck, cards });
    const res = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
      body: JSON.stringify({
        description: `LernApp: ${deck.name}`,
        public: false,
        files: { 'lernapp-deck.json': { content } },
      }),
    });
    if (!res.ok) {
      const msg = res.status === 403
        ? 'GitHub Rate-Limit erreicht. Bitte in 1 Stunde nochmal versuchen.'
        : `GitHub-Fehler (${res.status}). Bitte nochmal versuchen.`;
      throw new Error(msg);
    }
    const json = await res.json();
    return json.id;   // 32-char gist ID
  },

  copyShareUrl() {
    const val = this._currentShareUrl;
    if (!val) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(val).then(() => showToast('Link kopiert! ✓'));
    } else {
      const inp = document.getElementById('share-url-input');
      inp.select(); document.execCommand('copy');
      showToast('Link kopiert! ✓');
    }
  },

  nativeShare() {
    const url = this._currentShareUrl;
    if (!url) return;
    if (navigator.share) {
      navigator.share({ title: 'LernApp – Deck teilen', url }).catch(() => {});
    } else {
      this.copyShareUrl();
    }
  },

  // ── Called on app start when #g=GIST_ID is detected ─────────────────────
  async detectURLImport(gistId) {
    gistId = gistId.trim();
    if (!gistId) return;
    try {
      const data = await this._fetchGist(gistId);
      this._urlImportData = data;
      document.getElementById('import-banner-name').textContent =
        `„${data.deck.name}" – ${data.cards.length} Karte${data.cards.length !== 1 ? 'n' : ''}`;
      document.getElementById('import-banner').classList.remove('d-none');
      document.body.style.paddingTop = '130px';
    } catch {
      // Invalid gist – silently ignore
    }
  },

  async _fetchGist(gistId) {
    const res = await fetch(`https://api.github.com/gists/${gistId}`,
      { headers: { 'Accept': 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('Gist nicht gefunden');
    const gist = await res.json();
    const file = gist.files['lernapp-deck.json'];
    if (!file) throw new Error('Keine LernApp-Daten in diesem Gist');
    return JSON.parse(file.content);
  },

  confirmURLImport() {
    const data = this._urlImportData;
    if (!data) return;
    const deck = { ...data.deck, id: uid() };
    DB.saveDeck(deck);
    data.cards.forEach(c => DB.saveCard({
      ...c, id: uid(), deckId: deck.id,
      status: 0, correctStreak: 0, totalReviews: 0, lastReviewed: null, intervalDays: 1,
    }));
    this.dismissURLImport();
    showToast(`✓ „${deck.name}" mit ${data.cards.length} Karten importiert!`);
    App.go('decks');
    history.replaceState(null, '', location.pathname);
  },

  dismissURLImport() {
    document.getElementById('import-banner').classList.add('d-none');
    document.body.style.paddingTop = '';
    this._urlImportData = null;
    history.replaceState(null, '', location.pathname);
  },

  // ── Import via manually-entered Gist URL or ID ───────────────────────────
  async importFromCode() {
    const raw = document.getElementById('sync-code-input').value.trim();
    if (!raw) return;

    // Accept full URL or bare gist ID
    const gistId = raw.includes('github.com/gists/')
      ? raw.split('github.com/gists/')[1].split(/[/?#]/)[0]
      : raw.includes('#g=')
        ? raw.split('#g=')[1].split(/[?#]/)[0]
        : raw;

    document.getElementById('sync-code-btn').disabled = true;
    document.getElementById('sync-code-btn').textContent = '…';

    try {
      const data = await this._fetchGist(gistId);
      const deck = { ...data.deck, id: uid() };
      DB.saveDeck(deck);
      data.cards.forEach(c => DB.saveCard({
        ...c, id: uid(), deckId: deck.id,
        status: 0, correctStreak: 0, totalReviews: 0, lastReviewed: null, intervalDays: 1,
      }));
      showToast(`✓ „${deck.name}" mit ${data.cards.length} Karten importiert!`);
      document.getElementById('sync-code-input').value = '';
      App.go('decks');
    } catch (err) {
      showToast('Fehler: ' + err.message);
    } finally {
      document.getElementById('sync-code-btn').disabled = false;
      document.getElementById('sync-code-btn').textContent = 'Importieren';
    }
  },

  // ── Tab switching ──────────────────────────────────────────────────────────
  switchTab(tab) {
    document.querySelectorAll('.import-tab').forEach(el => el.classList.add('d-none'));
    document.getElementById('import-tab-' + tab).classList.remove('d-none');
    document.querySelectorAll('#import-tabs .nav-link').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    this._refreshDeckSelects();
  },

  _refreshDeckSelects() {
    const decks = DB.decks;
    const opts  = decks.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    ['csv-export-deck', 'json-export-deck'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = opts || '<option value="">Noch keine Decks</option>';
    });
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  CSV
  // ══════════════════════════════════════════════════════════════════════════
  _csvRows: [],

  loadCSV(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      this._csvRows = this._parseCSV(text);
      if (!this._csvRows.length) { showToast('Keine gültigen Zeilen gefunden.'); return; }

      document.getElementById('csv-deck-name').value =
        file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');

      const preview = this._csvRows.slice(0, 5).map(([f, b]) =>
        `<div class="border rounded p-1 mb-1">
           <span class="fw-semibold">${esc(f)}</span>
           <span class="text-muted"> → ${esc(b)}</span>
         </div>`).join('');
      document.getElementById('csv-preview-table').innerHTML =
        preview + (this._csvRows.length > 5
          ? `<div class="text-muted">… und ${this._csvRows.length - 5} weitere</div>` : '');
      document.getElementById('csv-preview').classList.remove('d-none');
    };
    reader.readAsText(file, 'UTF-8');
  },

  _parseCSV(text) {
    const rows = [];
    // Handle both comma and semicolon separators, quoted fields
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const cols = this._splitCSVLine(line);
      if (cols.length >= 2 && cols[0] && cols[1]) {
        rows.push([cols[0].trim(), cols[1].trim()]);
      }
    }
    // Remove header row if it looks like a header
    if (rows.length && /^(front|vorder|frage|question|term)/i.test(rows[0][0])) {
      rows.shift();
    }
    return rows;
  },

  _splitCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    const sep = line.includes(';') && !line.includes(',') ? ';' : ',';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === sep && !inQuotes) {
        result.push(current); current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  },

  importCSV() {
    const name = document.getElementById('csv-deck-name').value.trim();
    if (!name) { showToast('Bitte einen Deck-Namen eingeben.'); return; }
    if (!this._csvRows.length) return;

    const deck = newDeck(name, `Importiert aus CSV – ${this._csvRows.length} Karten`);
    DB.saveDeck(deck);
    this._csvRows.forEach(([front, back]) => DB.saveCard(newCard(deck.id, front, back)));

    showToast(`✓ ${this._csvRows.length} Karten in „${name}" importiert!`);
    document.getElementById('csv-preview').classList.add('d-none');
    document.getElementById('csv-file-input').value = '';
    this._csvRows = [];
    this._refreshDeckSelects();
  },

  exportCSV() {
    const deckId = document.getElementById('csv-export-deck').value;
    if (!deckId) return;
    const deck  = DB.getDeck(deckId);
    const cards = DB.cardsForDeck(deckId);
    const lines = ['Vorderseite,Rückseite'];
    cards.forEach(c => {
      const f = `"${c.front.replace(/"/g,'""')}"`;
      const b = `"${c.back.replace(/"/g,'""')}"`;
      lines.push(`${f},${b}`);
    });
    this._download(lines.join('\n'), `${deck.name}.csv`, 'text/csv;charset=utf-8');
    showToast(`CSV mit ${cards.length} Karten exportiert.`);
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  JSON
  // ══════════════════════════════════════════════════════════════════════════
  importJSON(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        // Support both single deck export and array
        const imports = Array.isArray(data) ? data : [data];
        let totalCards = 0;
        for (const item of imports) {
          if (!item.deck || !item.cards) throw new Error('Ungültiges Format');
          const deck = { ...item.deck, id: uid() };
          DB.saveDeck(deck);
          for (const card of item.cards) {
            DB.saveCard({ ...card, id: uid(), deckId: deck.id });
            totalCards++;
          }
        }
        showToast(`✓ ${imports.length} Deck(s) mit ${totalCards} Karten importiert!`);
        this._refreshDeckSelects();
        input.value = '';
      } catch {
        showToast('Fehler: Ungültige JSON-Datei.');
      }
    };
    reader.readAsText(file);
  },

  exportJSON() {
    const deckId = document.getElementById('json-export-deck').value;
    if (!deckId) return;
    const deck  = DB.getDeck(deckId);
    const cards = DB.cardsForDeck(deckId);
    const data  = JSON.stringify({ deck, cards }, null, 2);
    this._download(data, `${deck.name}.json`, 'application/json');
    showToast(`JSON mit ${cards.length} Karten exportiert.`);
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  Anki APKG
  // ══════════════════════════════════════════════════════════════════════════
  _apkgParsed: null,

  async loadAPKG(input) {
    const file = input.files[0];
    if (!file) return;

    document.getElementById('apkg-loading').classList.remove('d-none');
    document.getElementById('apkg-label').classList.add('disabled');

    try {
      // Load sql.js on demand
      if (!window.SQL) {
        await this._loadSqlJs();
      }

      const arrayBuffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(arrayBuffer);

      // Anki21 uses collection.anki21, older uses collection.anki2
      const dbFile = zip.file('collection.anki21') || zip.file('collection.anki2');
      if (!dbFile) throw new Error('Keine Anki-Datenbank gefunden.');

      const dbBytes = await dbFile.async('uint8array');
      const db = new window.SQL.Database(dbBytes);

      // Get notes: flds contains fields separated by \x1f
      const stmt = db.prepare('SELECT flds FROM notes');
      const cards = [];
      while (stmt.step()) {
        const row   = stmt.getAsObject();
        const fields = row.flds.split('\x1f');
        const front = this._stripHtml(fields[0] || '').trim();
        const back  = this._stripHtml(fields[1] || '').trim();
        if (front && back) cards.push({ front, back });
      }
      stmt.free();
      db.close();

      if (!cards.length) throw new Error('Keine Karten gefunden.');

      this._apkgParsed = cards;

      document.getElementById('apkg-deck-name').value =
        file.name.replace(/\.apkg$/i, '').replace(/[-_]/g, ' ');
      document.getElementById('apkg-info').textContent =
        `${cards.length} Karte${cards.length !== 1 ? 'n' : ''} gefunden.`;
      document.getElementById('apkg-preview').classList.remove('d-none');

    } catch (err) {
      showToast('Fehler: ' + err.message);
    } finally {
      document.getElementById('apkg-loading').classList.add('d-none');
      document.getElementById('apkg-label').classList.remove('disabled');
    }
  },

  importAPKG() {
    if (!this._apkgParsed) return;
    const name = document.getElementById('apkg-deck-name').value.trim();
    if (!name) { showToast('Bitte einen Deck-Namen eingeben.'); return; }

    const deck = newDeck(name, `Importiert aus Anki – ${this._apkgParsed.length} Karten`);
    DB.saveDeck(deck);
    this._apkgParsed.forEach(({ front, back }) => DB.saveCard(newCard(deck.id, front, back)));

    showToast(`✓ ${this._apkgParsed.length} Karten in „${name}" importiert!`);
    document.getElementById('apkg-preview').classList.add('d-none');
    document.getElementById('apkg-file-input').value = '';
    this._apkgParsed = null;
    this._refreshDeckSelects();
  },

  _loadSqlJs() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js';
      script.onload = () => {
        window.initSqlJs({
          locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
        }).then(SQL => { window.SQL = SQL; resolve(); }).catch(reject);
      };
      script.onerror = () => reject(new Error('sql.js konnte nicht geladen werden.'));
      document.head.appendChild(script);
    });
  },

  _stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  },

  exportCSVById(deckId) {
    const deck  = DB.getDeck(deckId);
    const cards = DB.cardsForDeck(deckId);
    const lines = ['Vorderseite,Rückseite'];
    cards.forEach(c => {
      lines.push(`"${c.front.replace(/"/g,'""')}","${c.back.replace(/"/g,'""')}"`);
    });
    this._download(lines.join('\n'), `${deck.name}.csv`, 'text/csv;charset=utf-8');
    showToast(`CSV mit ${cards.length} Karten exportiert.`);
  },

  exportJSONById(deckId) {
    const deck  = DB.getDeck(deckId);
    const cards = DB.cardsForDeck(deckId);
    this._download(JSON.stringify({ deck, cards }, null, 2),
      `${deck.name}.json`, 'application/json');
    showToast(`JSON mit ${cards.length} Karten exportiert.`);
  },

  // ── Helpers ──────────────────────────────────────────────────────────────
  _download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  },
};
