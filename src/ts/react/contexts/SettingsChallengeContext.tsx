import { createContext, useContext } from 'react';

/**
 * The challenge the surrounding settings editor edits, for the inputs that need
 * to know it (the chosen-photos chooser reads a photo's eligibility through a
 * challenge). Null outside a per-challenge editor — the global form, a rule or a
 * scenario phase edit settings that span challenges.
 */
const SettingsChallengeContext = createContext<string | number | null>(null);

export const SettingsChallengeProvider = SettingsChallengeContext.Provider;

export const useSettingsChallengeId = (): string | number | null => useContext(SettingsChallengeContext);
