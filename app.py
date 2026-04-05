from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from flask_sqlalchemy import SQLAlchemy
from datetime import datetime, date, timedelta
import json
import random

app = Flask(__name__)
app.config['SECRET_KEY'] = 'lernapp-secret-key'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///lernapp.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)

# Status constants
STATUS_RED    = 0  # Unbekannt
STATUS_YELLOW = 1  # In Bearbeitung
STATUS_GREEN  = 2  # Gelernt


class Deck(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.String(300), default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    cards = db.relationship('Card', backref='deck', lazy=True, cascade='all, delete-orphan')

    @property
    def card_count(self):
        return len(self.cards)

    @property
    def red_count(self):
        return sum(1 for c in self.cards if c.status == STATUS_RED)

    @property
    def yellow_count(self):
        return sum(1 for c in self.cards if c.status == STATUS_YELLOW)

    @property
    def green_count(self):
        return sum(1 for c in self.cards if c.status == STATUS_GREEN)

    @property
    def progress_pct(self):
        if not self.cards:
            return 0
        return round((self.green_count / len(self.cards)) * 100)

    def due_cards(self):
        """Returns cards sorted by priority: red first, then yellow, then green.
        Within each group, cards not reviewed today come first."""
        today = date.today()
        def sort_key(c):
            last = c.last_reviewed.date() if c.last_reviewed else date(2000, 1, 1)
            reviewed_today = (last == today)
            return (c.status, reviewed_today, last)
        return sorted(self.cards, key=sort_key)


class Card(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    front = db.Column(db.Text, nullable=False)
    back = db.Column(db.Text, nullable=False)
    deck_id = db.Column(db.Integer, db.ForeignKey('deck.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    # Spaced repetition fields
    status = db.Column(db.Integer, default=STATUS_RED, nullable=False)  # 0/1/2
    correct_streak = db.Column(db.Integer, default=0, nullable=False)
    total_reviews = db.Column(db.Integer, default=0, nullable=False)
    last_reviewed = db.Column(db.DateTime, nullable=True)
    interval_days = db.Column(db.Float, default=1.0, nullable=False)  # SM-2 interval

    @property
    def status_label(self):
        return ['Unbekannt', 'In Bearbeitung', 'Gelernt'][self.status]

    @property
    def status_color(self):
        return ['danger', 'warning', 'success'][self.status]

    @property
    def status_icon(self):
        return ['circle-fill', 'circle-fill', 'circle-fill'][self.status]


# ── Decks ──────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    decks = Deck.query.order_by(Deck.created_at.desc()).all()
    return render_template('index.html', decks=decks)


@app.route('/deck/new', methods=['GET', 'POST'])
def new_deck():
    if request.method == 'POST':
        name = request.form['name'].strip()
        description = request.form.get('description', '').strip()
        if not name:
            flash('Name darf nicht leer sein.', 'danger')
            return render_template('deck_form.html', deck=None)
        deck = Deck(name=name, description=description)
        db.session.add(deck)
        db.session.commit()
        flash(f'Deck „{name}" wurde erstellt.', 'success')
        return redirect(url_for('deck_detail', deck_id=deck.id))
    return render_template('deck_form.html', deck=None)


@app.route('/deck/<int:deck_id>')
def deck_detail(deck_id):
    deck = db.get_or_404(Deck, deck_id)
    return render_template('deck_detail.html', deck=deck)


@app.route('/deck/<int:deck_id>/edit', methods=['GET', 'POST'])
def edit_deck(deck_id):
    deck = db.get_or_404(Deck, deck_id)
    if request.method == 'POST':
        name = request.form['name'].strip()
        if not name:
            flash('Name darf nicht leer sein.', 'danger')
            return render_template('deck_form.html', deck=deck)
        deck.name = name
        deck.description = request.form.get('description', '').strip()
        db.session.commit()
        flash('Deck wurde aktualisiert.', 'success')
        return redirect(url_for('deck_detail', deck_id=deck.id))
    return render_template('deck_form.html', deck=deck)


@app.route('/deck/<int:deck_id>/delete', methods=['POST'])
def delete_deck(deck_id):
    deck = db.get_or_404(Deck, deck_id)
    db.session.delete(deck)
    db.session.commit()
    flash(f'Deck „{deck.name}" wurde gelöscht.', 'info')
    return redirect(url_for('index'))


# ── Cards ──────────────────────────────────────────────────────────────────────

@app.route('/deck/<int:deck_id>/card/new', methods=['GET', 'POST'])
def new_card(deck_id):
    deck = db.get_or_404(Deck, deck_id)
    if request.method == 'POST':
        front = request.form['front'].strip()
        back = request.form['back'].strip()
        if not front or not back:
            flash('Vorder- und Rückseite dürfen nicht leer sein.', 'danger')
            return render_template('card_form.html', deck=deck, card=None)
        card = Card(front=front, back=back, deck_id=deck.id)
        db.session.add(card)
        db.session.commit()
        flash('Karte wurde hinzugefügt.', 'success')
        return redirect(url_for('deck_detail', deck_id=deck.id))
    return render_template('card_form.html', deck=deck, card=None)


@app.route('/deck/<int:deck_id>/card/<int:card_id>/edit', methods=['GET', 'POST'])
def edit_card(deck_id, card_id):
    deck = db.get_or_404(Deck, deck_id)
    card = db.get_or_404(Card, card_id)
    if request.method == 'POST':
        front = request.form['front'].strip()
        back = request.form['back'].strip()
        if not front or not back:
            flash('Vorder- und Rückseite dürfen nicht leer sein.', 'danger')
            return render_template('card_form.html', deck=deck, card=card)
        card.front = front
        card.back = back
        db.session.commit()
        flash('Karte wurde aktualisiert.', 'success')
        return redirect(url_for('deck_detail', deck_id=deck.id))
    return render_template('card_form.html', deck=deck, card=card)


@app.route('/deck/<int:deck_id>/card/<int:card_id>/delete', methods=['POST'])
def delete_card(deck_id, card_id):
    card = db.get_or_404(Card, card_id)
    db.session.delete(card)
    db.session.commit()
    flash('Karte wurde gelöscht.', 'info')
    return redirect(url_for('deck_detail', deck_id=deck_id))


# ── Study Mode ─────────────────────────────────────────────────────────────────

@app.route('/deck/<int:deck_id>/study')
def study(deck_id):
    deck = db.get_or_404(Deck, deck_id)
    if not deck.cards:
        flash('Dieses Deck hat noch keine Karten.', 'warning')
        return redirect(url_for('deck_detail', deck_id=deck.id))
    cards = deck.due_cards()
    cards_data = [{'id': c.id, 'front': c.front, 'back': c.back, 'status': c.status} for c in cards]
    return render_template('study.html', deck=deck, cards_data=json.dumps(cards_data))


@app.route('/deck/<int:deck_id>/card/<int:card_id>/rate', methods=['POST'])
def rate_card(deck_id, card_id):
    """AJAX endpoint: rate a card as 0=red, 1=yellow, 2=green."""
    card = db.get_or_404(Card, card_id)
    rating = int(request.json.get('rating', 0))  # 0, 1, 2

    card.total_reviews += 1
    card.last_reviewed = datetime.utcnow()

    if rating == STATUS_GREEN:
        card.correct_streak += 1
        # SM-2 inspired: increase interval
        if card.status < STATUS_GREEN:
            card.status += 1
        if card.correct_streak == 1:
            card.interval_days = 1.0
        elif card.correct_streak == 2:
            card.interval_days = 3.0
        else:
            card.interval_days = round(card.interval_days * 2.1, 1)
    elif rating == STATUS_YELLOW:
        card.correct_streak = max(0, card.correct_streak - 1)
        card.interval_days = max(1.0, card.interval_days * 0.5)
        if card.status == STATUS_RED:
            card.status = STATUS_YELLOW
        # yellow keeps current status otherwise
    else:  # red
        card.correct_streak = 0
        card.interval_days = 1.0
        card.status = STATUS_RED

    db.session.commit()
    return jsonify({
        'status': card.status,
        'interval_days': card.interval_days,
        'correct_streak': card.correct_streak,
    })


@app.route('/deck/<int:deck_id>/progress')
def progress(deck_id):
    deck = db.get_or_404(Deck, deck_id)
    return render_template('progress.html', deck=deck)


if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True)
