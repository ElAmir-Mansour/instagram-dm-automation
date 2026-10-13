/**
 * What the landing's loader imports (L10, L11): the engine, the hero, and the list of diagram scenes that may be fetched later.
 *
 * The hero is built in here; every other scene is its own chunk (scripts/hero3d/scenes/*.mjs) named by its host's
 * `data-scene3d` and fetched only when that host nears the viewport (engine.mjs).
 */
import { start } from './engine.mjs';
import { createHero } from './hero.mjs';

/**
 * @param {Iterable<HTMLElement>} stages every .hero-stage (one per language article)
 * @param {{lite?: boolean}} options
 */
export function mount(stages, options = {}) {
    const hosts = [...stages].map((el) => ({ el, id: el.id, create: createHero }));
    const scenes = [...document.querySelectorAll('[data-scene3d]')].map((el) => ({ el, id: el.id, url: el.getAttribute('data-scene3d') }));
    return start([...hosts, ...scenes], options);
}
