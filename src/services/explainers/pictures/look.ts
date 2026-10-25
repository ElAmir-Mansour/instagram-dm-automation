/**
 * The look of a tenant's explainers, as a picture needs it: the art direction and the recurring characters (`studio_settings.explainer`).
 *
 * Read with a query of its own and not through `getStudioSettings`: that one reads the whole settings row and then the Creator Profile, which can
 * be 128 KB, and a draw asks for two fields of one section. The explainer section is NOT one the profile owns (`STUDIO_PROFILE_PATHS`), so the
 * row is the truth, merged over the defaults exactly as `getStudioSettings` merges it (`overDefaults`).
 */
import { pool } from '../../../config/db.js';
import type { Exec } from '../../studio/common.js';
import { overDefaults } from '../../studio/settingsMerge.js';
import type { ExplainerCharacter } from '../../studio/settingsTypes.js';

export interface Look {
    /** The art direction every picture starts from. */
    style: string;
    /** Each has a key, an English description, and the approved reference picture once the owner has chosen one. */
    characters: ExplainerCharacter[];
}

export async function readLook(creatorId: string, exec: Exec = pool): Promise<Look> {
    const { rows } = await exec.query<{ explainer: unknown }>('SELECT explainer FROM studio_settings WHERE creator_id = $1', [creatorId]);
    const { style, characters } = overDefaults(rows[0] ? { explainer: rows[0].explainer } : {}).explainer;
    return { style, characters };
}
