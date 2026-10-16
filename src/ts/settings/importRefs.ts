/**
 * The wording of the references an import left unresolved (types/config.ts ImportRef), shared by the window, which
 * words them in its language, and the CLI, which prints the English: the parts are the same, only the templates differ.
 * Dependency-free (types only), so the renderer may import it.
 */

import type { ImportRef } from '../types/config';

/** The templates a reference is worded with: `{name}`-style placeholders, filled by `describeImportRef`. */
type ImportRefText = {
    /** the whole line: where the reference is stored, and what is wrong with it */
    importRefLine: string;
    importRefRule: string;
    importRefRuleTitled: string;
    importRefProfile: string;
    importRefChallenge: string;
    importRefChallengeTitled: string;
    importRefProfileMissing: string;
    importRefProfileInvalid: string;
    importRefScenarioMissing: string;
    importRefScenarioInvalid: string;
};

/** The English wording; the `notice.importRef*` strings of the window's English translation are these. */
const IMPORT_REF_ENGLISH: Readonly<ImportRefText> = {
    importRefLine: '{where}: {problem}',
    importRefRule: 'Rule {number}',
    importRefRuleTitled: 'Rule {number} ({title})',
    importRefProfile: 'Profile "{name}"',
    importRefChallenge: 'Challenge {id}',
    importRefChallengeTitled: 'Challenge "{title}" ({id})',
    importRefProfileMissing: 'the profile "{name}" doesn\'t exist',
    importRefProfileInvalid: 'the profile "{name}" can\'t be used',
    importRefScenarioMissing: 'the scenario "{name}" doesn\'t exist',
    importRefScenarioInvalid: 'the scenario "{name}" can\'t be used',
};

const fill = (template: string, values: Record<string, string | number>): string =>
    template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key]));

/**
 * One entry of a report as a line a person reads: "Rule 3 (Macro…): the profile "Night" doesn't exist". An entry an
 * earlier build stored as text is shown as it is. The names are the user's own, so `clean` (the CLI's terminal-control
 * strip) is applied to each; the window passes none (it renders text, not markup).
 *
 * @param text - the templates, in the language of the reader
 */
const describeImportRef = (
    ref: string | ImportRef,
    text: Readonly<ImportRefText>,
    clean: (value: string) => string = (value) => value,
): string => {
    if (typeof ref === 'string') return clean(ref);
    const { holder } = ref;
    const where = ((): string => {
        if (holder.kind === 'rule') {
            return holder.title === undefined
                ? fill(text.importRefRule, { number: holder.number })
                : fill(text.importRefRuleTitled, { number: holder.number, title: clean(holder.title) });
        }
        if (holder.kind === 'profile') return fill(text.importRefProfile, { name: clean(holder.name) });
        return holder.title === undefined
            ? fill(text.importRefChallenge, { id: clean(holder.id) })
            : fill(text.importRefChallengeTitled, { title: clean(holder.title), id: clean(holder.id) });
    })();
    const problem = fill(
        ref.refers === 'profile'
            ? ref.invalid
                ? text.importRefProfileInvalid
                : text.importRefProfileMissing
            : ref.invalid
              ? text.importRefScenarioInvalid
              : text.importRefScenarioMissing,
        { name: clean(ref.name) },
    );
    return fill(text.importRefLine, { where, problem });
};

export type { ImportRefText };
export { describeImportRef, IMPORT_REF_ENGLISH };
