/**
 * Tests only: fake API keys for the tests of the AI layer, and the check that none of them appears in a place it must not.
 * Not a test file itself, so `npm test` does not run it. The keys are built here at run time and never written whole in the repository:
 * a key-shaped literal is what secret scanners block a push for.
 */
import assert from 'node:assert/strict';
import type { ProviderId } from '../llm/registry.js';

/** Distinct and key-shaped. Each ends in a marker (`ant1`, `oai2`, …) so a test can look for exactly what `last4` should show. */
export const FAKE_KEYS: Record<ProviderId, string> = {
    anthropic: 'sk-ant-' + 'AnthropicSentinel'.repeat(3) + 'ant1',
    openai: 'sk-proj-' + 'OpenaiSentinel'.repeat(3) + 'oai2',
    gemini: 'AIza' + 'GeminiSentinel'.repeat(3) + 'gem3',
    openrouter: 'sk-or-v1-' + 'OpenrouterSentinel'.repeat(3) + 'ort4',
    custom: 'custom-' + 'CustomSentinel'.repeat(3) + 'cus5',
};

/** A key must appear nowhere in `text`: not whole, not by its front, not by its middle. */
export function assertNoKey(text: string, label: string, keys: readonly string[] = Object.values(FAKE_KEYS)): void {
    for (const key of keys) {
        assert.ok(!text.includes(key), `${label}: contains a whole key`);
        assert.ok(!text.includes(key.slice(0, 20)), `${label}: contains the front of a key`);
        assert.ok(!text.includes(key.slice(8, -4)), `${label}: contains the middle of a key`);
    }
}
