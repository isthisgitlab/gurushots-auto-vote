import { logMessages as englishLogMessages } from '../../src/ts/translations/logEnglish';
import { logMessages as latvianLogMessages } from '../../src/ts/translations/logLatvian';
import { localizeLogMessage } from '../../src/ts/react/components/logs/localizeLogMessage';
import { sentenceCaseLogMessage, splitIcon } from '../../src/ts/format/logSafe';
import { formatOversleptMessage } from '../../src/ts/scheduling/cadenceChain/oversleep';
import { formatChosenSkipMessage } from '../../src/ts/services/autoFill/chosenPhotos';
import { formatTagSearchFallbackMessage } from '../../src/ts/services/autoFill/candidates';
import { formatOffThemePickMessage } from '../../src/ts/services/autoFill/fillLogging';
import { START_FRESH_BLOCKED } from '../../src/ts/cli/commands/settingsRecovery';

const slots = /\{(\d+)\}/g;
const noAutomaticIcon = /^(?:$|\s|[=-]|\p{Extended_Pictographic})/u;
const omittedGrammarSlots: Record<string, string[]> = { m0fc649a6905e: ['1'] };

describe('Latvian log messages', () => {
    test('the catalogs keep their keys in lexicographic order', () => {
        // Nothing else gates the order; an out-of-place id made both catalogs harder to scan
        // and diff once, so pin the convention here.
        expect(Object.keys(englishLogMessages)).toEqual([...Object.keys(englishLogMessages)].sort());
        expect(Object.keys(latvianLogMessages)).toEqual([...Object.keys(latvianLogMessages)].sort());
    });

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
        for (const message of [
            'ℹ️ join mission needs 4 but only 3 of the open challenges would join — waiting for the auto-join timing',
            'ℹ️ Join mission needs 4 but only 3 of the open challenges would join — waiting for the auto-join timing',
        ]) {
            expect(localizeLogMessage(message)).toBe(
                'ℹ️ „Join challenges” misijai vajag 4, bet pievienojas tikai 3 no atvērtajiem izaicinājumiem — gaida automātiskās pievienošanās laiku',
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

    test('translates the web Guru-pick lines and the guarded swap refusal', () => {
        const tag = '[Challenge 555: Sunset]';
        expect(localizeLogMessage("⚠️ Web active challenges unavailable; turbo mode and Guru's picks unknown")).toBe(
            '⚠️ Tīmekļa aktīvo izaicinājumu saraksts nav pieejams; Turbo režīms un Guru izvēles nav zināmi',
        );
        expect(localizeLogMessage('🔍 Web active challenges overlay read')).toBe(
            '🔍 Tīmekļa aktīvo izaicinājumu pārklājums nolasīts',
        );
        expect(localizeLogMessage("🔍 Web Guru's picks matched against the mobile entries")).toBe(
            '🔍 Tīmekļa Guru izvēles salīdzinātas ar mobilajiem ierakstiem',
        );
        for (const message of [
            `⚠️ swap: the photo to swap out is boosted, turbo'd or guru-picked — not spending a swap for ${tag}`,
            `⚠️ swap: The photo to swap out is boosted, turbo'd or guru-picked — not spending a swap for ${tag}`,
        ]) {
            expect(localizeLogMessage(message)).toBe(
                '⚠️ Apmaiņa: apmaināmais foto ir ar Boost, Turbo vai Guru izvēli — apmaiņa izaicinājumam [Izaicinājums 555: Sunset] netiek tērēta',
            );
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

    test('translates the title-rules refresh and load failures', () => {
        expect(localizeLogMessage('Error refreshing title rules: disk')).toBe(
            'Kļūda, atsvaidzinot izaicinājumu noteikumus: disk',
        );
        expect(localizeLogMessage('❌ Error refreshing title rules: disk')).toBe(
            '❌ Kļūda, atsvaidzinot izaicinājumu noteikumus: disk',
        );
        expect(localizeLogMessage('Error loading title rules: disk')).toBe(
            'Kļūda, ielādējot izaicinājumu noteikumus: disk',
        );
    });

    test('translates the stay-logged-in clear lines the shells log', () => {
        expect(localizeLogMessage('Cleared a saved token left by an earlier run (Stay Logged In is off)')).toBe(
            'Notīrīts saglabātais tokens, ko atstāja iepriekšējā palaišana ("Palikt pieteicies" ir izslēgts)',
        );
        expect(
            localizeLogMessage(
                'Kept the saved login token because another session is running and may be using it (CLI, desktop app, or web server)',
            ),
        ).toBe(
            'Saglabātais pieteikšanās tokens paturēts, jo darbojas cita sesija, kas to var lietot (CLI, darbvirsmas lietotne vai tīmekļa serveris)',
        );
        expect(localizeLogMessage('Failed to clear a leftover token at startup:')).toBe(
            'Startējot lietotni, neizdevās notīrīt atlikušo tokenu:',
        );
        expect(localizeLogMessage('Kept the saved login token because background auto-vote is armed')).toBe(
            'Saglabātais pieteikšanās tokens paturēts, jo fona automātiskā balsošana ir ieslēgta',
        );
        expect(
            localizeLogMessage('Kept the saved login token because background auto-vote state could not be read'),
        ).toBe('Saglabātais pieteikšanās tokens paturēts, jo fona automātiskās balsošanas stāvokli neizdevās nolasīt');
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

describe('forward template localization', () => {
    const forward = (key: string, params: unknown[], message: string) => localizeLogMessage(message, { key, params });

    test('localizes the chosen-photos tally line from its template and params', () => {
        expect(
            forward(
                'm039ae621e4d5',
                ['join', '[Challenge 42: Sunset]', 1, 0, 2, 0],
                'ℹ️ join: looked for your chosen photos outside the themed search for [Challenge 42: Sunset] — 1 found, 0 not allowed here, 2 not in your library, 0 not reached',
            ),
        ).toBe(
            'ℹ️ Pievienošanās: izvēlētie foto meklēti arī ārpus tēmas meklēšanas izaicinājumam [Izaicinājums 42: Sunset] — atrasti 1, šeit nav atļauti 0, tavā bibliotēkā nav 2, nesasniegti 0',
        );
    });

    test('an entry whose key is missing from the catalogs falls back to the reverse matcher', () => {
        expect(forward('mffffffffffff', [], 'upstream-specific-error')).toBe('upstream-specific-error');
        expect(forward('mffffffffffff', [], 'ℹ️ Invalid timestamp provided')).toBe('ℹ️ Norādīts nederīgs laika zīmogs');
    });

    test('matches the reverse matcher on the migrated voting/fill lines', () => {
        const cases: Array<[string, unknown[]]> = [
            ['m00a78f312ea3', []],
            ['mb8ff0ba416b3', []],
            ['ma3387d8a60e8', []],
            ['m243099e8f79d', []],
            ['m01a2b02c3145', []],
            ['m1176fb70d7ae', []],
            ['mc0e03d96165c', ['[Challenge 42: Sunset]', 3]],
            ['md9eea27255b5', ['[Challenge 42: Sunset]', 'normal threshold: exposure 10% < 90%']],
            ['me55acfad2b92', ['[Challenge 42: Sunset]', 'normal threshold: exposure 90% >= 90%']],
            ['m8dc9275e52f1', ['[Challenge 42: Sunset]']],
            ['mf275019cebb9', ['[Challenge 42: Sunset]']],
            ['m5ad141b74f8c', ['[Challenge 42: Sunset]', 2]],
            ['m9c4743591d36', ['[Challenge 42: Sunset]', '10m', 10]],
            ['mf56a828d276b', ['[Challenge 42: Sunset]', '10m', 15]],
            ['m7c8a6b6fc65b', ['[Challenge 42: Sunset]', 'no-slots']],
            ['m6c65118e63fa', ['[Challenge 42: Sunset]', 'no-slots']],
            ['m68af6d2b3623', ['[Challenge 42: Sunset]']],
            ['maa2d3401e212', ['[Challenge 42: Sunset]']],
            ['md99c0b138489', ['[Challenge 42: Sunset]']],
            ['mcf9ca1fdf16b', ['[Challenge 42: Sunset]', '9m', 'e1']],
            ['mefe4e859a5ca', ['[Challenge 42: Sunset]', 'e1']],
            ['m94322a7a4ec8', ['[Challenge 42: Sunset]']],
            ['mc37905687d16', ['[Challenge 42: Sunset]']],
            ['m21b1261f69f8', ['[Challenge 42: Sunset]']],
            ['mc93c515e28d4', ['[Challenge 42: Sunset]', 'e1']],
            ['m9c0719be2c97', ['[Challenge 42: Sunset]', 'e1']],
            ['m3e7a92c4b518', ['[Challenge 42: Sunset]']],
            ['m6b04d81f7c23', ['[Challenge 42: Sunset]']],
            ['m9f25e7a3d681', ['[Challenge 42: Sunset]']],
            ['m2c58b0e94a76', ['[Challenge 42: Sunset]']],
        ];
        for (const [key, params] of cases) {
            const english = englishLogMessages[key as keyof typeof englishLogMessages]
                .replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ')
                .replace(slots, (_, index: string) => String(params[Number(index)]));
            // A template that leads with its own icon is emitted bare; the rest carry the level icon.
            const prefixes = splitIcon(english).icon !== '' ? [''] : ['', 'ℹ️ ', '⚠️ ', '❌ ', '🔍 '];
            for (const prefix of prefixes) {
                for (const body of [english, sentenceCaseLogMessage(english)]) {
                    // The reference is the reverse matcher on the catalog's own
                    // wording; the forward path must land on the same line for
                    // every casing the logger can emit.
                    expect(forward(key, params, prefix + body)).toBe(localizeLogMessage(prefix + english));
                }
            }
        }
    });
});
