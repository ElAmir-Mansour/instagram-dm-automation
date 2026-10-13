/**
 * A thrown error as one line for a report: its kind and the start of what it says. For the code that runs here (the
 * builders, the profile functions) that message names a rule or a missing property, not a row, but it is cut short
 * anyway: a report goes into a terminal and a chat window, and a tenant's words do not belong in either.
 */
export function describeFailure(err: unknown): string {
    const e = err as { name?: unknown; message?: unknown } | null;
    const name = typeof e?.name === 'string' ? e.name : 'Error';
    const message = typeof e?.message === 'string' ? e.message.replace(/\s+/g, ' ').slice(0, 160) : '';
    return `${name}: ${message}`;
}
