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
// Ratchet plan: "warning" severities are provisional. Promote a rule to
// "error" once `pnpm typecheck` prints zero warnings for it — fix the
// remaining hits first (`pnpm typecheck:fix` autofixes what it can), then
// flip the severity in the same commit.
import type { ITtscLintConfig } from '@ttsc/lint';

export default {
    rules: {
        // Clear-cut correctness — fail the gate.
        'no-var': 'error',

        // Provisional warnings — promote per the ratchet plan above.
        'prefer-const': 'warning',
        'no-throw-literal': 'warning',
        'no-promise-executor-return': 'warning',

        // Type-aware (Checker-backed) — the rules ESLint cannot provide.
        'typescript/await-thenable': 'warning',
        'typescript/no-floating-promises': 'warning',
        'typescript/no-misused-promises': 'warning',
    },
} satisfies ITtscLintConfig;
