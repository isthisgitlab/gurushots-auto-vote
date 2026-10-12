/**
 * postOutcome.ts — a spend's POST answer as an ActionResult.
 */

import { toActionResult } from '../../src/ts/api/postOutcome';

test('ok on a success body, a refusal is not unclear, an unclear one says so', () => {
    expect(toActionResult({ kind: 'body', body: { success: true } })).toEqual({ ok: true, raw: { success: true } });
    expect(toActionResult({ kind: 'body', body: { success: false } })).toEqual({
        ok: false,
        raw: { success: false },
    });
    expect(toActionResult({ kind: 'refused' })).toEqual({ ok: false, raw: null });
    expect(toActionResult({ kind: 'unclear' })).toEqual({ ok: false, raw: null, unclear: true });
});
