/**
 * One clock, the workspace's (R2-SC-1, R2-CA-7). The device is in Dubai and the workspace in Riyadh, one hour apart: a time read or
 * filled in the device's zone is a different instant from the one the card says.
 *
 * The REAL shipped files in a `node:vm` context. The process runs in Dubai (`TZ`), so `Intl` in the page is the Dubai device's.
 */
process.env.TZ = 'Asia/Dubai';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, type Json } from './_harness.js';

const RIYADH = 'Asia/Riyadh';
/** 12:00 on Friday 1 Jan 2027 in Riyadh (UTC+3), 13:00 in Dubai (UTC+4). */
const CARD_ISO = '2027-01-01T09:00:00.000Z';

/** `new FormData(form)` for a fake form: the fields a real one would have read. */
class FakeFormData {
    private readonly fields: Record<string, unknown>;
    constructor(form: { fields: Record<string, unknown> }) { this.fields = form.fields; }
    get(name: string): unknown { return name in this.fields ? this.fields[name] : null; }
    getAll(name: string): unknown[] { return name in this.fields ? [this.fields[name]] : []; }
    has(name: string): boolean { return name in this.fields; }
}

function loadPosts(lang: 'ar' | 'en' = 'en', workspaceZone: string | null = RIYADH): { h: Json; API: Json; P: Json; modal(): string } {
    const Admin = { emptyState: () => '', confirm: () => {} };
    const API: Json = { token: 't' };
    const session = workspaceZone ? { workspace: { owner: true, metaConnect: 'operator', timezone: workspaceZone } } : { workspace: null };
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/posts.js'], globals: { API, FormData: FakeFormData, Admin, App: { canOperate: () => true, session } } });
    let shown = '';
    h.UI.showModal = (markup: unknown) => { shown = String(markup); };
    return { h, API, P: h.run('PostsPage'), modal: () => shown };
}

const fakeForm = (fields: Record<string, unknown>, id?: string): Json => ({ fields, dataset: { id }, querySelector: () => ({ disabled: false, innerHTML: '' }) });
const submitEvent = { preventDefault: (): void => {} };

describe('the workspace zone reaches every role through the session', () => {
    it('UI.zone() prefers the zone /auth/me carried, then what a screen set, then the device', () => {
        const { h } = loadPosts('en', RIYADH);
        assert.equal(h.UI.deviceZone(), 'Asia/Dubai');
        assert.equal(h.UI.zone(), RIYADH);
        assert.equal(h.UI.zone('Africa/Cairo'), 'Africa/Cairo', 'a screen that has just read its own settings still wins');
        const none = loadPosts('en', null);
        assert.equal(none.h.UI.zone(), 'Asia/Dubai', 'no workspace zone: the old fallback');
        none.h.UI.setZone('Europe/London');
        assert.equal(none.h.UI.zone(), 'Europe/London');
    });
});

describe('Scheduler Edit (Dubai device, Riyadh workspace)', () => {
    const post = { id: 'p1', platform: 'instagram', post_type: 'image', status: 'PENDING', caption: 'c', media_url: 'https://cdn.test/a.jpg', scheduled_time: CARD_ISO };

    it('fills the time the card shows (12:00), names the city and the device difference', () => {
        const r = loadPosts();
        r.P.posts = [post];
        r.P.showEditModal('p1');
        const m = r.modal();
        assert.match(m, /name="scheduled_time"\s+value="2027-01-01T12:00"/);
        assert.match(m, /Publish time \(Riyadh time\)/);
        assert.match(m, /This device is on Dubai time; times here are Riyadh time\./);
        assert.match(m, /Jan 1, 2027, 12:00 \(Riyadh\)|1 Jan 2027, 12:00 \(Riyadh\)|Jan 1, 2027 at 12:00 \(Riyadh\)|12:00 \(Riyadh\)/, 'the expected-publish line names the zone');
    });

    it('says it in Arabic', () => {
        const r = loadPosts('ar');
        r.P.posts = [post];
        r.P.showEditModal('p1');
        assert.match(r.modal(), /موعد النشر \(بتوقيت الرياض\)/);
        assert.match(r.modal(), /هذا الجهاز على توقيت دبي، والمواعيد هنا بتوقيت الرياض\./);
    });

    it('saving the value it shows keeps the same UTC instant', async () => {
        const r = loadPosts();
        const sent: Json[] = [];
        r.API.updateScheduledPost = (_id: unknown, body: Json) => { sent.push(JSON.parse(JSON.stringify(body))); return Promise.resolve({}); };
        r.P.posts = [post];
        r.P.showEditModal('p1');
        await r.P.handleEdit(fakeForm({ platform: 'instagram', post_type: 'image', caption: 'c', media_url: 'https://cdn.test/a.jpg', scheduled_time: '2027-01-01T12:00' }, 'p1'), submitEvent);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].scheduled_time, CARD_ISO);
    });

    it('shows no device hint when the device is already on the workspace zone', () => {
        const r = loadPosts('en', 'Asia/Dubai');
        r.P.posts = [post];
        r.P.showEditModal('p1');
        assert.doesNotMatch(r.modal(), /This device is on/);
        assert.match(r.modal(), /Publish time \(Dubai time\)/);
    });
});

describe('the composer (Dubai device, Riyadh workspace)', () => {
    it('defaults to an hour from now in the workspace zone, with min in the same zone', () => {
        const r = loadPosts();
        r.P.showCreateModal();
        const m = r.modal();
        const value = /name="scheduled_time"\s+value="([^"]+)"/.exec(m)![1]!;
        const min = /min="([^"]+)"/.exec(m)![1]!;
        const expectedMin = r.h.UI.zoneInputValue(new Date(), RIYADH);
        const expectedDefault = r.h.UI.zoneInputValue(new Date(Date.now() + 3600 * 1000), RIYADH);
        // Compare as instants so a minute boundary between the two reads cannot flake.
        const gap = (a: string, b: string): number => Math.abs(Date.parse(`${a}:00Z`) - Date.parse(`${b}:00Z`));
        assert.ok(gap(min, expectedMin) <= 60000, `${min} vs ${expectedMin}`);
        assert.ok(gap(value, expectedDefault) <= 60000, `${value} vs ${expectedDefault}`);
        assert.notEqual(min, r.h.UI.toLocalInputValue(new Date()), 'not the Dubai device\'s wall clock');
        assert.match(m, /Publish time \(Riyadh time\)/);
    });

    it('reads a typed time as Riyadh wall time', async () => {
        const r = loadPosts();
        const sent: Json[] = [];
        r.API.createScheduledPost = (body: Json) => { sent.push(JSON.parse(JSON.stringify(body))); return Promise.resolve({ id: 'n', platform: body.platform, status: 'PENDING' }); };
        await r.P.handleCreate(fakeForm({ platform: 'instagram', post_type: 'image', caption: 'c', media_url: 'https://cdn.test/a.jpg', scheduled_time: '2027-01-01T12:00' }), submitEvent);
        assert.equal(sent[0]?.scheduled_time, CARD_ISO);
    });
});

describe('the carousel editor\'s custom time', () => {
    it('is read in the workspace zone, not the device\'s', () => {
        const h = loadDashboard({ files: ['dashboard/js/pages/studio.js'], globals: { API: { token: 't' }, FormData: FakeFormData, App: { canOperate: () => true, session: { workspace: { timezone: RIYADH } } } } });
        const S = h.run('StudioPage');
        const out = S.readSchedule(fakeForm({ slot: 'custom', custom_time: '2099-01-01T12:00' }));
        assert.equal(out.ok, true);
        assert.equal(out.body.scheduled_time, '2099-01-01T09:00:00.000Z');
    });
});
