/** Reads a fixture file next to this one. Not a test file. */
import { readFileSync } from 'node:fs';

export const fixture = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
