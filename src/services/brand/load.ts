/**
 * A tenant's render brand, from the database (Brand Kit, contract §3.2). `resolve.ts` is the pure half.
 *
 * Only a STORED profile can hold a logo or the switch (a PATCH stores one), so a tenant with none is `NO_BRAND`: the owner, whose
 * legacy settings never held either, is that until he opts in. Call it before any transaction opens, or with the transaction's own
 * client: a second checkout from the pool inside a transaction can wait on itself. Errors propagate, as `getStudioSettings`' do.
 */
import { pool } from '../../config/db.js';
import { loadStoredProfile } from '../profile/store.js';
import type { Exec } from '../studio/common.js';
import { NO_BRAND, renderBrandOf, type RenderBrand } from './resolve.js';

export async function loadRenderBrand(creatorId: string, exec: Exec = pool): Promise<RenderBrand> {
    const stored = await loadStoredProfile(creatorId, exec);
    return stored ? renderBrandOf(stored.profile) : NO_BRAND;
}
