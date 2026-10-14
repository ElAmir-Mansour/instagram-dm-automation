/**
 * The proof samples, W5 of the setup wizard (P25; docs/onboarding/02 §3, 03 §5): "Does this sound like you?"
 *
 * It plugs into the wizard's own seam (`WelcomePage.register('proof', …)` draws its fields; `WelcomePage.show` calls `enter` as the
 * step opens) and keeps its state in `WelcomePage.state.proof`. Everything that talks to the server is `API.getProof` / `startProof` /
 * `proofVerdict` / `proofRegenerate`. The wizard loads this file when it starts; a page that cannot is a step that says the samples
 * are not available and lets the person carry on.
 *
 * ─── What the person sees ───────────────────────────────────────────────────
 *   writing        a loader: two samples are being written (up to half a minute)
 *   ready          two cards: a caption beside one of their own posts, and the first comment campaign's replies. Each has two answers,
 *                  "Sounds like me" and "Not quite"; "Not quite" asks what is off (too formal, too long, wrong information: the card is
 *                  written again with that hint; or "I'll edit it myself": a box with their own wording)
 *   no AI key      one honest paragraph: samples need an AI key, the operator has not added one, carry on
 *   could not      what failed, in a sentence, and "Try again"
 *   the day's limit  three rounds a day, and today's are used up
 * In every state Continue and "Skip for now" work: nothing here is needed to finish.
 *
 * ─── What a click does ──────────────────────────────────────────────────────
 * "Sounds like me" is a verdict (approved). "Not quite" is a verdict (rejected) and opens the question. A chip writes the card again, which
 * replaces the card on screen (the old sample is kept by the server as rejected). Editing saves the person's own wording (edited). Nothing
 * reaches the profile or posts anywhere: these are samples, and the page says so. An answer an admin gave on the person's behalf is shown as
 * "waiting for you", and tapping "Sounds like me" confirms it.
 *
 * ─── Escaping ───────────────────────────────────────────────────────────────
 * The samples are a model's words and the person's own posts. Every one reaches the page through `html` as text inside a `dir="auto"`
 * element (line breaks are CSS, `white-space: pre-wrap`); the edit box holds the person's own draft as the escaped text of the textarea,
 * so `</textarea>` typed into it is text, and what they type is kept in state (`draft`), so a repaint never loses it.
 */
const WelcomeProof = {
    /** The words behind the chips that write a card again. The fourth chip opens the editor and writes nothing. */
    HINTS: ['too_formal', 'too_long', 'wrong_info'],
    CHIPS: ['too_formal', 'too_long', 'wrong_info', 'edit_myself'],
    CARDS: ['caption', 'comment'],
    EDIT_MAX: 2200,

    page: null,

    fresh() {
        return {
            /** loading | ready | needs_key | failed | limit | unavailable */
            phase: 'loading',
            cards: [],
            limits: { roundsPerDay: 3, regenerations: 3 },
            /** The kind of what failed, as the server says it (`timeout`, `budget`…), or ''. */
            failure: '',
            /** Per card (`caption`, `comment`): { why, editing, draft, busy, note, notice }. */
            ui: {},
        };
    },

    // ─── Pure ────────────────────────────────────────────────────────────────

    /** What the person reads for a sample's text: `{username}` is the follower's name, which the page cannot know, so it says so. */
    shown(text) {
        return String(text == null ? '' : text).replace(/\{username\}/g, t('welcome.proof.username'));
    },

    cardUi(p, card) {
        return (p && p.ui && p.ui[card]) || {};
    },

    /** The i18n key that explains why there are no cards: the kind of failure, or the generic sentence. */
    failureKey(kind) {
        return kind === 'budget' || kind === 'quota' ? 'welcome.proof.failed.budget' : 'welcome.proof.failed.body';
    },

    /** `Try 2 of 4`, once a card has been written again; '' for the first. */
    tryText(card, p) {
        const total = (p && p.limits ? p.limits.regenerations : 3) + 1;
        if (!card || !(card.attempt > 1)) return '';
        return card.canRegenerate ? t('welcome.proof.try', { n: card.attempt, total }) : t('welcome.proof.tryLast', { n: card.attempt, total });
    },

    /** One line under a card about where its answer stands. Pure, so a test can feed it every state. */
    statusText(card, ui) {
        if (ui.busy === 'regenerate') return t('welcome.proof.regenerating');
        if (ui.busy) return t('welcome.proof.busy');
        if (ui.notice) return t(ui.notice);
        if (card.waiting) return t('welcome.proof.waiting');
        if (card.verdict === 'approved') return t('welcome.proof.saved.approved');
        if (card.verdict === 'edited') return t('welcome.proof.saved.edited');
        return '';
    },

    // ─── Rendering (pure) ────────────────────────────────────────────────────

    block(label, text, extra) {
        return html`
            <div class="proof-block ${extra || ''}">
                <p class="proof-label">${label}</p>
                <div class="proof-text" dir="auto">${this.shown(text)}</div>
            </div>
        `;
    },

    cardBody(card) {
        if (card.card === 'caption') {
            return html`
                ${card.original ? this.block(t('welcome.proof.original'), card.original, 'is-quote') : html`<p class="welcome-muted">${t('welcome.proof.noOriginal')}</p>`}
                ${this.block(t('welcome.proof.written'), card.text)}
            `;
        }
        const replies = Array.isArray(card.publicReplies) ? card.publicReplies : [];
        return html`
            ${card.keyword ? html`<p class="proof-when">${t('welcome.proof.comment.when')} <bdi class="proof-keyword" dir="auto">${card.keyword}</bdi></p>` : ''}
            ${this.block(t('welcome.proof.comment.dm'), card.text)}
            ${replies.map((reply, i) => this.block(i === 0 ? t('welcome.proof.comment.reply') : t('welcome.proof.comment.replyMore'), reply))}
        `;
    },

    /** The question under "Not quite": the chips, and the editor when the person chose to edit. */
    why(card, ui) {
        const busy = !!ui.busy;
        const chips = this.CHIPS.map((chip) => {
            const locked = busy || (chip !== 'edit_myself' && !card.canRegenerate);
            return html`<button type="button" class="btn btn-secondary proof-chip" data-action="welcomeProof:chip" data-card="${card.card}" data-chip="${chip}"
                                ${locked ? html.raw('disabled') : ''}>${t(`welcome.proof.chip.${chip}`)}</button>`;
        });
        return html`
            <div class="proof-why" id="proof-why-${card.card}">
                <p class="proof-label" id="proof-why-label-${card.card}">${t('welcome.proof.why')}</p>
                <div class="proof-chips" role="group" aria-labelledby="proof-why-label-${card.card}">${chips}</div>
                ${card.canRegenerate ? '' : html`<p class="welcome-muted">${t('welcome.proof.err.limit')}</p>`}
                ${ui.editing ? this.editor(card, ui) : ''}
            </div>
        `;
    },

    editor(card, ui) {
        return html`
            <div class="proof-edit">
                <label class="form-label" for="proof-edit-${card.card}">${t('welcome.proof.edit.label')}</label>
                <textarea class="field proof-edit-box" id="proof-edit-${card.card}" rows="6" dir="auto" maxlength="${this.EDIT_MAX}"
                          data-input="welcomeProof:draft" data-card="${card.card}" ${ui.busy ? html.raw('disabled') : ''}>${typeof ui.draft === 'string' ? ui.draft : ''}</textarea>
                ${card.card === 'comment' ? html`<p class="form-hint">${t('welcome.proof.edit.hintDm')}</p>` : ''}
                <div class="proof-edit-actions">
                    <button type="button" class="btn btn-primary" data-action="welcomeProof:saveEdit" data-card="${card.card}" ${ui.busy ? html.raw('disabled') : ''}>${t('welcome.proof.edit.save')}</button>
                    <button type="button" class="btn btn-secondary" data-action="welcomeProof:cancelEdit" data-card="${card.card}" ${ui.busy ? html.raw('disabled') : ''}>${t('common.cancel')}</button>
                </div>
            </div>
        `;
    },

    cardView(card, p) {
        const ui = this.cardUi(p, card.card);
        const yes = card.verdict === 'approved' || card.verdict === 'edited';
        const no = card.verdict === 'rejected';
        const busy = !!ui.busy;
        const status = this.statusText(card, ui);
        const tries = this.tryText(card, p);
        return html`
            <li class="proof-card surface" id="proof-card-${card.card}">
                <h2 class="proof-card-title">${t(`welcome.proof.card.${card.card}`)}</h2>
                ${this.cardBody(card)}
                <div class="proof-verdict" role="group" aria-label="${t('welcome.proof.verdictLabel')}">
                    <button type="button" class="btn btn-secondary proof-btn ${yes ? html.raw('is-on') : ''}" id="proof-yes-${card.card}" aria-pressed="${yes ? 'true' : 'false'}"
                            data-action="welcomeProof:approve" data-card="${card.card}" ${busy ? html.raw('disabled') : ''}>
                        <i data-lucide="check" aria-hidden="true"></i> ${t('welcome.proof.yes')}</button>
                    <button type="button" class="btn btn-secondary proof-btn ${no || ui.why ? html.raw('is-on') : ''}" id="proof-no-${card.card}" aria-pressed="${no || ui.why ? 'true' : 'false'}"
                            data-action="welcomeProof:notQuite" data-card="${card.card}" ${busy ? html.raw('disabled') : ''}>
                        <i data-lucide="x" aria-hidden="true"></i> ${t('welcome.proof.no')}</button>
                </div>
                ${ui.why || no ? this.why(card, ui) : ''}
                <p class="proof-status" role="status" aria-live="polite">${status}${tries ? html` <span class="proof-try">${tries}</span>` : ''}</p>
            </li>
        `;
    },

    message(titleKey, bodyKey, actions) {
        return html`
            <section class="proof-message" aria-live="polite">
                <h2 class="welcome-subtitle">${t(titleKey)}</h2>
                <p class="welcome-lead">${t(bodyKey)}</p>
                ${actions || ''}
            </section>
        `;
    },

    retryButton() {
        return html`<button type="button" class="btn btn-secondary btn-full" data-action="welcomeProof:retry"><i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('welcome.proof.retry')}</button>`;
    },

    /** The step's fields: everything W5 shows for a state. No DOM, no network. */
    fields(state) {
        const p = state && state.proof;
        if (!p || p.phase === 'loading') {
            return html`<div class="welcome-loading">${html.raw(UI.loader(t('welcome.proof.loading')))}<p class="welcome-muted">${t('welcome.proof.loadingHint')}</p></div>`;
        }
        const cards = p.cards.length ? html`<ul class="proof-list">${p.cards.map((card) => this.cardView(card, p))}</ul>` : '';
        if (p.phase === 'needs_key') return this.message('welcome.proof.noKeyTitle', 'welcome.proof.noKey');
        if (p.phase === 'unavailable') return this.message('welcome.proof.unavailableTitle', 'welcome.proof.unavailable');
        if (p.phase === 'limit') return html`${this.message('welcome.proof.limitTitle', 'welcome.proof.limit')}${cards}`;
        if (p.phase === 'failed') return html`${this.message('welcome.proof.failedTitle', this.failureKey(p.failure), this.retryButton())}${cards}`;
        return html`${cards}<p class="welcome-muted proof-footnote">${t('welcome.proof.footnote')}</p>`;
    },

    // ─── Running ─────────────────────────────────────────────────────────────

    /** Put the server's answer in the state. */
    take(p, answer) {
        const cards = answer && Array.isArray(answer.cards) ? answer.cards : [];
        p.cards = cards.filter((c) => c && this.CARDS.includes(c.card));
        if (answer && answer.limits) p.limits = answer.limits;
        p.failure = answer && typeof answer.failure === 'string' ? answer.failure : '';
        const state = answer && answer.state;
        p.phase = state === 'needs_ai_key' ? 'needs_key' : state === 'failed' ? 'failed' : 'ready';
        // A card that exists is judged where it stands: a card whose answer is already "Not quite" opens its question.
        p.cards.forEach((card) => { if (card.verdict === 'rejected') p.ui[card.card] = Object.assign({}, p.ui[card.card], { why: true }); });
    },

    /** Open the step: ask for the samples (a round the server makes only for what is missing, and never twice). */
    async enter(page) {
        this.page = page;
        const p = this.fresh();
        page.state.proof = p;
        page.paint(false);
        try {
            this.take(p, await API.startProof());
        } catch (err) {
            if (err && err.status === 401) return;
            p.phase = err && err.status === 429 ? 'limit' : 'unavailable';
            // Cards that exist stay readable when the day's rounds are used up.
            if (p.phase === 'limit') {
                try { this.take(p, await API.getProof()); p.phase = 'limit'; } catch { /* the message alone */ }
            }
        }
        if (page.state.step !== 'proof' || page.state.proof !== p) return;
        page.paint(false);
    },

    retry() {
        return this.page ? this.enter(this.page) : Promise.resolve();
    },

    cardOf(name) {
        const p = this.page && this.page.state.proof;
        return p ? p.cards.find((c) => c.card === name) || null : null;
    },

    /** Change one card's UI and repaint, putting focus back on `focusId` (a repaint would otherwise drop it). */
    setUi(name, patch, focusId) {
        const p = this.page.state.proof;
        p.ui[name] = Object.assign({}, p.ui[name], patch);
        this.page.paint(false);
        this.focus(focusId);
    },

    focus(id) {
        if (!id || typeof document === 'undefined') return;
        const el = document.getElementById(id);
        if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
    },

    /** Replace a card with the server's, and clear what was in flight on it. */
    replace(name, fresh, patch) {
        const p = this.page.state.proof;
        p.cards = p.cards.map((c) => (c.card === name ? fresh : c));
        p.ui[name] = Object.assign({}, patch);
    },

    describeError(err) {
        const code = err && err.body && err.body.code;
        if (code === 'REGENERATE_LIMIT') return 'welcome.proof.err.limit';
        if (code === 'PROOF_NOT_CURRENT' || code === 'ONBOARDING_COMPLETED') return 'welcome.proof.err.stale';
        if (err && err.status === 400) return 'welcome.proof.err.edit';
        return 'welcome.proof.err.generic';
    },

    async verdict(name, body, after) {
        const card = this.cardOf(name);
        if (!card || !this.page) return null;
        const ui = this.cardUi(this.page.state.proof, name);
        if (ui.busy) return null;
        this.setUi(name, { busy: 'save', notice: '' });
        try {
            const answer = await API.proofVerdict(card.id, body);
            const p = this.page.state.proof;
            if (!p || this.page.state.step !== 'proof') return null;
            this.replace(name, answer.card, after ? after(answer.card) : {});
            this.page.paint(false);
            return answer.card;
        } catch (err) {
            if (err && err.status === 401) return null;
            this.setUi(name, { busy: '', notice: this.describeError(err) });
            return null;
        }
    },

    /** "Sounds like me". */
    async approve(name) {
        const done = await this.verdict(name, { verdict: 'approved' });
        if (done) this.focus(`proof-yes-${name}`);
    },

    /** "Not quite": it is a verdict, and it opens the question. */
    async notQuite(name) {
        const card = this.cardOf(name);
        if (!card) return;
        if (card.verdict === 'rejected') {
            // Already said: the button only opens or closes the question.
            const ui = this.cardUi(this.page.state.proof, name);
            this.setUi(name, { why: !ui.why }, `proof-no-${name}`);
            return;
        }
        const done = await this.verdict(name, { verdict: 'rejected' }, () => ({ why: true }));
        if (done) this.focus(`proof-no-${name}`);
    },

    /** A chip: write the card again with that hint, or open the editor. */
    async chip(name, chip) {
        const card = this.cardOf(name);
        if (!card || !this.CHIPS.includes(chip)) return;
        if (chip === 'edit_myself') {
            this.setUi(name, { why: true, editing: true, draft: card.text, notice: '' }, `proof-edit-${name}`);
            return;
        }
        if (!this.HINTS.includes(chip) || !card.canRegenerate) return;
        const ui = this.cardUi(this.page.state.proof, name);
        if (ui.busy) return;
        this.setUi(name, { busy: 'regenerate', notice: '', why: true });
        try {
            const answer = await API.proofRegenerate(card.id, { hint: chip });
            const p = this.page.state.proof;
            if (!p || this.page.state.step !== 'proof') return;
            if (answer.state === 'ready' && answer.card) {
                this.replace(name, answer.card, {});
                this.page.paint(false);
                this.focus(`proof-yes-${name}`);
                if (typeof Motion !== 'undefined' && Motion.announce) Motion.announce(t('welcome.proof.regenerated'));
            } else {
                this.setUi(name, { busy: '', notice: answer.state === 'needs_ai_key' ? 'welcome.proof.err.noKey' : 'welcome.proof.err.generic' });
            }
        } catch (err) {
            if (err && err.status === 401) return;
            this.setUi(name, { busy: '', notice: this.describeError(err) });
        }
    },

    draft(name, value) {
        const p = this.page && this.page.state.proof;
        if (!p) return;
        p.ui[name] = Object.assign({}, p.ui[name], { draft: String(value == null ? '' : value).slice(0, this.EDIT_MAX) });
    },

    cancelEdit(name) {
        this.setUi(name, { editing: false, draft: '', notice: '' }, `proof-no-${name}`);
    },

    /** Keep the person's own wording. */
    async saveEdit(name) {
        const ui = this.cardUi(this.page.state.proof, name);
        const text = typeof ui.draft === 'string' ? ui.draft.trim() : '';
        if (!text) {
            this.setUi(name, { notice: 'welcome.proof.err.edit' }, `proof-edit-${name}`);
            return;
        }
        const done = await this.verdict(name, { verdict: 'edited', edited_text: text, reasons: ['edit_myself'] });
        if (done) this.focus(`proof-yes-${name}`);
    },

    /** The wizard is left: nothing is waiting and the next session starts clean. */
    stop() {
        this.page = null;
    },
};

UI.registerActions('welcomeProof', {
    approve: (el) => { const run = WelcomeProof.approve(el.dataset.card); if (run && run.catch) run.catch(() => undefined); },
    notQuite: (el) => { const run = WelcomeProof.notQuite(el.dataset.card); if (run && run.catch) run.catch(() => undefined); },
    chip: (el) => { const run = WelcomeProof.chip(el.dataset.card, el.dataset.chip); if (run && run.catch) run.catch(() => undefined); },
    saveEdit: (el) => { const run = WelcomeProof.saveEdit(el.dataset.card); if (run && run.catch) run.catch(() => undefined); },
    cancelEdit: (el) => WelcomeProof.cancelEdit(el.dataset.card),
    draft: (el) => WelcomeProof.draft(el.dataset.card, el.value),
    retry: () => { const run = WelcomeProof.retry(); if (run && run.catch) run.catch(() => undefined); },
});
