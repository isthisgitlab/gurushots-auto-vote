// English translations for GuruShots Auto Vote
/* global window, self */
(function (root, factory) {
    // The else branch is the classic <script>-tag load (src/html/*.html). Jest
    // always loads this file through its CommonJS wrapper, where `module` is
    // defined, so that branch cannot run under test.
    /* istanbul ignore else */
    if (typeof module === 'object' && module.exports) {
        // Node.js
        module.exports = factory();
    } else {
        // Browser globals
        root.englishTranslations = factory();
    }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
    return {
        // Common/shared translations
        common: {
            dark: 'Dark',
            global: 'Global:',
            languageEnglish: 'English',
            languageLatvian: 'Latviešu',
            light: 'Light',
            loading: 'Loading...',
            closeModal: 'Close modal',
            logout: 'Logout',
            mock: 'Mock:',
            never: 'Never',
            no: 'No',
            off: 'OFF',
            on: 'ON',
            refresh: 'Refresh',
            running: 'Running',
            status: 'Status:',
            stay: 'Stay:',
            stopped: 'Stopped',
            theme: 'Theme',
            title: 'GuruShots Auto Vote',
            yes: 'Yes',
            ok: 'OK',
        },
        // Error / recovery UI
        errors: {
            boundaryTitle: 'Something went wrong',
            dismiss: 'Dismiss',
            reload: 'Reload',
            fetchFailed: "Couldn't reach GuruShots — retrying automatically.",
        },
        // First-run onboarding
        onboarding: {
            title: 'Welcome to GuruShots Auto Vote',
            intro: 'This app votes on your active GuruShots challenges automatically on a schedule, keeping your exposure up without you lifting a finger.',
            howItWorksTitle: 'How it works',
            howItWorks:
                'Log in, pick your thresholds in Settings, and toggle Auto-vote on. The app checks your challenges every few minutes and votes when needed.',
            batteryTitle: 'Keep it running in the background',
            batteryBody:
                'To keep voting while the screen is off, exclude this app from battery optimization in your phone settings. Some vendors (Samsung, Xiaomi, OnePlus) aggressively kill background apps.',
            gotIt: 'Got it',
        },
        // Menu translations
        menu: {
            edit: 'Edit',
            undo: 'Undo',
            redo: 'Redo',
            cut: 'Cut',
            copy: 'Copy',
            paste: 'Paste',
            selectAll: 'Select All',
            file: 'File',
            view: 'View',
            window: 'Window',
            help: 'Help',
            reload: 'Reload',
            toggleDevTools: 'Toggle Developer Tools',
            toggleFullscreen: 'Toggle Fullscreen',
            minimize: 'Minimize',
            zoom: 'Zoom',
            close: 'Close',
            bringAllToFront: 'Bring All to Front',
            logs: 'Logs',
            about: 'About GuruShots Auto Vote',
            aboutTitle: 'About GuruShots Auto Vote',
            aboutAuthor: 'Author',
            aboutElectron: 'Electron',
            aboutNode: 'Node.js',
            aboutDescription:
                'GuruShots Auto Vote - An Electron application for automated voting on GuruShots challenges with unified GUI and CLI interfaces (supports both real and mock modes)',
            checkForUpdates: 'Check for Updates...',
            noUpdates: 'No Updates',
            noUpdatesMessage: 'You are using the latest version.',
            updateError: 'Update Error',
            updateErrorMessage: 'Failed to check for updates.',
        },
        // Login screen specific
        login: {
            heading: 'Login',
            loadingModeInfo: 'Loading mode information...',
            loggingIn: 'Logging in...',
            loginButton: 'Login',
            mockMode: 'Mock mode',
            mockModeInfo: 'Mock mode: Using simulated data for testing. Any credentials will work.',
            password: 'Password',
            passwordPlaceholder: 'Enter your password',
            passwordRequired: 'Password is required',
            productionModeInfo: 'Production mode: Using real GuruShots API. Valid credentials required.',
            stayLoggedIn: 'Stay logged in',
            title: 'Login - GuruShots Auto Vote',
            username: 'Username',
            usernamePlaceholder: 'Enter your username',
            usernameRequired: 'Username is required',
        },
        // App screen specific
        app: {
            activeChallenges: 'Active Challenges',
            addCustomTimezone: 'Add custom timezone',
            addTimezone: 'Add custom timezone',
            apiTimeout: 'API Timeout',
            apiTimeoutDesc:
                'How long to wait for a GuruShots API response before the request counts as failed (1–120 seconds).',
            appSetting: 'App Setting',
            applicationSettings: 'Application Settings',
            autoVote: 'Auto Vote',
            autovoteRunning: 'Auto-Vote Running',
            autovoteRunningDesc:
                'Internal flag — persists auto-vote state across app restarts so voting can resume automatically',
            skipUpdateVersion: 'Skipped Update Version',
            skipUpdateVersionDesc:
                'Internal — the update version the user chose to skip; the app stops prompting for this version until cleared',
            available: 'Available',
            used: 'Used',
            unavailable: 'Unavailable',
            boost: 'Boost',
            boostWindowOpen: 'Boost window open',
            boostOpenBadge: 'Boost open',
            lowExposure: 'Low exposure',
            jumpToChallenge: 'Jump to challenge',
            deadlineTimeline: 'Upcoming actions',
            deadlineTimelineApprox: 'approximate — may shift as entries fill',
            deadlineNext: 'Next',
            deadlineDue: 'due now',
            deadlineActionAutoFill: 'Auto-fill',
            deadlineActionBoost: 'Boost',
            deadlineActionTurbo: 'Turbo',
            deadlineActionEmergencyFill: 'Emergency fill',
            boostConflictWarning:
                "Boost can't apply: your only entry already has Turbo (they can't share an entry). Add a second entry to use both.",
            statusHeaderActive: 'active',
            statusHeaderBoosts: 'Boosts ready',
            statusHeaderTurbos: 'Turbos ready',
            statusHeaderNext: 'Next',
            statusHeaderNotRunning: 'autovote off',
            statusHeaderAutoJoin: 'auto-join on',
            statusHeaderAutoJoinTitle:
                'Auto-join runs each voting cycle while autovote is on. Configure it in Settings › Auto Join.',
            statusHeaderNextApprox: 'approximate — recomputed each cycle',
            settingHelpLabel: 'What does this mean?',
            boostTime: 'Boost Time',
            boostTimeDesc:
                'Apply Boost when this much time is left on the Boost’s own timer. Does not apply to a key-unlocked Boost, which has no timer — that one uses Key-Unlocked Boost Time.',
            boostTimeHelp:
                'This is a timer measured as time-before-close. Set it to 0 to turn timed Boost off — the bot will not auto-apply a timer Boost at all. Note 0 means "off" here, unlike the Exposure Target settings where 0 means "follow the trigger". Only affects a Boost that has its own countdown; a key-unlocked Boost uses Key-Unlocked Boost Time instead.',
            keyUnlockedBoostTime: 'Key-Unlocked Boost Time',
            keyUnlockedBoostTimeDesc:
                'Separate window for a key-unlocked Boost — one with no timer of its own. Because it never expires, it is applied only when this much time remains before the challenge closes, so it lands as late as possible. Boost Time does not apply to these. Set to 0 to never auto-apply it.',
            keyUnlockedBoostTimeHelp:
                'Applies only to a key-unlocked Boost (one with no timer of its own). Set to 0 to never auto-apply it. This is a separate clock from Boost Time — the two never substitute for each other. As with the other time settings, 0 means "off".',
            voteBeforeBoost: 'Fill Exposure Before Boost',
            voteBeforeBoostDesc:
                'Vote this challenge up to 100% exposure for a short window before Boost is auto-applied, so the Boost lands on a fully exposed entry instead of a decayed one.',
            voteBeforeBoostHelp:
                'A Boost multiplies whatever the entry has at the moment it lands, and you only get one per challenge — so applying it to an entry whose exposure has decayed wastes it. With this on, the bot votes to 100% during the lead you set below, then the Boost is applied as usual. It needs Auto-Apply Boost to be on, and it does nothing when the matching Boost time is set to 0 ("off"). Exposure does not jump to 100% in one pass, so leave enough lead for several voting cycles.',
            voteBeforeBoostOnlyBoostHint:
                'Only Boost Mode is on, so the bot never votes — this fill will never run. Turn off Only Boost Mode (in General) to use it.',
            voteBeforeBoostNoAutoBoostHint:
                'Auto-Apply Boost is off, so no Boost is applied automatically and there is nothing to fill ahead of.',
            voteBeforeBoostLastMinuteOnlyHint:
                'Vote Only In Last Minutes is on, so the bot does not vote before then — this fill runs only if the Boost happens to land inside that window, where voting already goes to 100% anyway.',
            voteBeforeBoostNoBoostTimeHint:
                'Both Boost Time and Key-Unlocked Boost Time are 0 (off), so no Boost is ever applied automatically and there is no moment to fill ahead of. Set at least one of them above 0.',
            voteBeforeBoostLeadMin: 'Fill Before Boost Lead',
            voteBeforeBoostLeadMinDesc:
                'How long before the Boost is applied the fill starts. Allow enough time for several voting rounds — exposure does not reach 100% in one go.',
            autoBoost: 'Auto-Apply Boost',
            autoBoostDesc: 'Automatically apply Boost on this challenge as its Boost window is about to close.',
            turbo: 'Turbo',
            autoTurbo: 'Auto-Earn Turbo',
            autoTurboDesc: 'Play the Turbo mini-game automatically to earn the bonus',
            useTurbo: 'Auto-Apply Turbo',
            useTurboDesc: 'Automatically apply an earned Turbo to one of your entries',
            turboTime: 'Turbo Apply Time',
            turboTimeDesc: 'Apply Turbo when this much time remains before the challenge closes.',
            turboTimeHelp:
                'Time-before-close at which an earned Turbo is applied. Set to 0 to turn timed Turbo apply off. Like the other time settings, 0 here means "off" — not "follow a trigger".',
            turboImageIndex: 'Turbo Entry',
            turboImageIndexDesc:
                'Which entry gets Turbo: 1 = first, 2 = second, etc. Use 0 for the last entry. If Boost is already on that entry, Turbo moves to the previous entry (entry 1 wraps to the last entry). Note: both Turbo Entry and Boost Entry default to 1, so when both auto-modes fire one will land on the last entry.',
            boostImageIndex: 'Boost Entry',
            boostImageIndexDesc:
                'Which entry gets Boost: 1 = first, 2 = second, etc. Use 0 for the last entry. If Turbo is already on that entry, Boost moves to the previous entry (entry 1 wraps to the last entry). Note: both Turbo Entry and Boost Entry default to 1, so when both auto-modes fire one will land on the last entry.',
            boostFillNew: 'Boost a Freshly Submitted Photo',
            boostFillNewDesc:
                'When on, this submits a new photo (using your Auto-Fill tag rules) just before boosting and boosts that new entry instead of an existing one. If there is no free slot or no eligible photo, it falls back to boosting your configured Boost Entry.',
            boostFillNewOnConflict: 'Boost a Freshly Submitted Photo Only on Conflict',
            boostFillNewOnConflictDesc:
                'When on, a new photo is submitted and boosted only when your single existing entry already has Turbo on it (so Boost cannot go there). In the normal case Boost still goes to your existing entry. If there is no free slot or no eligible photo to submit, Boost is skipped this cycle — there is no fallback, since your only entry already has Turbo. Ignored when the option above is on, since that always fills a new photo.',
            turboFillNew: 'Turbo a Freshly Submitted Photo',
            turboFillNewDesc:
                'When on, this submits a new photo (using your Auto-Fill tag rules) just before applying Turbo and applies Turbo to that new entry instead of an existing one. If there is no free slot or no eligible photo, it falls back to your configured Turbo Entry; if you have no entry yet, Turbo is skipped this cycle.',
            turboFillNewOnConflict: 'Turbo a Freshly Submitted Photo Only on Conflict',
            turboFillNewOnConflictDesc:
                'When on, a new photo is submitted and given Turbo only when your single existing entry already has Boost on it (so Turbo cannot go there). In the normal case Turbo still goes to your existing entry. If there is no free slot or no eligible photo to submit, Turbo is skipped this cycle — there is no fallback, since your only entry already has Boost. Ignored when the option above is on, since that always fills a new photo.',
            playAutoTurbo: 'Play the Turbo mini-game now to earn Turbo',
            autoTurboRunsWithAutovote: 'Auto-vote already plays the Turbo mini-game on each cycle',
            earnTurbo: 'Earn Turbo',
            applyTurboToThisEntry: 'Apply your Turbo to this photo',
            applyBoostToThisEntry: 'Apply your Boost to this photo',
            autoFill: 'Auto-Fill Missing Entries',
            autoFillDesc:
                'Submit additional photos as a challenge approaches its deadline, following the schedule below. Fills one slot per check cycle.',
            autoFillSchedule: 'Auto-Fill Schedule',
            autoFillScheduleDesc:
                'Set a time to 0h 0m to turn that image off. Each row means: have at least this many entries once this much time remains before close — "Image 2 ≤ 48h" submits your 2nd photo when 48 hours remain. If you are behind schedule (the app started late, or a time is longer than the whole challenge), it catches up one photo per cycle from the start. If a challenge allows fewer images than the schedule covers, the whole schedule shifts toward the end so the last image\'s time applies to the challenge\'s final photo — e.g. in a 2-image challenge the 2nd photo uses the Image 4 time; in a 3-image challenge the 2nd photo uses the Image 3 time and the 3rd the Image 4 time.',
            autoFillScheduleShiftHint:
                'This challenge allows {0} photos, fewer than the schedule covers — times shift toward the end: the final photo uses the Image {1} time.',
            autoFillScheduleImage: 'Image',
            autoFillScheduleOff: 'no time set — may still be submitted while catching up to a later image',
            autoFillScheduleEmpty: 'All images are off — auto-fill will never submit anything.',
            autoFillScheduleDominated: 'never applies (a later image already has an equal or longer time)',
            autoFillScheduleOutOfRange: 'time must be at most 30 days',
            settingsSaveError: 'Some settings could not be saved — check the highlighted values and try again.',
            unitPercent: '%',
            unitMinutes: 'min',
            unitHours: 'h',
            unitCoins: 'coins',
            unitVotes: 'votes',
            unitKeys: 'keys',
            unitSwaps: 'swaps',
            unitFills: 'fills',
            // Bankroll (header pills)
            bankrollKeys: 'keys',
            bankrollSwaps: 'swaps',
            bankrollFills: 'fills',
            bankrollCoins: 'coins',
            // Currency actions (key unlock / swap / exposure fill) on a challenge card
            currencyKeyUnlock: 'Unlock',
            currencyKeyUnlockTitle: 'Unlock boost with a key?',
            currencyKeyUnlockBody:
                'This unlocks the boost on "{title}". It does not apply the boost to a photo — you still choose which entry to boost.',
            currencyFillExposure: 'Fill exposure',
            currencyFillExposureTitle: 'Fill exposure with a fill?',
            currencyFillExposureBody: 'This tops the exposure of "{title}" up to 100%.',
            currencySwap: 'Swap',
            currencySwapTitle: 'Swap this photo?',
            currencySwapBody:
                'The current photo is replaced by the one the app picked for this challenge. The replaced photo cannot be swapped back in.',
            currencySwapCurrent: 'Current photo',
            currencySwapReplacement: 'Replacement photo',
            currencySwapBoostedWarning:
                'This photo is boosted or turbo-charged. The boost/turbo stays with this photo — the replacement will not have it, and it cannot be used again in this challenge unless you swap this photo back in.',
            currencySwapBack: 'Swap back',
            currencySwapBackTitle: 'Swap the original photo back?',
            currencySwapBackBody: 'Your original photo returns to this slot and gets its {kind} back.',
            currencySwapBackOriginal: 'Original photo',
            currencyCost: 'Costs 1 {unit}.',
            currencyBalance: 'You have {current} {currency}; after this you will have {resulting}.',
            currencyBalanceUnknown:
                'Your {currency} balance could not be read — the app will check it again before spending.',
            currencyUnitKeys: 'key',
            currencyUnitSwaps: 'swap',
            currencyUnitFills: 'fill',
            currencySpend: 'Spend 1 {unit}',
            // Currency action outcomes (what happened → why → what next)
            currencyOutcomeNotAvailable:
                'Not available on this challenge right now — it may already be done. The card will refresh.',
            currencyOutcomeNoBalance: 'You have none of that currency left, so nothing was spent.',
            currencyOutcomeBalanceUnknown:
                'Your balance could not be checked, so nothing was spent. Try again in a moment.',
            currencyOutcomeNoAlternative:
                'No different photo is available to swap in — every eligible photo is already used here.',
            currencyOutcomeStaleCandidate: 'The suggested replacement expired. Press Swap again for a fresh pick.',
            currencyOutcomeBusy: 'Another currency action is still running — try again in a moment.',
            currencyOutcomeFailed:
                'GuruShots rejected the request. Try again later; check the logs if it keeps happening.',
            // Auto-Join settings
            groupAutoJoin: 'Auto Join',
            autoJoin: 'Auto-Join Challenges',
            autoJoinDesc:
                'Automatically join open challenges each voting cycle (autovote must be running). Off by default. When on, it joins ALL open challenges unless you narrow with the type lists below; paid challenges need the coin caps below (0 = free only).',
            autoJoinTypes: 'Only These Types',
            autoJoinTypesDesc:
                'Comma-separated challenge types to join, e.g. "flash,contest". Leave EMPTY to join all types (the default). Case-insensitive.',
            autoJoinExcludeTypes: 'Never Join These Types',
            autoJoinExcludeTypesDesc:
                'Comma-separated challenge types to never auto-join, e.g. "flash,exhibition". Since the default is to join all types, this is how you get "join everything except these". A challenge matched by a saved title profile still joins — a profile is a deliberate per-title opt-in.',
            autoJoinChallengeTags: 'Only Challenges Tagged',
            autoJoinChallengeTagsDesc:
                'Comma-separated CHALLENGE tags to join, e.g. "Exhibition,Turbo". These are the tags GuruShots puts on a challenge (Exhibition, Comm, No comm, Turbo, Magazine, "special 4 pic"), not the tags on your photos. Leave EMPTY to allow all tags. A challenge matches if it carries ANY tag in the list. Case-insensitive.',
            autoJoinExcludeChallengeTags: 'Never Challenges Tagged',
            autoJoinExcludeChallengeTagsDesc:
                'Comma-separated CHALLENGE tags to never auto-join, e.g. "Comm". Subtracts from the scope above, so this is how you get "join everything except these". A title rule that turns auto-join on still joins — that is a deliberate per-title opt-in.',
            autoJoinWithinHoursOfEnd: 'Join Only Near The End',
            autoJoinWithinHoursOfEndDesc:
                'Wait until a challenge is this many hours from ending before joining it, instead of joining the moment it appears. 0 = join as soon as it is seen.',
            autoJoinWithinHoursOfEndHelp:
                'A challenge outside the window is not skipped for good — it is reconsidered every cycle and joined once it enters the window. If a challenge does not report an end time, it is left alone while a window is set rather than joined early.',
            categoryRules: 'Join Timing By Category',
            categoryRulesDesc:
                'Give a whole class of challenges its own entry timing, without naming each title. Match on the challenge type, on how many photos it takes, or on both. These win over the global timing above and lose to a title rule.',
            categoryRulesSaveError:
                'Those category rules could not be saved. Check that no two rows match the same category and that every value is in range.',
            noCategoryRules: 'No category rules yet. Every challenge uses the global timing above.',
            addCategoryRule: 'Add Category Rule',
            removeCategoryRule: 'Remove category rule',
            categoryRuleType: 'Challenge Type',
            categoryRuleTypePlaceholder: 'Any type',
            categoryRulePics: 'Photos',
            categoryRuleAnyPics: 'Any',
            categoryRulePercentElapsed: 'Join After',
            categoryRuleJoinWindow: 'Or Hours Before End',
            categoryRuleInheritPlaceholder: 'Inherit',
            categoryRuleHint:
                'Leave a field empty to inherit the global setting; enter 0 to turn that override off for this category. When both are filled the percentage is used. Photo count is a good stand-in for length: 4-photo challenges usually run a day, 2-photo ones two days, 3-photo ones three.',
            autoJoinAfterPercentElapsed: 'Join After % Of Challenge Has Run',
            autoJoinAfterPercentElapsedDesc:
                'Wait until this much of a challenge has already run before joining it, as a percentage of its own length. 75 means "join once three-quarters is over". 0 = off.',
            autoJoinAfterPercentElapsedHelp:
                'Use this instead of a fixed number of hours when challenges vary in length: 75% lands 6 hours before the end of a 24-hour challenge and 5 days before the end of a 3-week exhibition, whereas one hours setting cannot suit both. When this is above 0 it replaces the hours window entirely. A challenge that does not report both a start and an end time is left alone rather than joined early.',
            autoJoinMaxCoins: 'Max Coins Per Challenge',
            autoJoinMaxCoinsDesc:
                'Highest coin cost to pay to join a single challenge. 0 = free challenges only. Paid joins also require a per-cycle budget above 0.',
            autoJoinCycleCoinBudget: 'Coin Budget Per Cycle',
            autoJoinCycleCoinBudgetDesc:
                'Total coins auto-join may spend in one cycle. 0 = spend nothing (paid joins off). Both this and the per-challenge cap must be above 0 to join paid challenges.',
            // Discover (un-joined challenges)
            discoverTitle: 'Discover Challenges',
            discoverCountLabel: 'open challenges',
            discoverRefresh: 'Refresh',
            discoverEmpty: 'No open challenges to join right now.',
            discoverUnavailableList: 'Could not load open challenges. Check your connection and try again.',
            discoverUntitled: 'Untitled challenge',
            discoverCostFree: 'free',
            discoverCostPaid: '{coins} coins',
            discoverJoin: 'Join',
            discoverJoinPaid: 'Join (paid)',
            discoverJoining: 'Joining…',
            discoverRetrySubmit: 'Retry submit',
            discoverConfirmTitle: 'Join paid challenge?',
            discoverConfirmBody: 'Joining "{title}" costs {coins} coins.',
            discoverConfirmBalance: 'You have {current} coins; this costs {cost}, leaving {resulting}.',
            discoverConfirmBalanceUnknown: 'Your current coin balance could not be read.',
            discoverConfirmInsufficient: 'You have {current} coins; this challenge costs {cost} — not enough to join.',
            discoverConfirmSpend: 'Spend {coins} coins',
            // Discover join outcomes
            discoverJoined: 'Joined.',
            discoverUnaffordable: 'Not enough coins to join (needs {coins}, you have {have}).',
            discoverGenericError: 'Could not join — please try again.',
            discoverBalanceUnknown: 'Could not read your coin balance — not joined.',
            discoverChargedPending:
                'Coins were charged but the join did not finish. Retry the submit — you will not be charged again.',
            discoverFailedNoCharge: 'Could not join. No coins were charged.',
            discoverNoPhoto: 'No eligible photo to submit. No coins were charged.',
            discoverUnavailable: 'This challenge is no longer open to join.',
            discoverBusy: 'A join is already in progress.',
            validationOutOfRange: 'Enter a value between {min} and {max}.',
            validationAtLeast: 'Enter a value of {min} or more.',
            autoFillBadge: 'auto-fill',
            customBadge: 'custom',
            customSettingsHint: 'Has custom settings',
            mustIncludeTags: 'Must Include Tags',
            mustIncludeTagsDesc:
                'Hard filter for both auto-fill and the manual fill buttons. Only consider photos whose auto-detected labels match all of these tags. Leave empty to consider all eligible photos. Matching is case-insensitive and whole-word: plurals and word endings still match ("cat" matches "cats"), but a tag will not match a longer, unrelated word ("cat" does not match "catamaran"). Multi-word tags match per word, so "sea life" requires both.',
            shouldIncludeTags: 'Should Include Tags',
            shouldIncludeTagsDesc:
                'Soft preference for both auto-fill and manual fill. Prefer photos whose labels match these tags; matches rank above the auto-detected challenge keyword score but do not exclude other photos. If nothing matches, fill proceeds with the normal ranking. Matching follows the same whole-word rules as Must Include Tags.',
            ignoreTitleWords: 'Ignore These Words in Challenge Titles',
            ignoreTitleWordsDesc:
                'Words to strip from a challenge title before it is used to find matching photos. Challenge titles usually qualify their subject rather than just naming it — "Epic Lighthouses" is about lighthouses, not "epic" — and those extra words both blur the theme and use up the small number of searches per challenge. The list is pre-filled with common ones; edit it freely. Remove a word if a challenge really is about it. Series prefixes like "Color Hunt:" are handled automatically and do not need an entry.',
            fillWithoutTagMatch: 'Fill Even Without a Tag Match',
            fillWithoutTagMatchDesc:
                'Only matters when Must Include Tags is set. Because a photo must match every tag, this triggers more often when several tags are required. When on (default), if none of your photos match all those tags the best available photo is added anyway so the slot is not left empty. When off, the slot stays empty until a fully matching photo exists.',
            emergencyFill: 'Emergency Fill',
            emergencyFillDesc:
                'Safety net that runs in the last minutes of a challenge when auto-fill would otherwise leave entry slots empty — either because auto-fill is off, or because your Must Include Tags match no photo and Fill Without Tag Match is off. When a challenge is within this much time of closing, it fills the remaining slots with your best available photos anyway, even if they do not match your tags. This overrides those settings on purpose, so the challenge does not end with unused slots. Within this same window it also applies any available Boost and any won Turbo — even if Auto-Apply Boost or Auto-Apply Turbo is off for the challenge — so they are not wasted when it closes. Entered as hours and minutes in the GUI. Default 5 minutes; set to 0 to disable it (which also turns off this last-minute Boost/Turbo override). Tip: keep this window no longer than the Last Minute Threshold (default 10 minutes) so the app is already checking frequently for the whole of it.',
            emergencyFillHelp:
                'A last-minutes safety net measured as time-before-close. Set to 0 to disable it entirely (which also drops its last-minute Boost/Turbo rescue). 0 means "off" here — unlike the Exposure Target settings where 0 means "follow the trigger".',
            tagsPlaceholder: 'e.g. sunset, beach, ocean',
            titleTagRules: 'Per-Title Rules',
            titleTagRulesDesc:
                'Assign a profile and optional tags by exact challenge title (case-insensitive). It reapplies when that challenge returns with a new id; manual settings win. Tags combine with profile/global tags.',
            titleTagRulesSaveError:
                'Could not save title rules. Check profile names, title/tag lengths, and conflicts with manual settings for open challenges. Other settings were saved.',
            titleTagRuleTitle: 'Challenge title',
            titleTagRuleTitlePlaceholder: "e.g. Let's See Hats",
            titleRuleTitlesLabel: 'Challenge titles (any one matches)',
            addTitleRuleTitle: 'Add title',
            removeTitleRuleTitle: 'Remove title',
            titleRuleMatch: 'Title match',
            titleRuleMatchExact: 'Is exactly',
            titleRuleMatchStarts: 'Starts with',
            titleRuleMatchContains: 'Contains',
            titleRuleChallengeTag: 'Challenge tag',
            titleRuleChallengeTagPlaceholder: 'e.g. Exhibition',
            titleRuleChallengeTagHint:
                "The challenge's own tag, not a photo tag. Leave the title empty to match on the tag alone.",
            titleRuleProfile: 'Automatic profile',
            titleRuleInherit: 'Inherit',
            titleRuleOn: 'On',
            titleRuleOff: 'Off',
            titleRuleAutoJoin: 'Auto-join this title',
            titleRuleAutoFill: 'Auto-fill this title',
            titleRuleJoinWindow: 'Join within hours of end',
            titleRuleJoinWindowPlaceholder: 'inherit',
            titleRuleOverridesLabel: 'Per-title behaviour',
            addTitleTagRule: 'Add rule',
            removeTitleTagRule: 'Remove rule',
            noTitleTagRules: 'No rules yet. Add one for a challenge title.',
            usingProfile: 'Using profile',
            none: '(none)',
            addOnePhoto: 'Add one photo to fill an empty slot',
            fillAllPhotos: 'Fill all empty slots now (no spacing)',
            cancel: 'Cancel',
            challengeDefaults: 'Challenge Defaults',
            // Keys, Swaps & Fills (currency automation) settings
            groupCurrencyAuto: 'Keys, Swaps & Fills',
            autoKeyUnlock: 'Auto-Use a Key',
            autoKeyUnlockDesc:
                "Spend a key to unlock this challenge's locked Boost once the timing below is reached. Unlock only — the Boost is then applied by Auto-Apply Boost at the Key-Unlocked Boost Time. Set per challenge or in a profile; there is no global switch.",
            autoKeyAfterStart: 'Key: After Time From Start',
            autoKeyAfterStartDesc:
                'Use the key only once the challenge has been running this long (e.g. 11h). 0 = no condition.',
            autoKeyBeforeEnd: 'Key: Within Time Before End',
            autoKeyBeforeEndDesc: 'Use the key only when this much time or less is left (e.g. 7h). 0 = no condition.',
            autoKeyAfterPercent: 'Key: After % Of Challenge',
            autoKeyAfterPercentDesc: 'Use the key only once this share of the challenge has run. 0 = no condition.',
            autoSwap: 'Auto-Swap a Photo',
            autoSwapDesc:
                'Spend a swap to replace one of your entries with the best-matching photo from your library once the timing below is reached. Set per challenge or in a profile; there is no global switch.',
            autoSwapAfterStart: 'Swap: After Time From Start',
            autoSwapAfterStartDesc: 'Swap only once the challenge has been running this long. 0 = no condition.',
            autoSwapBeforeEnd: 'Swap: Within Time Before End',
            autoSwapBeforeEndDesc: 'Swap only when this much time or less is left. 0 = no condition.',
            autoSwapAfterPercent: 'Swap: After % Of Challenge',
            autoSwapAfterPercentDesc: 'Swap only once this share of the challenge has run. 0 = no condition.',
            autoSwapImageIndex: 'Swap Entry',
            autoSwapImageIndexDesc:
                "Which entry gets replaced: 1 = first, 2 = second, etc. Use 0 for the last entry. A boosted or turbo'd entry is skipped for the previous one unless allowed below.",
            autoSwapLowestVotes: 'Swap The Entry With Fewest Votes',
            autoSwapLowestVotesDesc: 'Ignore Swap Entry and replace whichever entry has the fewest votes.',
            autoSwapAllowBoosted: 'Allow Swapping Boosted/Turbo Entries',
            autoSwapAllowBoostedDesc:
                "By default a boosted or turbo'd entry is never swapped out — its Boost/Turbo stays with the photo. Turn on to allow it; the card then offers to swap the original back.",
            autoSwapMaxVotes: 'Swap Only Below Votes',
            autoSwapMaxVotesDesc: 'Only swap when the chosen entry has fewer votes than this. 0 = no vote condition.',
            autoSwapMax: 'Max Swaps In This Challenge',
            autoSwapMaxDesc: 'Stop auto-swapping once this challenge has had this many swaps (manual swaps count too).',
            autoExposureFill: 'Auto-Use a Fill',
            autoExposureFillDesc:
                'Spend a fill to top exposure up to 100% — but only when exposure is below the threshold below AND there are not enough photos left to vote it back up. Usually needed in flash challenges. Set per challenge or in a profile; there is no global switch.',
            autoExposureFillBelow: 'Fill When Exposure Below',
            autoExposureFillBelowDesc: 'A fill is only spent while exposure is below this and voting cannot reach it.',
            autoExposureFillAfterStart: 'Fill: After Time From Start',
            autoExposureFillAfterStartDesc:
                'Fill only once the challenge has been running this long. 0 = no condition.',
            autoExposureFillBeforeEnd: 'Fill: Within Time Before End',
            autoExposureFillBeforeEndDesc: 'Fill only when this much time or less is left. 0 = no condition.',
            autoExposureFillAfterPercent: 'Fill: After % Of Challenge',
            autoExposureFillAfterPercentDesc: 'Fill only once this share of the challenge has run. 0 = no condition.',
            autoExposureFillMax: 'Max Auto Fills In This Challenge',
            autoExposureFillMaxDesc:
                'Stop auto-filling once this many fills were spent automatically on this challenge.',
            currencyReserveKeys: 'Keep At Least (Keys)',
            currencyReserveKeysDesc:
                'Automatic spending never takes your keys below this. Manual spending from the card is not limited. 0 = no reserve.',
            currencyReserveSwaps: 'Keep At Least (Swaps)',
            currencyReserveSwapsDesc:
                'Automatic spending never takes your swaps below this. Manual spending from the card is not limited. 0 = no reserve.',
            currencyReserveFills: 'Keep At Least (Fills)',
            currencyReserveFillsDesc:
                'Automatic spending never takes your fills below this. Manual spending from the card is not limited. 0 = no reserve.',
            currencyRuleTimingHelp:
                'Each action has three optional timing conditions: after time from start, within time before end, and after % of the challenge. Every condition you set must be true at the same time — e.g. "after 11h from start" plus "within 7h before end" waits for both. Leave all at 0 to act as soon as the action is possible. Each action spends at most once per cycle, and the global reserve is always kept.',
            groupGeneral: 'General',
            groupBoost: 'Boost',
            groupTurbo: 'Turbo',
            groupFinalWindow: 'Final Window Exposure',
            groupLastMinute: 'Last Minute',
            groupScheduledFill: 'Scheduled Voting',
            groupVotingPause: 'Voting Pause',
            groupAutoFill: 'Auto Fill',
            groupRewards: 'Rewards',
            groupNotifications: 'Notifications',
            groupDisplay: 'Display',
            tierCore: 'Core',
            tierEntries: 'Entries',
            tierOverrides: 'Timing Overrides',
            tierOverridesDesc: 'All off by default — turn one on only to change when the normal exposure rule applies.',
            tierApp: 'App',
            // Notification settings (all default off, opt-in)
            autoClaimPrizes: 'Auto-Claim Prizes',
            autoClaimPrizesDesc:
                'Automatically claim rewards from finished challenges and prizes from completed missions (autovote must be running). Checks at most once an hour. Off by default.',
            notifyOnBoost: 'Notify before boost',
            notifyOnBoostDesc: 'Warn before a boost is applied, so you can keep the app running.',
            notifyOnTurbo: 'Notify before turbo',
            notifyOnTurboDesc: 'Warn before a turbo is played, so you can keep the app running.',
            notifyOnAutoFill: 'Notify before auto-fill',
            notifyOnAutoFillDesc:
                'Warn before an entry is auto-filled near the deadline, so you can keep the app running.',
            notifyOnEmergencyFill: 'Notify before emergency fill',
            notifyOnEmergencyFillDesc: 'Warn before a last-second emergency fill, so you can keep the app running.',
            notifyLeadTime: 'Warn this far ahead',
            notifyLeadTimeDesc: 'How many minutes before an action a warning is shown.',
            notifyLeadTimeHelp:
                'Best-effort: the app can only warn on a cycle it actually runs, so a lead longer than your check frequency near a deadline may arrive with little warning. It is most reliable within your last-minute window.',
            // Notification title/body templates. {action} reuses the deadline
            // action labels; {title} is the challenge name; {minutes}/{count}
            // are filled in by the notification layer.
            notifyTitle: '{action} coming up',
            notifyBody: '{action} for "{title}" in ~{minutes} min — keep the app open until then.',
            notifyGroupTitle: 'Actions coming up',
            notifyGroupBody: '{count} actions due in the next ~{minutes} min — keep the app open until then.',
            challengeName: 'Challenge',
            challengeOverrides: 'Challenge Overrides',
            challengeSettings: 'Challenge Settings',
            challengeSettingsDesc:
                'Configure settings specific to this challenge. Overrides will take precedence over global defaults.',
            checkForUpdates: 'Check for Updates',
            checkForUpdatesDesc: 'Check now for a newer release instead of waiting for the automatic check.',
            compactCards: 'Compact Cards',
            compactCardsDesc:
                'Show challenges as smaller cards so more fit on screen at once; turn off for full-size cards with more detail.',
            compact: 'Compact',
            details: 'Details',
            configureBoost: 'Configure Boost for',
            currentVersion: 'Current version',
            cycles: 'Cycles:',
            downloadUpdate: 'Download Update',
            ends: 'Ends',
            english: 'English',
            entries: 'Entries',
            entryDetails: 'Entry Details',
            entryPhoto: 'Entry photo',
            viewEntryPhoto: 'View entry photo',
            error: 'Error',
            errorCheckingUpdates: 'Error checking for updates',
            errorLoadingUiSettings: 'Error loading UI settings',
            exposure: 'Exposure',
            exposureDesc:
                'The exposure percentage below which the bot keeps voting a challenge. Default 100 means vote toward full exposure.',
            exposureTarget: 'Exposure Target',
            exposureTargetDesc:
                'Vote up to this percentage when the normal exposure rule fires (0 = same as Exposure trigger)',
            exposureTargetHelp:
                '0 does NOT mean off. 0 means "vote up to the Exposure trigger value" — the rule stays active. Enter 1-100 only to keep voting past the trigger up to that exposure. Contrast the time settings like Boost Time, where 0 means the feature is off.',
            fast: 'FAST',
            global: 'Global',
            globalDefault: 'Global Default',
            globalSettings: 'Global Settings',
            hours: 'hours',
            language: 'Language',
            languageDesc: 'Interface language for the app (English or Latvian).',
            lastMinuteThreshold: 'Last Minute Threshold',
            lastMinuteThresholdDesc:
                'When a challenge is within this many minutes of closing, the bot votes it straight to 100%, ignoring the exposure triggers. Within this window, Vote Only in Last Minute takes effect and checks run at the Last Minute Check Frequency.',
            lastRun: 'Last Run:',
            latestVersion: 'Latest version',
            latvian: 'Latviešu',
            local: 'Local',
            minutes: 'minutes',
            missingConfigFor: 'Missing config for',
            next: 'Next',
            noComm: 'No comm',
            noEntries: 'No entries',
            noGlobalSettingsToDisplay: 'No global settings to display',
            noOverrides: 'No challenge-specific overrides configured',
            noUiSettingsToDisplay: 'No UI settings to display',
            noUpdatesAvailable: 'No updates available',
            normal: 'NORMAL',
            of: 'of',
            onePhoto: '1 photo',
            onlyBoost: 'Only Boost Mode',
            onlyBoostDesc: 'Skip regular voting for this challenge entirely and only apply Boost.',
            voteOnNewEntry: 'Vote on New Entry',
            voteOnNewEntryDesc:
                'When a new photo appears in this challenge — added by you on the website, or by Auto Fill, Emergency Fill, or a Boost/Turbo fill — vote once even if exposure already reads at or above your threshold. It votes up to whichever ceiling the challenge would normally use: Exposure Target (or Exposure, when Target is 0), or Final Window Exposure Target during the final window when Use Final Window Exposure is on. Does not override Only Boost Mode, Vote Only in Last Minute, or Scheduled Voting Only: if any of those is blocking, no vote happens.',
            override: 'Override',
            overrideForChallenge: 'Override for Challenge',
            photo: 'photo',
            photos: 'photos',
            noActiveChallenges: 'No active challenges',
            players: 'Players',
            pleaseLogin: 'Please log in to view challenges',
            prerelease: 'Pre-release',
            prize: 'Prize',
            rank: 'Rank',
            rememberLoginSession: 'Remember login session',
            remindMeLater: 'Remind Me Later',
            removeCurrentTimezone: 'Remove current timezone',
            resetToGlobal: 'Reset to Global',
            resetToDefault: 'Reset to default',
            resetToDefaultNotSaved: 'Reset to default (not saved until Save)',
            resetAll: 'Reset All',
            resetAllConfirmTitle: 'Reset All Settings',
            resetAllConfirmMessage: 'Are you sure you want to reset ALL settings to their default values?',
            resetAllConfirmDetails:
                'This will reset:\\n• All UI settings (theme, language, timezone)\\n• All global challenge defaults\\n• Application preferences\\n• Window positions and sizes\\n• Custom timezones\\n• Username and login session preferences\\n\\nOnly your login token, last update check time, mock mode setting, and API headers will be preserved.\\n\\nThis action cannot be undone.',
            resetAllSuccess:
                'All settings have been reset to their default values. The page will reload to apply changes.',
            save: 'Save',
            scrollToTop: 'Scroll to top',
            seconds: 'seconds',
            settings: 'Settings',
            skipThisVersion: 'Skip This Version',
            speed: 'Speed',
            startAutoVote: 'Start Auto Vote',
            stayLoggedIn: 'Stay Logged In',
            stayLoggedInDesc: 'Keep your session so you stay signed in after closing the app.',
            stopAutoVote: 'Stop Auto Vote',
            theme: 'Theme',
            themeDesc: 'Switch the app between a light and a dark look.',
            time: 'Time',
            timezone: 'Timezone',
            timezoneDesc: 'The timezone used to show challenge start and end times in your local time.',
            timezonePlaceholder: 'Enter timezone',
            uiSetting: 'UI Setting',
            updateAvailable: 'Update available!',
            run: 'Run',
            running: 'Running...',
            vote: 'Vote',
            voteTitle: 'Vote this challenge to 100% now (overrides automation; the bot keeps running)',
            voteAll: 'Vote All',
            voteToNextLevel: 'vote to next level',
            voted: 'Voted!',
            votedAll: 'Voted All!',
            votes: 'Votes',
            votesNeeded: 'votes needed',
            voting: 'Voting...',
            votingAll: 'Voting All...',
            checkFrequency: 'Check Frequency',
            checkFrequencyDesc:
                'Each cycle uses a random delay in this range. Set min and max equal for a fixed cadence.',
            checkFrequencyMin: 'Min',
            checkFrequencyMax: 'Max',
            reliability: 'Reliability',
            apiMaxRetries: 'API Retries',
            apiMaxRetriesDesc:
                'How many times to retry a failed API request before giving up (0 disables). Covers transient network errors, timeouts, rate limits (429) and server errors (5xx). Retry Delay is the base backoff in milliseconds, which roughly doubles each attempt.',
            apiRetryBaseDelayMs: 'Retry Delay (ms)',
            voteOnlyInLastMinute: 'Vote Only in Last Minute',
            voteOnlyInLastMinuteDesc:
                'Skip a challenge entirely until it reaches the Last Minute Threshold window, then vote it to 100%. This holds your voting back to the final stretch instead of spreading it across the challenge.',
            lastMinuteCheckFrequency: 'Last Minute Check Frequency',
            lastMinuteCheckFrequencyDesc:
                'How often (in minutes) to re-check a challenge once it is inside the Last Minute Threshold. The default 1 checks every minute so the final push is not missed.',
            useScheduledFill: 'Use Scheduled Voting',
            useScheduledFillDesc:
                "Vote exposure up to 100% at chosen times instead of only when it drops below the Exposure threshold. This schedules voting only — it never submits a photo (that is Auto-Fill). Two trigger lists are available and can be combined: one or more daily Voting Times and one or more one-shot Voting Before End offsets. Each entry opens its own independent voting window — e.g. offsets of 10h and 4h before the end vote twice on closing day. During a window the challenge is voted up to 100% and held there; times are interpreted in the app Timezone setting (not this device's clock). Has no effect until at least one time below is set, and never applies to flash challenges or challenges in Boost Only mode. If the app is not running during a whole window, that window is skipped — there is no catch-up.",
            scheduledFillTime: 'Voting Times',
            scheduledFillTimeDesc:
                "Daily wall-clock times (24h) at which voting windows open, in the app Timezone setting — not this device's clock. Each time opens its own window every day; remove all rows to turn this trigger off. Around a daylight-saving switch the actual instant can shift by up to an hour on the changeover day.",
            scheduledFillTimeOff: 'no times set — this trigger is off',
            scheduledFillBeforeEnd: 'Voting Before End',
            scheduledFillBeforeEndDesc:
                "Open one-shot voting windows these long before the challenge closes — e.g. 10h 0m and 4h 0m to vote twice on closing day. Entered as hours and minutes in the GUI; remove all rows to turn this trigger off. These are relative to each challenge's own deadline — re-check them when reusing a saved profile on a challenge with a different timeline.",
            scheduledFillBeforeEndOff: 'no offsets set — this trigger is off',
            scheduledFillAddTime: 'Add time',
            scheduledFillAddBeforeEnd: 'Add offset',
            scheduledFillRemoveEntry: 'Remove entry',
            scheduledFillEntryDraft: 'set a time — 0h 0m rows are not saved',
            scheduledFillDuplicateEntry: 'duplicate — this entry is ignored',
            scheduledFillMaxEntries: 'Maximum of {0} entries reached.',
            scheduledFillSourceBeforeEnd: '{0} before end',
            scheduledFillWindowMinutes: 'Voting Window (minutes)',
            scheduledFillWindowMinutesDesc:
                'How long each voting window stays open after its start time. Within the window the challenge is topped up to 100% and held there; after it closes, normal rules apply again. Keep it longer than your Check Frequency so a voting cycle is guaranteed to land inside the window.',
            scheduledFillReplaces: 'Scheduled Voting Only',
            scheduledFillReplacesDesc:
                'When on, normal and final-window exposure voting are blocked outside the scheduled voting windows — the scheduled times become the only automatic voting. Flash challenges and the Last Minute rules still vote as usual, manual voting is unaffected, and Vote Only in Last Minute takes precedence over this setting. Warning: if the app is not running during a whole window, that window is skipped with no catch-up and no threshold fallback, so the challenge can close under-exposed.',
            scheduledFillNextHint: 'Next voting window: {0}–{1} ({2}) — from {3}',
            scheduledFillNoTimesHint:
                'No voting time configured — scheduled voting is inactive until you set one below.',
            scheduledFillWastedWindowHint:
                'The windows for {0} extend past the challenge deadline — only the part before the close is usable.',
            scheduledFillShortWindowHint:
                'This window is shorter than your maximum Check Frequency ({0} min) — a whole window could fall between voting cycles while the app is running unattended.',
            scheduledFillUnreachableHint:
                'Scheduled Voting Only is on, but no voting window can still occur before this challenge closes — normal and final-window voting stay blocked, so only the Last Minute rules will vote.',
            scheduledFillProfileReplacesWarning:
                'Applying this profile turns on Scheduled Voting Only for this challenge — review the voting times before saving.',
            useVotingPause: 'Pause Voting',
            useVotingPauseDesc:
                "Stop automatic voting during chosen windows — meant for the overnight gap between match rounds, where filled exposure earns very few votes and those swipes are better spent once the next round opens. Two trigger lists are available and can be combined: one or more daily Pause Times and one or more one-shot Pause Before End offsets. Each entry starts its own pause lasting the Pause Duration below; times are interpreted in the app Timezone setting (not this device's clock). Has no effect until at least one time below is set. Flash challenges and the Last Minute rules still vote, so a challenge that actually closes during a pause is never abandoned, and Boost and Turbo still apply on their own timers. Manual voting is never blocked.",
            votingPauseTime: 'Pause Times',
            votingPauseTimeDesc:
                "Daily wall-clock times (24h) at which a pause starts, in the app Timezone setting — not this device's clock. Each time starts its own pause every day; remove all rows to turn this trigger off. For a 01:30-06:00 night pause, set 01:30 here and a Pause Duration of 270 minutes. Around a daylight-saving switch the actual instant can shift by up to an hour on the changeover day.",
            votingPauseBeforeEnd: 'Pause Before End',
            votingPauseBeforeEndDesc:
                "Start a one-shot pause this long before the challenge closes. Entered as hours and minutes in the GUI; remove all rows to turn this trigger off. These are relative to each challenge's own deadline — re-check them when reusing a saved profile on a challenge with a different timeline. A pause reaching past the deadline still yields to the Last Minute rules, which always vote.",
            votingPauseDurationMinutes: 'Pause Duration (minutes)',
            votingPauseDurationMinutesDesc:
                'How long each pause lasts from its start time. When it ends, normal rules apply again and exposure is topped up on the next voting cycle. Example: 270 minutes starting at 01:30 pauses until 06:00.',
            votingPauseNextHint: 'Next pause: {0}–{1} ({2}) — from {3}',
            votingPauseActiveHint:
                'Paused now until {0} ({1}) — only Last Minute and flash voting will run. Boost and Turbo still apply on their own timers.',
            votingPauseShortWindowHint:
                'This pause is shorter than your maximum Check Frequency ({0} min) — a voting cycle may skip over it entirely, so voting would continue as if no pause were set.',
            votingPauseNoTimesHint: 'No pause time configured — voting pause is inactive until you set one below.',
            votingPauseAllDayHint:
                'These pauses cover the whole day — outside the Last Minute rules this challenge would never vote automatically.',
            finalWindowDuration: 'Final Window Duration',
            finalWindowDurationDesc:
                'How long the final window before a challenge closes lasts. The Final Window Exposure rule applies inside this window. Defaults to 1 hour.',
            finalWindowDurationHelp:
                'The length of the final window measured back from the challenge close time. Set to 1 hour to reproduce the old fixed last-hour behaviour, or shorten/lengthen it to change when the Final Window Exposure trigger and target take over.',
            finalWindowExposure: 'Final Window Exposure',
            finalWindowExposureDesc:
                'The exposure level that triggers voting during the final window (only when Use Final Window Exposure is on). Must be at or below your Exposure setting.',
            finalWindowExposureTarget: 'Final Window Exposure Target',
            finalWindowExposureTargetDesc:
                'Vote up to this percentage when the final-window rule fires (0 = same as Final Window Exposure trigger)',
            finalWindowExposureTargetHelp:
                '0 does NOT mean off. 0 means "vote up to the Final Window Exposure trigger" — the final-window rule stays active. Enter 1-100 to keep voting past that trigger. Contrast the time settings, where 0 means off.',
            useFinalWindowExposure: 'Use Final Window Exposure',
            useFinalWindowExposureDesc:
                'In the final window before a challenge closes, use the separate Final Window Exposure trigger and target instead of the normal Exposure setting.',
            voteBeforeFinalWindow: 'Vote Before Final Window',
            voteBeforeFinalWindowDesc:
                'Around the start of the final window, vote up to your standard Exposure target so a challenge whose exposure already decayed below it is not left stranded there by the lower Final Window Exposure trigger. The top-up stays active across a window that straddles the final-window boundary — for the Lead minutes before it and the same number of minutes after — then the Final Window Exposure rule takes over. Only applies when Use Final Window Exposure is on.',
            voteBeforeFinalWindowLeadMin: 'Vote Before Final Window Lead',
            voteBeforeFinalWindowLeadMinDesc:
                'How many minutes around the start of the final window the top-up stays active. The window opens this many minutes before the final window and closes the same number of minutes into it, after which the Final Window Exposure rule takes over.',
            validationInvalidValue: 'Invalid value',
            validationMustBeLessOrEqual: 'Must be ≤ {0} (currently {1})',
            whatsNew: "What's New:",
            yourEntries: 'Your Entries',
            yourProgress: 'Your Progress',
            // Additional keys for React components
            refresh: 'Refresh',
            challengeOverrideInfo: 'Settings configured here will override global defaults for this challenge only.',
            mockMode: 'Mock Mode',
            logout: 'Logout',
            status: 'Status',
            title: 'GuruShots Auto Vote',
            downloadingUpdate: 'Downloading Update...',
            updateReady: 'Update Ready',
            updateError: 'Update Error',
            releaseNotes: 'Release Notes',
            updateReadyToInstall: 'Update downloaded and ready to install. Restart to apply.',
            skipVersion: 'Skip Version',
            remindLater: 'Remind Later',
            download: 'Download',
            restartLater: 'Restart Later',
            restartNow: 'Restart Now',
            close: 'Close',
            downloadInBrowser: 'Download in Browser',
            overridden: 'Overridden',
            usingGlobal: 'Using Global',
            overridesActiveSummary: '{0} manual override(s); other settings use the profile/global baseline.',
            overridesNoneSummary: 'No manual overrides; using the profile/global baseline.',
            enableOverride: 'Enable override for this challenge',
            clearAll: 'Clear All',
            notApplicable: 'Not applicable',
            notApplicableHint: 'Your saved values are kept.',
            naBoostUsed: "Boost already used for this challenge — these settings won't take effect.",
            naTurboUsed: "Turbo already used for this challenge — these settings won't take effect.",
            naSlotsFull: 'All entry slots are full — auto-fill has nothing to add.',
            naFlashNoBoost: "Flash challenges don't support Boost.",
            naFlashNoScheduledFill: 'Flash challenges always vote to 100% — scheduled voting never applies.',
            naFlashNoVotingPause: 'Flash challenges always vote to 100% — the voting pause never applies.',
            naFlashNoTurbo: "Flash challenges don't support Turbo.",
            challengeProfiles: 'Profiles',
            applyProfile: 'Apply',
            deleteProfile: 'Delete',
            confirmDelete: 'Confirm delete?',
            confirmOverwrite: 'Overwrite?',
            saveAsProfile: 'Save current as profile',
            profileNamePlaceholder: 'Profile name (e.g. "2-pic tactic")',
            noProfiles: 'No saved profiles',
            profileSaveError: 'Could not save the profile — a value failed validation.',
            profileNameRequired: 'Enter a profile name first.',
            profileNameTooLong: 'Profile name is too long (max {0} characters).',
            profileLimitReached: 'Profile limit reached ({0}) — delete one first.',
            profileAppliedHint: 'Applied — review the values below, then Save.',
            profileApplyHint:
                'Applying a profile replaces the current form values (including unsaved edits); settings the profile does not include revert to "Using Global".',
            profileOverwriteHint: 'Saving with an existing name overwrites that profile.',
            intentBuiltIn: 'Built-in preset',
            intentModified: 'Edited built-in',
            intentJustParticipate: 'Just Participate',
            intentJustParticipateDesc:
                'Keeps your entries filled but never spends a Boost or Turbo and does not chase exposure past the trigger — low effort, low risk.',
            intentFinishStrong: 'Finish Strong',
            intentFinishStrongDesc:
                'Plays normally most of the challenge, then spends Boost and Turbo and pushes exposure hard in the final window.',
            intentMaxExposure: 'Max Exposure',
            intentMaxExposureDesc:
                'Pushes everything the whole way: votes to full exposure throughout, fills entries, and spends Boost and Turbo.',
            naExhibitionNoTurbo: "Exhibition challenges don't support Turbo.",
            naBoostSinglePhoto: "Single-photo challenges never unlock Boost — these settings won't take effect.",
        },
        // Logs page specific
        logs: {
            title: 'Logs',
            status: 'Status',
            empty: 'No logs yet.',
            connected: 'Connected',
            disconnected: 'Disconnected',
        },
    };
});
