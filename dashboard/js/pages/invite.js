/**
 * The invite page (`#/invite?t=…`): where a person opening an invite link chooses a password and gets in (P17).
 *
 * It is NOT a page of the authenticated app. It renders into `#invite-screen`, a sibling of the login screen, because the
 * person has no session yet; `App.init` and `App.onHashChange` route here before they look for a token.
 *
 * ─── The token ──────────────────────────────────────────────────────────────
 * The link carries it in the URL hash, which no server, log or Referer ever sees. `App.captureInvite()` moves it into
 * `sessionStorage` and rewrites the hash to a bare `#/invite` before anything renders, so the address bar, the browser's
 * history and a screenshot of the page never hold it, and a reload (the language toggle reloads) still has it.
 *
 * ─── What the server decides ────────────────────────────────────────────────
 * Nothing here is trusted: `POST /api/invites/peek` says who the link is for and who is signed in; `POST
 * /api/invites/accept` makes the account. Every way a link can be unusable arrives as the same 410, so the page says one
 * thing for all of them ("no longer valid") and offers the two things that can help: ask for a new one, or sign in.
 *
 * ─── W0 of the wizard ───────────────────────────────────────────────────────
 * This page IS the wizard's first screen (docs/onboarding/02 §3, W0): the link may be spelled `#/welcome?invite=…` as well as
 * `#/invite?t=…` (`App.isInviteHash`), and a tenant that has not finished setting up lands in `#/welcome` after it
 * (`App.completeInvite`). A person who opened the link inside Instagram's, Facebook's or WhatsApp's own browser is told so
 * (`UI.inAppHint`): connecting an account later does not work from there.
 *
 * ─── Escaping ───────────────────────────────────────────────────────────────
 * The tenant's name, the inviter's, and the address come from the server and from people. They go through `html` like
 * everything else in the dashboard, inside `<bdi>`, and `view()` is pure so a test can feed it a payload in each of them.
 */
const InvitePage = {
    /** loading | ready | invalid | throttled | failed */
    phase: 'loading',
    /** What `peek` answered, once it has. */
    peek: null,
    /** The last refusal from `accept` that stays on the form: `{ code, message, wait }`. */
    error: null,
    /** What was typed into the address field, kept across a re-render. */
    email: '',
    /** Seconds the throttle asked us to wait, for the "try again" text. */
    wait: 0,
    /** True while `accept` is in flight, so a second submit is ignored. */
    busy: false,

    // ─── Rendering (pure) ────────────────────────────────────────────────────

    /** `ltrIn` from settings.js: a sentence with one Latin value in it, isolated so its punctuation does not jump. */
    withValue(key, params, name) {
        const MARK = '\u0000';
        const parts = t(key, Object.assign({}, params, { [name]: MARK })).split(MARK);
        if (parts.length !== 2) return t(key, params);
        return html`${parts[0]}<bdi dir="auto">${params[name]}</bdi>${parts[1]}`;
    },

    /** The mark and a heading. `title` is markup (it may hold the tenant's name in a `<bdi>`). */
    header(title, subtitle) {
        return html`
            <div class="login-logo">
                <div class="login-mark"><i data-lucide="zap" aria-hidden="true"></i></div>
                <h1 class="login-title" id="invite-title" tabindex="-1">${title}</h1>
                ${subtitle ? html`<p class="login-subtitle">${subtitle}</p>` : ''}
            </div>
        `;
    },

    /** Everything the card shows for a state. No DOM, no network. */
    view(state) {
        const s = state || {};
        switch (s.phase) {
            case 'invalid': return this.invalidView();
            case 'throttled': return this.messageView('clock', t('invite.throttled.title'), t('invite.throttled.body', { seconds: s.wait || 1 }), 'retry');
            case 'failed': return this.messageView('alert-triangle', t('invite.failed.title'), t('invite.failed.body'), 'retry');
            case 'ready': return this.readyView(s);
            default: return html`
                ${this.header(t('invite.loading'))}
                <div class="invite-loading">${html.raw(UI.loader(t('invite.loading')))}</div>
            `;
        }
    },

    invalidView() {
        return html`
            ${this.header(t('invite.invalid.title'))}
            <p class="invite-body">${t('invite.invalid.body')}</p>
            <div class="invite-actions">
                <button type="button" class="btn btn-primary btn-full" data-action="invite:goSignIn">
                    <i data-lucide="log-in" aria-hidden="true"></i> ${t('invite.signIn')}
                </button>
            </div>
        `;
    },

    messageView(icon, title, body, action) {
        return html`
            ${this.header(title)}
            <p class="invite-body">${body}</p>
            ${action === 'retry' ? html`
                <div class="invite-actions">
                    <button type="button" class="btn btn-primary btn-full" data-action="invite:retry">
                        <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('common.retry')}
                    </button>
                </div>
            ` : ''}
        `;
    },

    /** The link is good: a form, or a choice when somebody is already signed in. */
    readyView(s) {
        const peek = s.peek || {};
        const isReset = peek.purpose === 'reset';
        const viewer = peek.viewer || null;
        const title = isReset
            ? t('invite.reset.title')
            : html`${t('invite.welcomeTo')} <bdi dir="auto">${peek.tenantName || ''}</bdi>`;
        const subtitle = isReset
            ? (peek.email ? this.withValue('invite.reset.for', { email: peek.email }, 'email') : '')
            : (peek.inviter ? this.withValue('invite.inviter', { inviter: peek.inviter }, 'inviter') : t('invite.intro'));

        // Somebody is signed in on this browser: the page offers what makes sense for who they are, before any form.
        if (!isReset && viewer && viewer.signedIn) return this.viewerView(peek, viewer, title);

        return html`
            ${this.header(title, subtitle)}
            ${UI.inAppHint(s.inApp)}
            ${!isReset ? html`
                <p class="invite-role">
                    ${t('invite.roleLine')}
                    <span class="role-chip" title="${t(`roles.${peek.role}.what`)}">${t(`roles.${peek.role}`)}</span>
                </p>
            ` : ''}
            ${this.formView(s, peek, isReset)}
        `;
    },

    /** Signed in already: add the tenant to that account, or sign out and make a new one. */
    viewerView(peek, viewer, title) {
        if (viewer.platformAdmin) {
            return html`
                ${this.header(title)}
                <p class="invite-body">${t('invite.viewer.admin')}</p>
                <div class="invite-actions">
                    <button type="button" class="btn btn-primary btn-full" data-action="invite:signOutAndContinue">
                        <i data-lucide="log-out" aria-hidden="true"></i> ${t('invite.viewer.signOut')}
                    </button>
                </div>
            `;
        }
        const mismatch = viewer.emailMatches === false;
        return html`
            ${this.header(title)}
            <p class="invite-body">
                ${mismatch
                    ? this.withValue('invite.viewer.mismatch', { invited: peek.email || '', email: viewer.email || '' }, 'invited')
                    : this.withValue('invite.viewer.signedInAs', { email: viewer.email || '' }, 'email')}
            </p>
            <div id="invite-error" class="login-error ${this.error ? '' : html.raw('hidden')}" role="alert">${this.error ? this.errorText(this.error) : ''}</div>
            <div class="invite-actions">
                ${mismatch ? '' : html`
                    <button type="button" class="btn btn-primary btn-full" data-action="invite:addToAccount">
                        <i data-lucide="user-check" aria-hidden="true"></i> ${t('invite.viewer.add', { tenant: peek.tenantName || '' })}
                    </button>
                `}
                <button type="button" class="btn ${mismatch ? html.raw('btn-primary') : html.raw('btn-secondary')} btn-full" data-action="invite:signOutAndContinue">
                    <i data-lucide="log-out" aria-hidden="true"></i> ${t('invite.viewer.signOut')}
                </button>
            </div>
        `;
    },

    formView(s, peek, isReset) {
        const email = peek.email || s.email || '';
        const locked = Boolean(peek.email);
        const days = Number(peek.sessionDays) || 30;
        return html`
            <form id="invite-form" class="login-form" data-submit="invite:submit" novalidate>
                <div class="form-group">
                    <label class="form-label" for="invite-email">${t('login.email')}</label>
                    <input class="field" type="email" id="invite-email" name="email" dir="ltr" autocomplete="username"
                           inputmode="email" autocapitalize="none" spellcheck="false" placeholder="you@example.com"
                           value="${email}" ${locked ? html.raw('readonly') : html.raw('required')}
                           ${locked && !isReset ? html.raw('aria-describedby="invite-email-hint"') : ''}>
                    ${locked && !isReset ? html`<p class="form-hint" id="invite-email-hint">${t('invite.emailLocked')}</p>` : ''}
                </div>
                <div class="form-group">
                    <label class="form-label" for="invite-password">${isReset ? t('invite.reset.password') : t('invite.password')}</label>
                    <div class="invite-password">
                        <input class="field" type="password" id="invite-password" name="password" dir="ltr"
                               autocomplete="new-password" minlength="12" required aria-describedby="invite-password-hint">
                        <button type="button" class="icon-btn invite-reveal" data-action="invite:toggleReveal"
                                aria-pressed="false" aria-controls="invite-password"
                                aria-label="${t('invite.show')}" title="${t('invite.show')}">
                            <i data-lucide="eye" aria-hidden="true"></i>
                        </button>
                    </div>
                    <p class="form-hint" id="invite-password-hint">
                        ${t('invite.passwordHint')}
                        <button type="button" class="invite-suggest" data-action="invite:suggest">${t('invite.suggest')}</button>
                    </p>
                    <p class="form-hint invite-suggested" id="invite-suggested" role="status"></p>
                </div>
                <div class="check-row">
                    <input type="checkbox" id="invite-keep" name="keepSignedIn" checked>
                    <div class="check-text">
                        <label class="check-label" for="invite-keep">${t('invite.keep', { count: days })}</label>
                    </div>
                </div>
                <p id="invite-error" class="login-error ${this.error ? '' : html.raw('hidden')}" role="alert">${this.error ? this.errorText(this.error) : ''}</p>
                <button type="button" id="invite-signin-add" class="btn btn-secondary btn-full ${this.error && this.error.code === 'EMAIL_EXISTS' ? '' : html.raw('hidden')}"
                        data-action="invite:goSignInToAdd">
                    <i data-lucide="log-in" aria-hidden="true"></i> ${t('invite.signInToAdd', { tenant: peek.tenantName || '' })}
                </button>
                <button type="submit" id="invite-submit" class="btn btn-primary btn-full">
                    <i data-lucide="${isReset ? 'key-round' : 'log-in'}" aria-hidden="true"></i>
                    <span>${isReset ? t('invite.reset.submit') : t('invite.submit')}</span>
                </button>
                ${isReset ? '' : html`
                    <button type="button" class="login-alt-link" data-action="invite:goSignIn">${t('invite.haveAccount')}</button>
                `}
            </form>
        `;
    },

    /** A refusal from `accept`, in the interface's language: by its code, never by the server's English. */
    errorText(error) {
        const known = ['EMAIL_EXISTS', 'WEAK_PASSWORD', 'BAD_EMAIL', 'EMAIL_MISMATCH', 'ADMIN_SESSION', 'RATE_LIMITED'];
        const code = error && error.code;
        if (!known.includes(code)) return t('invite.err.generic');
        return t(`invite.err.${code}`, { tenant: (this.peek && this.peek.tenantName) || '', seconds: (error && error.wait) || 1 });
    },

    // ─── Running ─────────────────────────────────────────────────────────────

    host() {
        return document.getElementById('invite-card');
    },

    /** Paint the current state into the card, and keep the heading where a screen reader will start. */
    paint(focusHeading) {
        const host = this.host();
        if (!host) return;
        const typed = document.getElementById('invite-email');
        if (typed && !typed.readOnly) this.email = typed.value;
        host.innerHTML = esc(html`
            <button type="button" class="lang-toggle login-lang" data-lang-toggle
                    lang="en" dir="ltr" aria-label="Switch language"
                    data-action="app:toggleLanguage">English</button>
            ${this.view({ phase: this.phase, peek: this.peek, wait: this.wait, email: this.email, inApp: UI.inAppBrowser() })}
        `);
        UI.icons(host);
        if (typeof App !== 'undefined' && App.renderLanguageToggle) App.renderLanguageToggle();
        if (focusHeading) {
            const heading = document.getElementById('invite-title');
            if (heading && typeof heading.focus === 'function') heading.focus();
        }
    },

    /** Called by `App.showInvite()` every time the invite hash is opened. */
    async start() {
        this.phase = 'loading';
        this.peek = null;
        this.error = null;
        this.email = '';
        this.busy = false;
        this.paint(true);

        const token = App.inviteToken();
        if (!token) {
            this.phase = 'invalid';
            this.paint(true);
            return;
        }
        try {
            this.peek = await API.peekInvite(token);
            this.phase = 'ready';
        } catch (err) {
            this.fail(err);
        }
        this.paint(true);
    },

    /** The state a failed `peek` leaves: a refusal of the link, a throttle, or a broken connection. */
    fail(err) {
        if (err && err.status === 410) this.phase = 'invalid';
        else if (err && err.status === 429) {
            this.phase = 'throttled';
            this.wait = this.retryAfter(err);
        } else this.phase = 'failed';
    },

    retryAfter(err) {
        const body = err && err.body;
        const text = body && typeof body.error === 'string' ? body.error : '';
        const match = /(\d+)\s*s/.exec(text);
        return match ? Number(match[1]) : 5;
    },

    retry() {
        return this.start();
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    /** The form: create the account (or reset the password) and go in. */
    async submit(form, event) {
        event.preventDefault();
        if (this.busy) return;
        const data = new FormData(form);
        const email = (data.get('email') || '').toString().trim();
        const password = (data.get('password') || '').toString();
        const keepSignedIn = data.get('keepSignedIn') === 'on';
        const isReset = this.peek && this.peek.purpose === 'reset';

        // Checked here so the answer is instant and in the page's language; the server checks again and has the last word.
        if (!isReset && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return this.showError({ code: 'BAD_EMAIL' }, 'invite-email');
        if (password.length < 12) return this.showError({ code: 'WEAK_PASSWORD' }, 'invite-password');

        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        this.busy = true;
        try {
            const result = await API.acceptInvite({ token: App.inviteToken(), email: isReset ? undefined : email, password, keepSignedIn });
            await App.completeInvite(result, email || (this.peek && this.peek.email) || '');
        } catch (err) {
            this.busy = false;
            restore();
            this.afterRefusal(err);
        }
        return undefined;
    },

    /** Add the tenant to the account that is signed in, with no password: the session already says who it is. */
    async addToAccount(button) {
        if (this.busy) return;
        const restore = UI.actionBusy(button);
        if (!restore) return;
        this.busy = true;
        try {
            const result = await API.acceptInvite({ token: App.inviteToken() });
            await App.completeInvite(result, '');
        } catch (err) {
            this.busy = false;
            restore();
            this.afterRefusal(err);
        }
    },

    /**
     * What a refused `accept` leaves on the page: the link dying or the throttle is a different screen; anything else is a
     * message on the form, which keeps what was typed (the password included: the page is not repainted).
     */
    afterRefusal(err) {
        if (err && (err.status === 410 || err.status === 429)) {
            this.fail(err);
            this.paint(true);
            return;
        }
        const body = err && err.body;
        const code = err && err.isNetworkError ? 'NETWORK' : body && body.code;
        const field = code === 'EMAIL_EXISTS' || code === 'BAD_EMAIL' || code === 'EMAIL_MISMATCH' ? 'invite-email' : 'invite-password';
        this.showError({ code, wait: 0 }, field);
    },

    /** Say what is wrong where the person is looking, without repainting the form: what they typed stays. */
    showError(error, fieldId) {
        this.error = error;
        const holder = document.getElementById('invite-error');
        if (holder) {
            holder.textContent = this.errorText(error);
            holder.classList.remove('hidden');
        }
        const signIn = document.getElementById('invite-signin-add');
        if (signIn) signIn.classList.toggle('hidden', !(error && error.code === 'EMAIL_EXISTS'));
        const field = fieldId ? document.getElementById(fieldId) : null;
        if (field && typeof field.focus === 'function') field.focus();
    },

    toggleReveal(button) {
        const field = document.getElementById('invite-password');
        if (!field) return;
        const show = field.type === 'password';
        field.type = show ? 'text' : 'password';
        // The name stays "Show password" and `aria-pressed` carries the state: a label that changes as well as a pressed
        // state is read twice by a screen reader.
        button.setAttribute('aria-pressed', show ? 'true' : 'false');
        const icon = button.querySelector('[data-lucide]');
        if (icon) icon.setAttribute('data-lucide', show ? 'eye-off' : 'eye');
        UI.icons(button);
    },

    /**
     * A password to start from: four groups of four letters and digits, drawn from an alphabet with nothing easy to
     * misread (no 0/O, 1/l/I). 54 symbols over 16 places is about 92 bits, drawn with `crypto.getRandomValues` and
     * rejection sampling so no symbol is likelier than another.
     */
    suggestPassword() {
        const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const limit = 256 - (256 % alphabet.length);
        const out = [];
        while (out.length < 16) {
            const bytes = new Uint8Array(32);
            crypto.getRandomValues(bytes);
            for (const b of bytes) {
                if (b < limit && out.length < 16) out.push(alphabet[b % alphabet.length]);
            }
        }
        return [0, 4, 8, 12].map((i) => out.slice(i, i + 4).join('')).join('-');
    },

    suggest() {
        const field = document.getElementById('invite-password');
        if (!field) return;
        field.value = this.suggestPassword();
        // Shown, not hidden: a password the person cannot read is one they cannot save anywhere.
        field.type = 'text';
        const reveal = document.querySelector('.invite-reveal');
        if (reveal) {
            reveal.setAttribute('aria-pressed', 'true');
            const icon = reveal.querySelector('[data-lucide]');
            if (icon) icon.setAttribute('data-lucide', 'eye-off');
            UI.icons(reveal);
        }
        // The region is already on the page and empty, so putting words in it is what makes a screen reader say them.
        const note = document.getElementById('invite-suggested');
        if (note) note.textContent = t('invite.suggested');
        field.focus();
        field.select();
    },

    /** The link is unusable, or the address has an account: the way on is the login. */
    goSignIn() {
        App.leaveInviteForLogin(false);
    },

    /** "Sign in to add {tenant}": the link stays, and after signing in the page comes back to it with that session. */
    goSignInToAdd() {
        const typed = document.getElementById('invite-email');
        App.leaveInviteForLogin(true, typed ? typed.value.trim() : this.email);
    },

    /** Drop the signed-in session this browser holds (an admin's, or somebody else's) and show the form. */
    signOutAndContinue() {
        API.clearToken();
        if (App.session) App.session = null;
        this.start();
    },
};

UI.registerActions('invite', {
    submit: (el, e) => { const p = InvitePage.submit(el, e); if (p && p.catch) p.catch((err) => UI.toast((err && err.message) || t('error.unexpected'), 'error')); },
    addToAccount: (el) => { const p = InvitePage.addToAccount(el); if (p && p.catch) p.catch((err) => UI.toast((err && err.message) || t('error.unexpected'), 'error')); },
    toggleReveal: (el) => InvitePage.toggleReveal(el),
    suggest: () => InvitePage.suggest(),
    goSignIn: () => InvitePage.goSignIn(),
    goSignInToAdd: () => InvitePage.goSignInToAdd(),
    signOutAndContinue: () => InvitePage.signOutAndContinue(),
    retry: () => InvitePage.retry(),
});
