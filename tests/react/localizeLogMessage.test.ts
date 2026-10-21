import { logMessages as englishLogMessages } from '../../src/ts/translations/logEnglish';
import { logMessages as latvianLogMessages } from '../../src/ts/translations/logLatvian';
import { localizeLogMessage } from '../../src/ts/react/components/logs/localizeLogMessage';
import { sentenceCaseLogMessage } from '../../src/ts/format/logSafe';
import { formatOversleptMessage } from '../../src/ts/scheduling/cadenceChain/oversleep';
import { formatChosenSkipMessage } from '../../src/ts/services/autoFill/chosenPhotos';
import { formatTagSearchFallbackMessage } from '../../src/ts/services/autoFill/candidates';
import { formatOffThemePickMessage } from '../../src/ts/services/autoFill/fillLogging';
import { START_FRESH_BLOCKED } from '../../src/ts/cli/commands/settingsRecovery';

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
                localizeLogMessage(sentenceCaseLogMessage(message)) !== expected
            )
                failures.push(`${english.slice(0, 120)}: sentence case`);
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
            'ℹ️ Iesniegšana: [Izaicinājums 42: No Humans] norāda tikai to, ko neiekļaut (human); sarindo visu bibliotēku un izslēdz foto, kuros tas redzams',
        );
        expect(localizeLogMessage('ℹ️ Invalid timestamp provided')).toBe('ℹ️ Norādīts nederīgs laika zīmogs');
    });

    test('translates the Manual Only lines', () => {
        const tag = '[Challenge 42: Sunset]';
        expect(localizeLogMessage(`ℹ️ ${tag} Manual Only is on — nothing runs automatically`)).toBe(
            'ℹ️ [Izaicinājums 42: Sunset] „Tikai manuāli” ir ieslēgts — nekas nenotiek automātiski',
        );
        expect(localizeLogMessage(`ℹ️ ${tag} Manual Only is off — automatic rules resume`)).toBe(
            'ℹ️ [Izaicinājums 42: Sunset] „Tikai manuāli” ir izslēgts — automātiskie noteikumi atsākas',
        );
        expect(
            localizeLogMessage(
                'ℹ️ Mode: Manual (votes to 100% regardless of threshold settings; skips Manual Only challenges)',
            ),
        ).toBe(
            'ℹ️ Režīms: manuāls (balso līdz 100 % neatkarīgi no sliekšņu uzstādījumiem; izlaiž izaicinājumus ar „Tikai manuāli”)',
        );
    });

    test('translates the unreadable-switch line and the paid-join warning', () => {
        const tag = '[Challenge 42: Sunset]';
        expect(
            localizeLogMessage(
                `⚠️ ${tag} Could not read the Manual Only setting — nothing runs automatically. Open the challenge settings, make sure Manual Only is set the way you want and save, then try again`,
            ),
        ).toBe(
            '⚠️ [Izaicinājums 42: Sunset] Neizdevās nolasīt uzstādījumu „Tikai manuāli” — nekas nenotiek automātiski. Atver izaicinājuma uzstādījumus, pārliecinies, ka „Tikai manuāli” ir uzstādīts tā, kā vēlies, saglabā un mēģini vēlreiz',
        );
        expect(
            localizeLogMessage(
                `⚠️ Manual Only is on for ${tag}: the join was already paid for, but no photo is entered automatically — enter one from Discover: choose the photo for this challenge (Chosen Photos), then press Join`,
            ),
        ).toBe(
            '⚠️ Izaicinājumam [Izaicinājums 42: Sunset] ieslēgts „Tikai manuāli”: pievienošanās apmaksāta, bet foto nav iesniegts automātiski — iesniedz to „Atrast izaicinājumos”: izvēlies foto („Izvēlētie foto”) un nospied „Pievienoties”',
        );
    });

    test('translates logger progress and the generated plural suffix', () => {
        const progress = '[██████████░░░░░░░░░░] 50% (1/2)';
        expect(localizeLogMessage(`ℹ️ Processing challenge 1/2: Sunset ${progress}`)).toBe(
            `ℹ️ Apstrādā izaicinājumu 1/2: Sunset ${progress}`,
        );
        expect(
            localizeLogMessage('ℹ️ emergencySubmit: submitted 1 entry for [Challenge 42: Sunset] near deadline'),
        ).toBe('ℹ️ Ārkārtas iesniegšana: izaicinājumā [Izaicinājums 42: Sunset] īsi pirms termiņa iesniegti foto: 1');
    });

    test('translates the join and challenge fetch lines before and after sentence casing', () => {
        for (const message of [
            'ℹ️ joining up to 4 challenge(s) early for the active missions',
            'ℹ️ Joining up to 4 challenge(s) early for the active missions',
        ]) {
            expect(localizeLogMessage(message)).toBe(
                'ℹ️ Aktīvo misiju dēļ priekšlaikus pievienojas līdz 4 izaicinājumiem',
            );
        }
        for (const message of ['✅ retrieved 24 challenges (1734ms)', '✅ Retrieved 24 challenges (1734ms)']) {
            expect(localizeLogMessage(message)).toBe('✅ Ielādēti izaicinājumi: 24 (1734 ms)');
        }
        expect(localizeLogMessage('🔄 Voting process...')).toBe('🔄 Balsošanas process...');
        expect(localizeLogMessage('🔄 Loading active challenges')).toBe('🔄 Ielādē aktīvos izaicinājumus');
    });

    test('translates challenge-tagged lines with either case after the tag', () => {
        for (const message of [
            '[Challenge 12: Sunset] turbo fill-new unavailable (no entry); applying to existing entry',
            '[Challenge 12: Sunset] Turbo fill-new unavailable (no entry); applying to existing entry',
        ]) {
            expect(localizeLogMessage(message)).toContain('Izaicinājums 12: Sunset');
            expect(localizeLogMessage(message)).not.toBe(message);
        }
    });

    test('translates generated photo ranking details', () => {
        const coverage =
            '; past-performance figures have been looked up for 1 of 2 of them so far, and the rest are looked up a batch per fill';
        expect(
            localizeLogMessage(
                `ℹ️ Fill: 2 photos matched the theme equally well for [Challenge 42: Sunset], so the entry was chosen on past performance — image1 (3 votes, 1 achievements, 9 views)${coverage}.`,
            ),
        ).toBe(
            'ℹ️ Iesniegšana: 2 foto vienlīdz labi atbilst tēmai izaicinājumā [Izaicinājums 42: Sunset]. Pēc iepriekšējiem rezultātiem atlasīto foto skaits: 1 — image1 (balsis: 3, sasniegumi: 1, skatījumi: 9); līdz šim iepriekšējie rezultāti pārbaudīti 1 no 2 foto, pārējos pārbauda pa daļai katrā iesniegšanas reizē.',
        );
        // The input is built by the same formatter the emitter calls, so a
        // catalog/emitter drift shows up here as an untranslated line.
        const offTheme = formatOffThemePickMessage({
            prefix: 'autoSubmit',
            tag: '[Challenge 42: Sunset]',
            subject: '2 entries were',
            described: 'image1 (past performance not looked up yet — ranked below any photo that was)',
            contestedCount: 3,
            coverage: '',
        });
        expect(localizeLogMessage(`⚠️ ${offTheme}`)).toBe(
            '⚠️ Automātiskā iesniegšana: izaicinājumā [Izaicinājums 42: Sunset] nekas neatbilda tēmai. Pēc iepriekšējiem rezultātiem atlasīti: 2 — image1 (iepriekšējie rezultāti vēl nav pārbaudīti — sarindots aiz visiem foto, kuru rezultāti ir pārbaudīti) no 3 vienlīdz neatbilstošiem kandidātiem. Sadaļā Uzstādījumi pievieno nosaukumam tagu noteikumu.',
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
        expect(localizeLogMessage('✅ Boost not available (123ms)')).toBe('✅ Boost nav pieejams (123 ms)');
        expect(localizeLogMessage('❌ CLI Manual Voting Process failed: upstream-specific-error')).toBe(
            '❌ CLI manuālais balsošanas process neizdevās: upstream-specific-error',
        );
        expect(localizeLogMessage(' Settings:')).toBe('\nUzstādījumi:');
    });

    test('translates the chosen-photos lines, including the fill label they start with', () => {
        const tag = '[Challenge 42: Sunset]';
        for (const [label, lv] of [
            ['autoSubmit', 'Automātiskā iesniegšana'],
            ['fillNew', 'Jauna foto iesniegšana'],
            ['emergencySubmit', 'Ārkārtas iesniegšana'],
            ['manualFill', 'Manuālā iesniegšana'],
            ['join', 'Pievienošanās'],
        ]) {
            // Built by the same formatter the emitter calls, so a catalog/emitter
            // drift shows up here as an untranslated line.
            const translated = localizeLogMessage(`⚠️ ${formatChosenSkipMessage(label, tag, 'all-entered', false)}`);
            expect(translated.startsWith(`⚠️ ${lv}: izaicinājums [Izaicinājums 42: Sunset] izlaists`)).toBe(true);
        }
        const withoutMissing = formatChosenSkipMessage('join', tag, 'none-usable', false);
        expect(localizeLogMessage(`⚠️ ${withoutMissing}`)).toContain('neviens izvēlētais foto nav iesniedzams');
        const withMissing = formatChosenSkipMessage('fillNew', tag, 'none-usable', true);
        expect(localizeLogMessage(`⚠️ ${withMissing}`)).toContain('Daži vairs nav bibliotēkā — izņem no saraksta');
        expect(
            localizeLogMessage(
                'ℹ️ join: looked for your chosen photos outside the themed search for [Challenge 42: Sunset] — 1 found, 0 not allowed here, 2 not in your library, 0 not reached',
            ),
        ).toBe(
            'ℹ️ Pievienošanās: izvēlētie foto meklēti arī ārpus tēmas meklēšanas izaicinājumam [Izaicinājums 42: Sunset] — atrasti 1, šeit nav atļauti 0, tavā bibliotēkā nav 2, nesasniegti 0',
        );
    });

    test('translates the other reworded emitters, built by their real formatters', () => {
        const tag = '[Challenge 42: Sunset]';
        for (const [line, fragment] of [
            [formatOversleptMessage(93_000, 4 * 60_000), 'Cikls sākās'] as const,
            [
                formatTagSearchFallbackMessage(
                    'autoSubmit',
                    tag,
                    ['stair', 'step'],
                    'Review the selected photo; the existing labels did not identify a themed match.',
                ),
                'bibliotēku sarindos semantiski',
            ] as const,
            [START_FRESH_BLOCKED, '„sākt no jauna” netiek piedāvāts'] as const,
        ]) {
            // A catalog/emitter drift leaves the line untranslated.
            expect(localizeLogMessage(line)).toContain(fragment);
        }
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
