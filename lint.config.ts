// @ttsc/lint configuration — runs inside the `pnpm typecheck` (ttsc --noEmit)
// pass over the tsconfig program (src/js/**/*.js only). This is an ADDITIONAL
// gate on the shared core, not an ESLint replacement: ESLint + Prettier keep
// owning .jsx, scripts/, tests, and all formatting. No `format` block here —
// its mere presence would enable the formatter and fight Prettier.
//
// Scope: EVERY rule below runs over the whole program — including files
// without `// @ts-check`. The @ts-check opt-in gates type-error REPORTING
// only; the checker still infers types for unchecked files, so even the
// typescript/* rules fire program-wide (verified: they flag files that never
// opted in). Don't expect a file to be exempt from this gate just because it
// isn't type-checked yet.
//
// Rule selection: type-aware promise rules (impossible in ESLint without a TS
// program) plus correctness rules that eslint:recommended does not enable, so
// the two gates never report the same finding twice.
//
// All rules are at "error" — the warning ratchet completed once the program
// hit zero warnings. Two gotchas for anyone adding code under this gate:
//  1. On an `async` function, JSDoc `@returns` must be `Promise<...>`. A bare
//     `@returns {object|null}` makes the checker type the function as
//     returning a non-Promise, so EVERY `await` of it fails
//     typescript/await-thenable (one such annotation once caused 16 hits).
//  2. `void` satisfies typescript/no-floating-promises at compile time only —
//     it adds no runtime handling. Pair it with `.catch`/try-catch wherever
//     the ignored rejection carries operationally meaningful failure
//     information; bare `void` is only for genuinely inconsequential
//     fire-and-forget calls (dialogs, useEffect kick-offs).
import type { ITtscLintConfig } from '@ttsc/lint';

export default {
    rules: {
        'no-var': 'error',
        'prefer-const': 'error',
        'no-throw-literal': 'error',
        'no-promise-executor-return': 'error',

        // Type-aware (Checker-backed) — the rules ESLint cannot provide.
        'typescript/await-thenable': 'error',
        'typescript/no-floating-promises': 'error',
        'typescript/no-misused-promises': 'error',
    },
} satisfies ITtscLintConfig;
