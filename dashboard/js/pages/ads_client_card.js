/**
 * The client's own block at the end of Settings → Meta ads (A11, "managed clients").
 *
 * For a MANAGED workspace (not the platform owner's own), the switch "Share my ad spend with my account manager", read from
 * `GET /api/ads/settings/share-spend` (`{ shareSpend, ceiling, managed }`). Only the owner can change it. The ceiling itself is shown by
 * the card above (A1's `adsCeilingLine`, with the account's currency), so it is not repeated here.
 *
 * It renders NOTHING, and throws nothing, when the route answers 404 (ads are off for the workspace) or fails in any other way: this block
 * is an extra on a card that works without it. Settings gives it a placeholder (`#ads-client-block`) and calls `mount()` after each
 * paint; the module draws into that placeholder by itself and holds no state across paints except the last answer.
 */
const AdsClientCard = {
    HOST: 'ads-client-block',
    data: null,
    _busy: false,

    resetTenantState() {
        this.data = null;
        this._busy = false;
    },

    host() {
        return typeof document !== 'undefined' ? document.getElementById(this.HOST) : null;
    },

    /** Load and draw. Resolves in every case; a refusal or a failure leaves the placeholder empty. */
    async mount() {
        const host = this.host();
        if (!host) return;
        let data = null;
        try {
            data = await API.getAdsShareSpend();
        } catch (_) {
            data = null;
        }
        // The page may have been redrawn while the answer was on its way: draw into whatever placeholder is there now.
        this.data = data && typeof data === 'object' ? data : null;
        this.paint();
    },

    paint() {
        const host = this.host();
        if (!host) return;
        try {
            host.innerHTML = esc(this.body(this.data));
            UI.icons(host);
        } catch (err) {
            console.warn('Could not draw the account manager block:', err);
            host.innerHTML = '';
        }
    },

    /** The block's markup, or '' when there is nothing to say. */
    body(data) {
        if (!data) return '';
        if (data.managed !== true) return '';
        const owner = typeof App !== 'undefined' && typeof App.canAdminister === 'function' ? App.canAdminister() : true;
        const on = data.shareSpend === true;
        return html`
            <div class="settings-block mbs-4" id="ads-client-card">
                <h3 class="form-label">${t('adsClient.title')}</h3>
                <div id="ads-client-share-error" aria-live="polite"></div>
                    <div class="switch-row mbs-3">
                        <label class="switch" for="ads-client-share">
                            <span class="sr-only">${t('adsClient.share.label')}</span>
                            <input type="checkbox" id="ads-client-share" data-change="adsClient:toggle" aria-describedby="ads-client-share-hint"
                                   ${on ? html.raw('checked') : ''} ${owner ? '' : html.raw('disabled')}>
                            <span class="switch-track"></span>
                        </label>
                        <span class="switch-text">
                            <span class="switch-label">${t('adsClient.share.label')}</span>
                            <span class="form-hint" id="ads-client-share-hint">${t('adsClient.share.hint')}${owner ? '' : html` ${t('adsClient.share.ownerOnly')}`}</span>
                        </span>
                    </div>
                    <p class="mbs-2">${UI.helpLink('ads#for-clients', t('adsClient.help'))}</p>
            </div>
        `;
    },

    async toggle(input) {
        const on = !!input.checked;
        if (this._busy) { input.checked = !on; return; }
        this._busy = true;
        try {
            const answer = await API.setAdsShareSpend(on);
            if (answer && typeof answer === 'object') this.data = answer;
            else this.data = Object.assign({}, this.data, { shareSpend: on });
            UI.toast(t(on ? 'adsClient.share.savedOn' : 'adsClient.share.savedOff'), 'success');
        } catch (err) {
            input.checked = !on;
            const code = err && typeof err.code === 'string' ? err.code : '';
            const known = code && t(`errors.${code}`) !== `errors.${code}`;
            UI.toast(known ? UI.errorText(err).sentence : t('adsClient.share.failed'), 'error');
        } finally {
            this._busy = false;
        }
        this.paint();
    },
};

UI.registerActions('adsClient', {
    toggle: (el) => { AdsClientCard.toggle(el).catch((err) => console.warn('Share-spend switch failed:', err)); },
});
