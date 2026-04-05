from flask import Flask, render_template, request, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from datetime import datetime

app = Flask(__name__)
app.config['SECRET_KEY'] = 'lernapp-secret-key'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///lernapp.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)


class Deck(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.String(300), default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    cards = db.relationship('Card', backref='deck', lazy=True, cascade='all, delete-orphan')

    @property
    def card_count(self):
        return len(self.cards)


class Card(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    front = db.Column(db.Text, nullable=False)
    back = db.Column(db.Text, nullable=False)
    deck_id = db.Column(db.Integer, db.ForeignKey('deck.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


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
    cards = deck.cards
    if not cards:
        flash('Dieses Deck hat noch keine Karten.', 'warning')
        return redirect(url_for('deck_detail', deck_id=deck.id))
    return render_template('study.html', deck=deck, cards=cards)


if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True)
