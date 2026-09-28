import { logMessages as englishLogMessages } from '../../src/js/translations/logEnglish';
import { logMessages as latvianLogMessages } from '../../src/js/translations/logLatvian';
import { localizeLogMessage } from '../../src/js/react/components/logs/localizeLogMessage';

const slots = /\{(\d+)\}/g;
const noAutomaticIcon = /^(?:$|\s|[=-]|\p{Extended_Pictographic})/u;
const omittedGrammarSlots: Record<string, string[]> = { m0fc649a6905e: ['1'] };

describe('Latvian log messages', () => {
    test('every catalog entry preserves its values and can be matched', () => {
        const failures: string[] = [];
        expect(Object.keys(englishLogMessages).sort()).toEqual(Object.keys(latvianLogMessages).sort());
        for (const [key, english] of Object.entries(englishLogMessages)) {
            const latvian = latvianLogMessages[key as keyof typeof latvianLogMessages];
            const values = (index: string) => `VALUE_${index}`;
            const message = english
                .replace(slots, (_, index: string) => values(index))
                .replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ');
            const expected = latvian.replace(slots, (_, index: string) => values(index));
            if (/[a-z]/i.test(english.replace(slots, '')) && localizeLogMessage(message) !== expected)
                failures.push(english.slice(0, 120));
            if (
                /[a-z]/i.test(english.replace(slots, '')) &&
                !noAutomaticIcon.test(message) &&
                localizeLogMessage(`ℹ️ ${message}`) !== `ℹ️ ${expected}`
            )
                failures.push(`${english.slice(0, 120)}: automatic icon`);

            const englishSlots = [...english.matchAll(slots)]
                .map((match) => match[1])
                .filter((slot) => !omittedGrammarSlots[key]?.includes(slot))
                .sort();
            const latvianSlots = [...latvian.matchAll(slots)].map((match) => match[1]).sort();
            if (englishSlots.join(',') !== latvianSlots.join(',')) failures.push(`${english}: lost values`);
        }
        expect(failures).toEqual([]);
    });

    test('translates the exclusion explanation and an automatically added icon', () => {
        const message =
            '[Challenge 42: No Humans] only names what to leave out (human); ranking your whole library with photos showing it excluded';
        expect(localizeLogMessage(`ℹ️ Fill: ${message}`)).toBe(
            'ℹ️ Aizpildīšana: [Izaicinājums 42: No Humans] norāda tikai to, ko neiekļaut (human); izvērtē visu fotoattēlu bibliotēku un izslēdz attēlus, kuros tas redzams',
        );
        expect(localizeLogMessage('ℹ️ Invalid timestamp provided')).toBe('ℹ️ Norādīts nepareizs laika zīmogs');
    });

    test('translates logger progress and the generated plural suffix', () => {
        const progress = '[██████████░░░░░░░░░░] 50% (1/2)';
        expect(localizeLogMessage(`ℹ️ Processing challenge 1/2: Sunset ${progress}`)).toBe(
            `ℹ️ Apstrādā izaicinājumu 1/2: Sunset ${progress}`,
        );
        expect(localizeLogMessage('ℹ️ emergencyFill: submitted 1 entry for [Challenge 42: Sunset] near deadline')).toBe(
            'ℹ️ Ārkārtas aizpildīšana: pirms termiņa iesniegto ierakstu skaits: 1, izaicinājums [Izaicinājums 42: Sunset]',
        );
    });

    test('translates generated photo ranking details', () => {
        const coverage =
            '; past-performance figures have been looked up for 1 of 2 of them so far, and the rest are looked up a batch per fill';
        expect(
            localizeLogMessage(
                `ℹ️ Fill: 2 photos matched the theme equally well for [Challenge 42: Sunset], so the entry was chosen on past performance — image1 (3 votes, 1 achievements, 9 views)${coverage}.`,
            ),
        ).toBe(
            'ℹ️ Aizpildīšana: 2 fotoattēli vienlīdz labi atbilst izaicinājuma [Izaicinājums 42: Sunset] tēmai. Pēc iepriekšējiem rezultātiem atlasīto ierakstu skaits: 1 — image1 (balsis: 3, sasniegumi: 1, skatījumi: 9); iepriekšējie rezultāti pašlaik pārbaudīti 1 no 2 fotoattēliem; pārējos pārbauda pakāpeniski katrā aizpildīšanā.',
        );
        expect(
            localizeLogMessage(
                '⚠️ autoFill: nothing in [Challenge 42: Sunset] matched the challenge theme, so 2 entries were chosen on past performance — image1 (past performance not looked up yet — ranked below any photo that was) out of 3 equally off-theme candidates. Set a Per-Title Tag Rule for this challenge title in Settings to steer which photos qualify.',
            ),
        ).toBe(
            '⚠️ Automātiskā aizpildīšana: izaicinājumā [Izaicinājums 42: Sunset] nekas neatbilda tēmai. Pēc iepriekšējiem rezultātiem atlasīto ierakstu skaits: 2 — image1 (iepriekšējie rezultāti vēl nav pārbaudīti — sarindots aiz pārbaudītajiem fotoattēliem) no 3 vienlīdz neatbilstošiem kandidātiem. Iestatījumos pievieno tagu noteikumu šim izaicinājuma virsrakstam, lai norādītu piemērotos fotoattēlus.',
        );
    });

    test('translates logger operation wrappers and collapsed multiline messages', () => {
        expect(localizeLogMessage('🔄 CLI Manual Voting Process...')).toBe('🔄 CLI manuālais balsošanas process...');
        expect(localizeLogMessage('✅ CLI Manual Voting Process completed (123ms)')).toBe(
            '✅ CLI manuālais balsošanas process pabeigts (123 ms)',
        );
        expect(localizeLogMessage('❌ CLI Manual Voting Process failed: failed to fetch challenges')).toBe(
            '❌ CLI manuālais balsošanas process neizdevās: neizdevās ielādēt izaicinājumus',
        );
        expect(localizeLogMessage('✅ Boost not available (123ms)')).toBe('✅ Pastiprinājums nav pieejams (123 ms)');
        expect(localizeLogMessage('❌ CLI Manual Voting Process failed: upstream-specific-error')).toBe(
            '❌ CLI manuālais balsošanas process neizdevās: upstream-specific-error',
        );
        expect(localizeLogMessage(' Settings:')).toBe('\nIestatījumi:');
    });

    test('leaves unknown technical text intact and handles unmatched icons', () => {
        expect(localizeLogMessage('upstream-specific-error')).toBe('upstream-specific-error');
        expect(localizeLogMessage('ℹ️ upstream-specific-error')).toBe('ℹ️ upstream-specific-error');
        expect(localizeLogMessage('🔍 upstream-specific-error')).toBe('🔍 upstream-specific-error');
        expect(localizeLogMessage('🔄 upstream-specific-error...')).toBe('🔄 upstream-specific-error...');
        expect(localizeLogMessage('✅ upstream-specific-error (123ms)')).toBe('✅ upstream-specific-error (123ms)');
        expect(localizeLogMessage('✅ upstream-specific-operation completed (123ms)')).toBe(
            '✅ upstream-specific-operation completed (123ms)',
        );
        expect(localizeLogMessage('❌ upstream-specific-operation failed: upstream-specific-error')).toBe(
            '❌ upstream-specific-operation failed: upstream-specific-error',
        );
    });
});
