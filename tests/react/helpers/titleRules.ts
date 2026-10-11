/**
 * A `get-title-profile` answer for tests: what a challenge's matching rules contribute, with every
 * layer empty unless the test says otherwise. A `profile` and its `inlineValues` give the combined
 * `ruleValues` unless that is passed too (the inline values win, as in the real read).
 */

import type { TitleRuleInfo } from '../../../src/ts/types/settings';

export const titleRuleInfo = (over: Partial<TitleRuleInfo> = {}): TitleRuleInfo => {
    const profile = over.profile ?? null;
    const inlineValues = over.inlineValues ?? {};
    return {
        profile,
        suppressed: false,
        ruleValues: { ...profile?.values, ...inlineValues },
        inlineValues,
        ruleSources: {},
        ...over,
    };
};
