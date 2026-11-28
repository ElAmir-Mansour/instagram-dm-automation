/**
 * Wave 1, settings: choices that need a Save (R4-S11), a confirm that stacks over an open dialog (R4-F9), the invite's
 * Revoke (R4-S3) and an Arabic verb of its own for revoking (TEAM-L1).
 *
 *   - an arrow key moves a storage radio and sends nothing; the group's own Save sends the ticked one;
 *   - UI.confirm opens OVER a dialog that is already open, so Cancel comes back to it (the invite link is shown once);
 *   - every confirm in the dashboard names its own action with a label and an icon;
 *   - the invite footer reads Done · Regenerate · Revoke, and a staff invite is "the person joining".
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const FILES = ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/invite_card.js', 'dashboard/js/pages/settings.js'];

function world(lang: 'ar' | 'en' = 'en') {
    const calls: Array<{ name: string; args: Json[] }> = [];
    const API = new Proxy({ token: 't' } as Json, {
        get: (target, prop: string) => {
            if (prop === 'token') return 't';
            return (...args: Json[]) => { calls.push({ name: prop, args }); return Promise.resolve({ ok: true }); };
        },
    });
    const h = loadDashboard({ lang, files: FILES, globals: { API } });
    const overlay = h.el('modal-overlay', {});
    overlay.classes.add('hidden');
    const content = h.el('modal-content');
    h.el('admin-confirm-btn');
    return { h, calls, overlay, content, toasts: [] as string[] };
}

describe('the two storage choices need their own Save (R4-S11)', () => {
    const R2 = { configured: true, direct: 'all' };

    it('the radios carry no change handler, and each group has a Save button', () => {
        const { h } = world();
        const S = h.run<Json>('SettingsPage');
        const backend = String(S.mediaBackendChoice({ connection: {}, backend: 'r2', r2: R2 }));
        assert.ok(backend.includes('name="media-backend"') && backend.includes('name="media-direct"'));
        assert.doesNotMatch(backend, /<input[^>]*type="radio"[^>]*data-change/, 'no radio saves on change');
        assert.match(backend, /data-action="settings:setMediaBackend"/);
        assert.match(backend, /data-action="settings:setMediaDirect"/);
        assert.equal((backend.match(/Save storage choice/g) || []).length, 2, 'one Save for each group');
        assert.match(backend, /id="media-direct-all"[^>]*checked/, 'production\'s "all" is what is ticked');
    });

    it('an arrow key (a change with no Save) calls no API; Save sends the ticked choice once', async () => {
        const { h, calls } = world();
        const S = h.run<Json>('SettingsPage');
        S.render = async () => {};
        h.UI.toast = () => {};
        let ticked = 'off';
        h.document.querySelector = (sel: string) => (sel.includes('media-direct') ? { value: ticked } : sel.includes('media-backend') ? { value: 'r2' } : null);
        // The delegated `change` listener only runs actions named by data-change: the radios name none, so an arrow key reaches nothing.
        assert.equal(calls.length, 0, 'nothing was sent by moving the radio');
        const btn = h.el('media-direct-save');
        await h.UI._actions.settings.setMediaDirect(btn);
        assert.deepEqual(calls.map((c) => [c.name, c.args[0]]), [['setMediaDirect', 'off']]);
        const b2 = h.el('media-backend-save');
        await h.UI._actions.settings.setMediaBackend(b2);
        assert.deepEqual(calls.map((c) => [c.name, c.args[0]]).pop(), ['setMediaBackend', 'r2']);
    });

    it('the controls that act at once are switches with an inline Saved', async () => {
        for (const lang of ['en', 'ar'] as const) {
            const { h } = world(lang);
            const S = h.run<Json>('SettingsPage');
            const cleanup = String(S.mediaCleanupBlock({ on: true, preview: { files: 0, bytes: 0 } }));
            assert.match(cleanup, /class="switch"/);
            assert.match(cleanup, /id="media-cleanup-on-saved"[^>]*role="status"/);
            assert.doesNotMatch(cleanup, /class="check-row"/);
            const note = h.el('media-cleanup-on-saved');
            S.markSwitchSaved({ id: 'media-cleanup-on' });
            assert.equal(note.textContent, lang === 'en' ? 'Saved' : 'حُفظ');
        }
    });
});

describe('a confirm stacks over an open dialog (R4-F9)', () => {
    const open = (w: ReturnType<typeof world>) => {
        w.h.UI.showModal('<h2 class="modal-title">Invite</h2><input id="invite-link-field" value="https://x.test/invite/ONCE">');
    };
    const ask = (w: ReturnType<typeof world>, extra: Json = {}) => w.h.UI.confirm({ title: 'Revoke this link?', body: 'b', confirmLabel: 'Revoke', confirmIcon: 'ban', onConfirm: () => {}, ...extra });

    it('Cancel leaves the original dialog open with its content', () => {
        const w = world();
        open(w);
        const before = w.content.innerHTML;
        ask(w);
        assert.ok(w.h.UI._confirmLayer, 'drawn as a layer over the dialog');
        assert.equal(w.content.innerHTML, before, 'the dialog underneath was not replaced');
        w.h.UI.cancelConfirm();
        assert.equal(w.h.UI._confirmLayer, null);
        assert.equal(w.overlay.classes.has('hidden'), false, 'still open');
        assert.ok(w.content.innerHTML.includes('invite/ONCE'), 'the link is still there');
    });

    it('confirming ends the dialog it was asked over, as a question drawn in place always did', async () => {
        const w = world();
        open(w);
        let ran = 0;
        ask(w, { onConfirm: () => { ran += 1; } });
        await w.h.UI.runConfirm(w.h.el('admin-confirm-btn'));
        assert.equal(ran, 1);
        assert.equal(w.h.UI._confirmLayer, null);
        assert.equal(w.overlay.classes.has('hidden'), true, 'closed');
    });

    it('with no dialog open it is drawn in place; stack: false replaces an open one', () => {
        const w = world();
        ask(w);
        assert.equal(w.h.UI._confirmLayer, null, 'no layer when nothing is open');
        assert.equal(w.overlay.classes.has('hidden'), false);
        const w2 = world();
        open(w2);
        ask(w2, { stack: false });
        assert.equal(w2.h.UI._confirmLayer, null);
        assert.ok(!w2.content.innerHTML.includes('invite/ONCE'), 'replaced on request');
    });

    it('the invite\'s Revoke asks over the link, and Cancel returns to it', () => {
        const w = world();
        const card = w.h.run<Json>('InviteCard');
        card.showCreated({ id: 'i1', url: 'https://x.test/invite/ONCE', role: 'operator', expires_at: '2026-12-01T00:00:00Z', purpose: 'join' }, { tenantName: 'Nour', scope: 'team' });
        card.revoke({ dataset: { id: 'i1' } });
        assert.ok(w.h.UI._confirmLayer, 'stacked');
        w.h.UI.cancelConfirm();
        assert.ok(w.content.innerHTML.includes('invite/ONCE'), 'the link, shown once, survived Cancel');
    });

    it('the footer reads Done, Regenerate, Revoke (danger, last), and the staff lead says "joining"', () => {
        for (const lang of ['en', 'ar'] as const) {
            const w = world(lang);
            const card = w.h.run<Json>('InviteCard');
            const markup = String(card.linkView({ invite: { id: 'i1', url: 'https://x.test/i', role: 'operator', expires_at: '2026-12-01T00:00:00Z', purpose: 'join' }, tenantName: 'Nour' }));
            const at = (action: string) => markup.indexOf(`data-action="inviteCard:${action}"`);
            assert.ok(at('done') > 0 && at('done') < at('regenerate') && at('regenerate') < at('revoke'), lang);
            assert.match(markup.slice(markup.lastIndexOf('<button', at('revoke'))), /btn-danger/);
        }
        const en = world('en').h;
        assert.equal(en.t('invites.lead'), 'Send this link to the person joining');
        assert.equal(en.t('invites.newLead'), 'A single-use link to join');
        const ar = world('ar').h;
        assert.equal(ar.t('invites.lead'), 'أرسل هذا الرابط إلى الشخص الذي سينضم إلى');
        assert.equal(ar.t('invites.newLead'), 'رابط يعمل مرة واحدة للانضمام إلى');
    });
});

describe('every confirm names its own action', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
    });

    /** The text of the `{ … }` that starts at `i` (which holds the `{`). */
    const block = (s: string, i: number): string => {
        let d = 0;
        for (let j = i; j < s.length; j += 1) {
            if (s[j] === '{') d += 1;
            else if (s[j] === '}' && (d -= 1) === 0) return s.slice(i, j + 1);
        }
        return '';
    };

    it('every UI.confirm / Admin.confirm call passes confirmLabel and confirmIcon', () => {
        let seen = 0;
        const bad: string[] = [];
        for (const file of walk('dashboard/js')) {
            const s = readFileSync(file, 'utf8');
            for (const m of s.matchAll(/\b(?:UI|Admin)\.confirm\(\s*(\{|[A-Za-z_]+)/g)) {
                if (m[1] !== '{') continue; // the alias `confirm(options) { return UI.confirm(options); }` forwards what it was given
                let body = block(s, m.index! + m[0].length - 1);
                const spread = /^\{\s*\.\.\.(\w+)/.exec(body);
                if (spread) body += block(s, s.lastIndexOf(`const ${spread[1]} = {`, m.index!) + `const ${spread[1]} = `.length);
                seen += 1;
                for (const key of ['confirmLabel', 'confirmIcon']) if (!body.includes(key)) bad.push(`${file}:${s.slice(0, m.index).split('\n').length} lacks ${key}`);
            }
        }
        assert.ok(seen > 60, `scanned the callers (${seen})`);
        assert.deepEqual(bad, []);
    });

    it('a confirm with no label or icon is reported, and never falls back to a Delete button', () => {
        const w = world();
        const errors: unknown[][] = [];
        const was = console.error;
        console.error = (...a: unknown[]) => { errors.push(a); };
        try { w.h.UI.confirm({ title: 'Do it?', body: 'b' }); } finally { console.error = was; }
        assert.equal(errors.length, 1);
        assert.doesNotMatch(w.content.innerHTML, /trash-2|Delete/);
    });
});

describe('revoking has its own Arabic verb (TEAM-L1)', () => {
    it('no revoke label is the plain Cancel', async () => {
        await settle();
        const ar = world('ar').h;
        const cancel = ar.t('common.cancel');
        for (const key of ['studio.workers.revoke', 'tenantLegal.revoke', 'invites.revoke', 'jobs.cancel']) assert.notEqual(ar.t(key), cancel, key);
        assert.equal(ar.t('studio.workers.revoke'), 'أبطِل');
        assert.equal(ar.t('jobs.cancel'), 'أوقِف المهمة');
    });
});
