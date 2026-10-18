import type { CustomizationKind } from '../hooks/useCustomizedChallengeIds';

export type CustomizationSource = 'manual' | 'profile' | 'rule';

/**
 * The colour of a customization source: manual override = accent, automatic profile = info, rule values = secondary.
 * The single documented exception to the one-meaning palette: users scan for customized challenges by colour, and the
 * icons and sr-only text stay, so colour is never the only cue. Info also means "boost window open" in the neighbouring
 * `BoostWindowBanner`, and the "Using profile" badge (`badge-info`) shares its settings cell with the `badge-info` "?"
 * help badge (`SettingHelp`). daisyUI's own `secondary` pairing measures about 3:1 text contrast in the default
 * light/dark themes; it stays because users asked for the original colours: the theme owns contrast, and the icon plus
 * text carry the meaning. Whole class literals on purpose: Tailwind only generates classes it sees in full.
 */
const TONE: Record<CustomizationSource, { btn: string; badge: string }> = {
    manual: { btn: 'btn-accent', badge: 'badge-accent' },
    profile: { btn: 'btn-info', badge: 'badge-info' },
    rule: { btn: 'btn-secondary', badge: 'badge-secondary' },
};

/**
 * The button class that colours a jump-list chip by what customizes its challenge, or an empty string for none. A
 * challenge with both manual overrides and an automatic profile takes the profile tone.
 *
 * @param kind - What customizes the challenge, if anything
 */
export const chipToneOf = (kind: CustomizationKind | undefined): string => {
    if (kind === undefined) return '';
    return TONE[kind === 'both' ? 'profile' : kind].btn;
};

/**
 * The badge class that colours a setting's source badge.
 *
 * @param source - Where the shown value comes from
 */
export const sourceBadgeTone = (source: CustomizationSource): string => TONE[source].badge;
