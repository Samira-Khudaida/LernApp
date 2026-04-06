// ── Import / Export View ─────────────────────────────────────────────────────
const ImportView = {
  _apkgCards: null,
  _urlImportData: null,

  // ══════════════════════════════════════════════════════════════════════════
  //  QR-Code / URL Sharing
  // ══════════════════════════════════════════════════════════════════════════

  showShareModal(deckId) {
    const deck  = DB.getDeck(deckId);
    const cards = DB.cardsForDeck(deckId);

    // Compress deck + cards into URL hash
    const payload = JSON.stringify({ deck, cards });
    const compressed = LZString.compressToEncodedURIComponent(payload);
    const url = `${location.origin}${location.pathname}#d=${compressed}`;

    // Show URL in input
    document.getElementById('share-url-input').value = url;
    this._currentShareUrl = url;

    // Render QR code
    const canvas = document.getElementById('share-qr-canvas');
    QRCode.toCanvas(canvas, url, {
      width: 220,
      margin: 2,
      color: { dark: '#212529', light: '#ffffff' },
    }).catch(err => {
      // URL might be too long for QR → show warning
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 220; canvas.height = 60;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#dc3545';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Deck zu groß für QR-Code.', 110, 25);
      ctx.fillText('Bitte Link kopieren.', 110, 45);
    });

    new bootstrap.Modal(document.getElementById('shareModal')).show();
  },

  copyShareUrl() {
    const input = document.getElementById('share-url-input');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(input.value).then(() => showToast('Link kopiert!'));
    } else {
      input.select(); document.execCommand('copy');
      showToast('Link kopiert!');
    }
  },

  nativeShare() {
    const url = document.getElementById('share-url-input').value;
    if (navigator.share) {
      navigator.share({ title: 'LernApp Deck', url }).catch(() => {});
    } else {
      this.copyShareUrl();
    }
  },

  // ── Called on app start when #d= hash is detected ─────────────────────
  detectURLImport(compressed) {
    try {
      const json = LZString.decompressFromEncodedURIComponent(compressed);
      if (!json) return;
      const data = JSON.parse(json);
      if (!data.deck || !data.cards) return;

      this._urlImportData = data;

      const banner = document.getElementById('import-banner');
      document.getElementById('import-banner-name').textContent =
        `„${data.deck.name}" – ${data.cards.length} Karte${data.cards.length !== 1 ? 'n' : ''}`;
      banner.classList.remove('d-none');

      // Adjust body padding for banner
      document.body.style.paddingTop = '120px';
    } catch {
      // Invalid hash – ignore
    }
  },

  confirmURLImport() {
    const data = this._urlImportData;
    if (!data) return;
    const deck = { ...data.deck, id: uid() };
    DB.saveDeck(deck);
    data.cards.forEach(c => DB.saveCard({ ...c, id: uid(), deckId: deck.id,
      status: 0, correctStreak: 0, totalReviews: 0, lastReviewed: null, intervalDays: 1 }));

    this.dismissURLImport();
    showToast(`✓ „${deck.name}" mit ${data.cards.length} Karten importiert!`);
    App.go('decks');

    // Clear hash from URL
    history.replaceState(null, '', location.pathname);
  },

  dismissURLImport() {
    document.getElementById('import-banner').classList.add('d-none');
    document.body.style.paddingTop = '';
    this._urlImportData = null;
    history.replaceState(null, '', location.pathname);
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
