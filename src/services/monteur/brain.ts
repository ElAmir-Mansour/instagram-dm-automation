/**
 * Which brain a tenant's Monteur calls really go to (P32, docs/onboarding/06 "The owner's rules, enforced in code").
 *
 * `monteur.brain` is a setting, and a setting can say something the rules do not allow. The decision that matters is made here, once,
 * where the sweep and the Analyst are about to ask:
 *
 *   `claude_mac`   the Mac, exactly as before. Not decided here at all: `think()` refuses a tenant the Mac is not for (G1).
 *   `gemini`       the Studio's writer chain, exactly as before.
 *   `api`          the AI providers layer (`tenant_monteur_think`), on the operator's key. **Only for a tenant the Mac is not for.**
 *                  For the owner, or a tenant on `studio.mac_brain_tenants`, `api` is the Mac: his work never goes through the layer,
 *                  and the layer would refuse it anyway (`MacBrainTenantRefused`). Pinning it here means a stored `api` on his row, by
 *                  a mistake or a script, still gives the Mac's request, not an error and not a bill on the operator's key.
 *
 * Only `api` costs a read: `claude_mac` and `gemini` are answered with none, so the owner's path asks the database exactly what it always did.
 * A read that fails is a throw, never an answer: the call waits for the database rather than guessing which side of the rule the tenant is on.
 */
import { isMacBrainAllowed } from '../macBrain.js';
import type { MonteurBrain } from '../studio/settingsTypes.js';

export async function effectiveBrain(creatorId: string, configured: MonteurBrain): Promise<MonteurBrain> {
    if (configured !== 'api') return configured;
    return (await isMacBrainAllowed(creatorId)) ? 'claude_mac' : 'api';
}
