/**
 * How many reels a video gets (the owner, 2026-10-06: "more than one if it's big, 3 at most"):
 * one per started 10 minutes, at least one, never past `reels_per_video` — and the pick prompt
 * asks for that many plus the spares.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { candidatesWanted, pickUserPrompt, reelsForLength } from './pick.js';

describe('reelsForLength', () => {
    it('one per started 10 minutes, at least one, capped at the setting', () => {
        assert.equal(reelsForLength(5 * 60, 3), 1);
        assert.equal(reelsForLength(10 * 60, 3), 1, 'exactly ten minutes is still one');
        assert.equal(reelsForLength(11 * 60 + 1, 3), 2, 'the 11-minute lesson 6.2');
        assert.equal(reelsForLength(32 * 60 + 42, 3), 3, 'the 33-minute lesson 6.3');
        assert.equal(reelsForLength(90 * 60, 3), 3, 'never past the maximum');
        assert.equal(reelsForLength(45 * 60, 1), 1, 'a maximum of one is one, however long');
        assert.equal(reelsForLength(30, 3), 1);
    });
    it('an unknown or nonsense length takes the maximum; a nonsense maximum is one', () => {
        assert.equal(reelsForLength(null, 3), 3);
        assert.equal(reelsForLength(Number.NaN, 2), 2);
        assert.equal(reelsForLength(0, 3), 3);
        assert.equal(reelsForLength(20 * 60, 0), 1);
    });
});

describe('pickUserPrompt', () => {
    const lines = [{ n: 1, start: 0, end: 5, text: 'سطر', first: 0, last: 0 }] as any;
    const settings = { ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, reels_per_video: 3 } };
    it('asks for this video’s count plus the spares, not the setting’s', () => {
        assert.match(pickUserPrompt({ lines, settings, lessons: [], keep: 1 }), new RegExp(`Pick up to ${candidatesWanted(1)} clips`));
        assert.match(pickUserPrompt({ lines, settings, lessons: [], keep: 2 }), new RegExp(`Pick up to ${candidatesWanted(2)} clips`));
        assert.match(pickUserPrompt({ lines, settings, lessons: [] }), new RegExp(`Pick up to ${candidatesWanted(3)} clips`), 'without a count: the setting');
    });
});
