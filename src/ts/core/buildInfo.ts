/**
 * Whether this build was made outside GitHub Actions (a "dirty" build): the esbuild configs bake the answer in as
 * `__GS_DIRTY__`. A run that is not bundled (`pnpm cli:*`, the web shell through tsx, Jest) has no define, so it
 * reads the environment instead: dirty unless GitHub Actions or the test runner made it. The define is checked
 * first, so the browser bundles never reach the process environment.
 */

import * as runtime from './runtime';

declare const __GS_DIRTY__: boolean | undefined;

const isDirtyBuild = (): boolean =>
    typeof __GS_DIRTY__ !== 'undefined' ? __GS_DIRTY__ : !runtime.isTest() && !runtime.isGithubActions();

export { isDirtyBuild };
