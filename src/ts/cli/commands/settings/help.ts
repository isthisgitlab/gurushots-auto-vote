import * as logger from '../../../logger';
import { THEMES } from '../../../settings/uiDefaults';

export const helpSettings = () => {
    logger.withCategory('ui').info(`
=== Settings Management Help ===

Available Commands:
  get-setting <key>     - Get current value of a setting
  set-setting <key> <value> - Set a setting value
  list-settings         - Show all settings and their values
  reset-setting <key>   - Reset a setting to its default value
  reset-all-settings    - Reset all settings to defaults
  help-settings         - Show this help message

Per-challenge overrides:
  Append --challenge=<id> to get-setting / set-setting / reset-setting /
  list-settings to read or write a single challenge's override. Without an
  override the challenge inherits the global default. Only settings that
  support per-challenge overrides accept the flag.
  set-setting on a challenge setting WITHOUT --challenge sets the global
  default instead, and says so.
  Examples:
    set-setting exposure 80 --challenge=12345
    get-setting exposure --challenge=12345
    reset-setting exposure --challenge=12345   (clears the override)

Challenge profiles (named override presets — save a tactic once, recall it):
  list-profiles                              - Show saved profiles and their values
  save-profile <name> --challenge=<id>       - Save that challenge's current overrides as a named profile
  apply-profile <name> --challenge=<id>      - Replace that challenge's overrides with the profile's values
  delete-profile <name>                      - Delete a saved profile
  Profile names with spaces MUST be quoted, e.g.:
    save-profile "2-pic tactic" --challenge=12345
    apply-profile "2-pic tactic" --challenge=67890
  Saving an existing name overwrites it (names match case-insensitively).
  Applying replaces ALL of the challenge's overrides — settings the profile
  doesn't include revert to the global defaults. Profiles are name-keyed, so
  they survive challenge rotation; overrides applied to an id that later
  leaves the active challenge list are cleaned up automatically.

Common Settings:
  apiTimeout           - API request timeout in seconds (default: 30)
  apiMaxRetries        - Retries for transient API failures: network/timeout/429/5xx (default: 3; 0 disables)
  apiRetryBaseDelayMs  - Base backoff delay between retries in ms, doubling each attempt (default: 1000)
  checkFrequencyMin    - Minimum minutes between voting cycles (default: 3)
  checkFrequencyMax    - Maximum minutes between voting cycles (default: 3). Each cycle picks
                         a random delay in [min, max]; set min === max for a fixed cadence.
  mock                 - Use mock API for testing (default: false)
  theme                - UI theme (default: "light"), one of:
                         ${THEMES.join(', ')}
  language             - UI language: "en" or "lv" (default: "en")
  timezone             - Timezone for timestamps (default: "Europe/Riga")

Time settings (stored in SECONDS — the GUI enters them as hours+minutes):
  boostTime            - Seconds left on the BOOST'S OWN timer at which a timer
                         boost is applied (default: 3600 = 1h)
  keyUnlockedBoostTime - Seconds before close to apply a KEY-UNLOCKED boost, which
                         has no timer of its own, so boostTime cannot describe it
                         (default: 900 = 15 min; 0 = off)
  turboTime            - Seconds before close to apply turbo (default: 7200 = 2h)
  emergencyFill        - Emergency Submit: seconds before close to submit photos to
                         empty slots as a last resort
                         (default: 300 = 5 min; 0 = off).

Scheduled voting (vote exposure up to 100% at chosen times — per-challenge, set
with set-global-default or set-setting --challenge=<id>; every entry opens its
own voting window, all OR'd; a single stored value is converted to an
array on load):
  useScheduledFill           - Master switch (default: false). Inert until a
                               time below is set; never applies to flash or
                               boost-only challenges.
  scheduledFillTime          - JSON array of daily 24h "HH:MM" times in the
                               app timezone setting, NOT the device clock.
                               e.g. '["09:00","21:30"]' ([] = off, max 6,
                               no duplicates)
  scheduledFillBeforeEnd     - JSON array of SECONDS-before-close offsets,
                               each opening a one-shot window. e.g.
                               '[14400,36000]' votes at 4h and 10h before the
                               end ([] = off, max 6, no duplicates, each
                               1s..30 days)
  scheduledFillWindowMinutes - How long each voting window stays open
                               (default: 60, range 5-720)
  scheduledFillReplaces      - true = scheduled windows become the ONLY
                               automatic votes (normal + final-window voting are
                               blocked outside them; flash/last-minute rules
                               and manual voting still apply). A window missed
                               while the app is not running is skipped with no
                               catch-up. (default: false)
  Set them like autoFillSchedule (validated JSON values):
    set-global-default scheduledFillTime '["09:00","21:30"]'
    set-setting scheduledFillBeforeEnd '[14400,36000]' --challenge=12345

Voting pause (the inverse of scheduled voting: refuse to vote inside the window
— for the overnight gap between match rounds, where filled exposure earns very
few votes. Same per-challenge scoping and JSON value format):
  useVotingPause             - Master switch (default: false). Inert until a
                               time below is set.
  votingPauseTime            - JSON array of daily 24h "HH:MM" pause STARTS in
                               the app timezone setting, NOT the device clock.
                               e.g. '["01:30"]' ([] = off, max 6, no duplicates)
  votingPauseBeforeEnd       - JSON array of SECONDS-before-close offsets, each
                               starting a one-shot pause. e.g. '[7200]' pauses
                               starting 2h before the end ([] = off, max 6, no
                               duplicates, each 1s..30 days)
  votingPauseDurationMinutes - How long each pause lasts (default: 240, range
                               5-720). For a 01:30-06:00 night pause use
                               votingPauseTime '["01:30"]' with 270 here.
  Flash challenges, the Last Minute rules, Boost and Turbo are NOT paused — a
  challenge that closes mid-pause still gets its final votes.
  Which commands respect a pause: "run"/"start" (the automatic schedule) and
  "vote --challenge=<id>" do. Plain "vote" does NOT — it is the manual
  vote-to-100% path, the same one the GUI's manual button uses, and manual
  voting is never blocked by a pause. So do not script plain "vote" on an
  external cron expecting the pause to hold it back; use "run" instead.
    set-global-default votingPauseTime '["01:30"]'
    set-global-default votingPauseDurationMinutes 270

Auto-Submit schedule (JSON array of {count, seconds} rows):
  autoFillSchedule     - Each row: have at least <count> entries once <seconds>
                         remain before close. Counts 2-4 (max 3 rows, unique) —
                         challenges allow at most 4 images and image 1 always
                         exists. Omit a count to never schedule that image; an
                         empty array [] means auto-submit never submits.
                         Default: [{"count":2,"seconds":1800},{"count":3,"seconds":1200},{"count":4,"seconds":600}]
  Set it with set-global-default (set-setting without --challenge redirects
  here, since the scheduler reads only the global default):
    set-global-default autoFillSchedule '[{"count":2,"seconds":172800},{"count":3,"seconds":10800},{"count":4,"seconds":900}]'
  Per-challenge override (also validated):
    set-setting autoFillSchedule '[{"count":2,"seconds":172800}]' --challenge=12345

Value Types:
  String:   "value" or value
  Number:   30, 3, 100
  Boolean:  true, false
  Array:    [1, 2, 3]
  Object:   {"key": "value"}

Examples:
  set-setting checkFrequencyMin 2
  set-setting checkFrequencyMax 5
  set-setting apiTimeout 60
  set-setting mock true
  get-setting checkFrequencyMin
  reset-setting checkFrequencyMax

💡 Tip: Use "list-settings" to see all available settings and their current values
`);
};
