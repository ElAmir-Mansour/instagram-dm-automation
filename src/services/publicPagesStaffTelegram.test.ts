/**
 * /privacy says what staff Telegram notices (U3, `notifyPeople.ts`, `telegramLink.ts`) do, BEFORE the code does it (the page leads, the code
 * keeps its claims): in section 3, section 4 and section 5, in both languages, and in the claim ledger the next change reads.
 *
 * What is pinned is the promise and that the code the ledger names exists: a claim whose function was renamed away fails here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const page = readFileSync('public/privacy.html', 'utf8');
const flat = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const en = flat(page);

describe('/privacy: staff Telegram notices', () => {
    it('section 3 says WHO may be told (staff who linked their own chat, as the workspace\'s owner chose), in both languages', () => {
        assert.ok(en.includes('the staff of that workspace who linked their own Telegram chat to our Telegram sender account themselves, as the workspace\'s owner chose.'));
        assert.ok(en.includes('الذين ربطوا محادثتهم الخاصة بحسابنا المرسِل على تيليجرام بأنفسهم'));
    });

    it('section 4 says what is kept per person (the chat id and the first name), until the link ends, and that unlinking deletes both', () => {
        assert.ok(en.includes('for each person we keep the id of their Telegram chat and the first name Telegram gave us, for as long as the link exists. Unlinking deletes both at once.'));
        assert.ok(en.includes('نحتفظ لكل شخص بمعرّف محادثته على تيليجرام وبالاسم الأول الذي أعطاه إياه تيليجرام، ما دام الربط قائماً. وإلغاء الربط يحذفهما في الحال.'));
    });

    it('the claim ledger names both files, and the functions it names exist', () => {
        assert.match(page, /STAFF TELEGRAM NOTICES — ADDED 2026-11-28/);
        const people = readFileSync('src/services/notifyPeople.ts', 'utf8');
        const link = readFileSync('src/services/telegramLink.ts', 'utf8');
        for (const [file, fn] of [[people, 'notifyPeople'], [link, 'startLink'], [link, 'confirmLink'], [link, 'unlink']] as const) {
            assert.match(file, new RegExp(`export async function ${fn}\\(`), fn);
        }
        assert.match(page, /notifyPeople\.ts[\s\S]*telegramLink\.ts/);
    });

    it('the promises hold in the code: a private chat only, a single-use code, and nothing of the alert stored', () => {
        const link = readFileSync('src/services/telegramLink.ts', 'utf8');
        assert.match(link, /m\.chatType === 'private' && m\.text === expected/);
        assert.match(link, /consumeOAuthState\(code, 'telegram'\)/);
        const people = readFileSync('src/services/notifyPeople.ts', 'utf8');
        assert.doesNotMatch(people, /INSERT INTO (messages|notifications|alerts)/i, 'no table of notices exists');
    });
});
