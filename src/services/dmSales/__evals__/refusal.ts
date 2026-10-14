/**
 * What the evaluation refuses to do, and says so (docs/DM_SALES_PLAN.md §11: "no Meta call", spend that belongs to no tenant).
 *
 * The harness builds every prompt from the committed fixtures (`fixtures.ts`) and sends nothing. It never reads a tenant's profile, a
 * conversation or a message, and it cannot be pointed at one: there is no flag for it, and a name that is not a fixture is refused here,
 * by name, before any model is asked. The only database it touches is the AI providers layer's own, for the operator's keys and routes
 * and for the `ai_usage` row that records what the run cost, labelled `eval` and charged to no tenant.
 *
 * `refusal.test.ts` holds the rest of the promise to the source: the harness imports nothing that reads a conversation or sends a message.
 */
import { FIXTURE_NAMES, type EvalCase, type FixtureName } from './types.js';

/** The run was asked to do something the harness never does. The CLI exits 3 and prints the message. */
export class EvalRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EvalRefusal';
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isFixtureName = (value: unknown): value is FixtureName => typeof value === 'string' && (FIXTURE_NAMES as readonly string[]).includes(value);

/** Flags that would point the run at live data, each with what the person probably meant. All of them are refused. */
const LIVE_FLAGS: Readonly<Record<string, string>> = {
    tenant: 'a tenant', creator: 'a creator', 'creator-id': 'a creator', 'tenant-id': 'a tenant',
    conversation: 'a conversation', conversations: 'conversations', 'conversation-id': 'a conversation', inbox: 'the inbox', messages: 'messages',
    live: 'live data', db: 'the database', 'from-db': 'the database', profile: 'a stored profile', 'profile-id': 'a stored profile',
    send: 'sending a message', 'send-dm': 'sending a message', 'page-token': 'a Page access token', token: 'a Page access token',
};

const REFUSAL_TAIL = 'The evaluation runs on the fixtures in src/services/dmSales/__evals__/fixtures.ts only, and it sends nothing.';

/** The fixture a case names, or a refusal that says why a tenant id or anything else is not one. */
export function assertFixture(name: unknown, where: string): FixtureName {
    if (isFixtureName(name)) return name;
    if (typeof name === 'string' && UUID.test(name)) {
        throw new EvalRefusal(`${where}: "${name}" is a tenant id. ${REFUSAL_TAIL}`);
    }
    throw new EvalRefusal(`${where}: "${String(name).slice(0, 60)}" is not a fixture (${FIXTURE_NAMES.join(', ')}). ${REFUSAL_TAIL}`);
}

/** Refuses a command line that names live data: a tenant, a conversation, a stored profile. `flags` are the option names without dashes. */
export function assertNoLiveFlags(flags: readonly string[]): void {
    const hit = flags.find((f) => f in LIVE_FLAGS);
    if (hit) throw new EvalRefusal(`--${hit}: this would point the evaluation at ${LIVE_FLAGS[hit]}. ${REFUSAL_TAIL}`);
}

/** Refuses a run whose cases name anything but a fixture. */
export function assertFixturesOnly(cases: readonly Pick<EvalCase, 'id' | 'fixture'>[]): void {
    for (const c of cases) assertFixture(c.fixture, `case ${c.id}`);
}
