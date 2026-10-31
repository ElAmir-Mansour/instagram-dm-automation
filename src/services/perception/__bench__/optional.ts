/**
 * Arms that wait for another PR (docs/specs/005-muse-sees P3 voice notes, P4 video memory) are pluggable: each is switched on by a flag, and while the module it measures is
 * not in this checkout it is SKIPPED, with a note that says which file it is waiting for. It is never faked: a benchmark that measured a stand-in would prove nothing about
 * the product, so the arm either runs the product's own module or says it did not run.
 *
 * "Present" means the file is there. A file that is there and breaks when it loads is an error and not an absence: it is thrown, so a half-merged module is not reported as
 * a module that has not landed.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Optional<T> = { present: true; module: T; file: string } | { present: false; why: string };

/** The module's source file under `root`, or null. Looked for as `.ts` (the repo's source) and `.js`. */
export function findModule(root: string, relative: string, exists: (file: string) => boolean = existsSync): string | null {
    for (const ext of ['.ts', '.js']) {
        const file = path.join(root, `${relative}${ext}`);
        if (exists(file)) return file;
    }
    return null;
}

/**
 * `relative` (for example `src/services/perception/transcribeVoice`) loaded from `root` when it exists. `importer` is `import()` in a run and a stand-in in a test; it is given a
 * `file://` URL, which `tsx` reads as it reads any other source file.
 */
export async function loadOptional<T>(
    root: string, relative: string, waitingFor: string, io: { exists?: (file: string) => boolean; importer?: (url: string) => Promise<unknown> } = {},
): Promise<Optional<T>> {
    const file = findModule(root, relative, io.exists);
    if (!file) return { present: false, why: `${relative}.ts is not in this checkout yet (${waitingFor})` };
    const importer = io.importer ?? ((url: string) => import(url));
    return { present: true, module: (await importer(pathToFileURL(file).href)) as T, file };
}
