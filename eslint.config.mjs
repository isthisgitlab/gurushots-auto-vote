import globals from 'globals';
import pluginJs from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/** @type {import('eslint').Linter.Config[]} */
export default [
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            // NOTE: no formatting rules (indent/quotes/semi/comma-dangle) here —
            // eslint-config-prettier (last in this array) turns them off anyway,
            // and Prettier (.prettierrc.json) owns those choices.
            // Project rule: route all logging through src/js/logger.js. console.warn /
            // console.error remain allowed for genuinely-bootstrap callers that run
            // before the logger is available; the file overrides below disable the
            // rule entirely for logger.js itself (it owns the console) and for
            // scripts/ (build CLIs where console is the output).
            'no-console': ['error', { allow: ['warn', 'error'] }],
        },
    },
    pluginJs.configs.recommended,
    // Underscore-prefixed args/catch bindings are intentionally unused (e.g.
    // positional params that callers still pass). Lets those sites
    // drop `eslint-disable no-unused-vars` comments, which @ttsc/lint would
    // otherwise warn about as unknown-rule directives on every typecheck run.
    {
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
        },
    },
    // logger.js owns the console — it is the only module allowed to call
    // console.log/debug directly (file-write fallback + format output).
    {
        files: ['src/js/logger.js'],
        rules: {
            'no-console': 'off',
        },
    },
    // Build / dev scripts — console is the primary output channel.
    {
        files: ['scripts/**/*.js'],
        rules: {
            'no-console': 'off',
        },
    },
    // Override for renderer processes (browser environment)
    {
        files: ['src/js/ui/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            'no-undef': 'off', // Disable no-undef for browser globals
        },
    },
    // React JSX files (browser environment)
    {
        files: ['src/js/react/**/*.jsx', 'src/js/react/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
            },
        },
        rules: {
            'no-undef': 'off', // Disable no-undef for browser globals
            // Renderer-bundle boundary. The React tree must never import
            // Node-only, process-spawning code: node-notifier's replacement
            // (services/notify/nodeNotify.js) requires node:child_process, and
            // bundling it here would ship a shell-spawning path into the
            // WebView/Electron renderer — a severe process-isolation regression.
            // Renderer notifications go through react/notifications/
            // deadlineNotifier.js only. The size budget is a late backstop; this
            // is the direct guard.
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'child_process',
                            message: 'The renderer must not spawn processes; use the renderer notifier instead.',
                        },
                        {
                            name: 'node:child_process',
                            message: 'The renderer must not spawn processes; use the renderer notifier instead.',
                        },
                    ],
                    patterns: [
                        {
                            group: ['**/services/notify/nodeNotify', '**/services/notify/nodeNotify.js'],
                            message:
                                'nodeNotify is a Node-only (child_process) delivery module — never import it into the renderer bundle.',
                        },
                    ],
                },
            ],
        },
    },
    // React hooks correctness for the Preact renderer (aliased to react via
    // preact/compat). rules-of-hooks catches conditional / early-return hook
    // calls; exhaustive-deps guards stale closures in the custom hooks
    // (useIpcQuery, useAsyncIpcAction, useTimers). exhaustive-deps stays at warn
    // (advisory, not every missing dep is a bug); rules-of-hooks is a real
    // bug-class, so it errors.
    {
        files: ['src/js/react/**/*.jsx', 'src/js/react/**/*.js'],
        plugins: { 'react-hooks': reactHooks },
        rules: {
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
        },
    },
    // Accessibility lint for the renderer — surfaces the WCAG issues the app
    // already commits to caring about (Modal focus-trap, translated labels).
    // The recommended set as shipped (its levels AND options), plus two rules it
    // leaves off:
    // - control-has-associated-label, with the recommended options (inputs are
    //   ignored there; label-has-for covers them), so an icon-only button needs
    //   an aria-label.
    // - label-has-for as "nesting OR id". It is deprecated in favour of
    //   label-has-associated-control, but that rule cannot tell that a label
    //   whose text is `{t('…')}` has any text and skips it — i.e. every label in
    //   this translated UI — so an orphan <label> (tied to no control) would
    //   otherwise pass. Its default ("nesting AND id") is not what it checks
    //   here.
    {
        plugins: jsxA11y.flatConfigs.recommended.plugins,
        files: ['src/js/react/**/*.jsx', 'src/js/react/**/*.js'],
        rules: {
            ...jsxA11y.flatConfigs.recommended.rules,
            'jsx-a11y/control-has-associated-label': [
                'error',
                jsxA11y.flatConfigs.recommended.rules['jsx-a11y/control-has-associated-label'][1],
            ],
            'jsx-a11y/label-has-for': ['error', { required: { some: ['nesting', 'id'] } }],
        },
    },
    // Settings facade boundary. settings.js is the only public entry point; the
    // modules behind it under settings/ share mutable state (the load-once
    // guards, the active-challenge caches) that a direct require would bypass.
    // settings/schema, storage, limits, uiDefaults and challengeRules are
    // standalone and stay importable.
    {
        files: ['src/js/**/*.js', 'src/js/**/*.jsx', 'scripts/**/*.js'],
        ignores: ['src/js/settings.js', 'src/js/settings/**'],
        rules: {
            'no-restricted-syntax': [
                'error',
                ...[
                    "CallExpression[callee.name='require'] > Literal.arguments",
                    'ImportDeclaration > Literal.source',
                ].map((selector) => ({
                    selector: `${selector}[value=/settings\\/(challengeFacts|challengeOverrides|defaults|migrations|persistence|profileStore|profiles|reset|ruleResolution|titlePins|titleRuleSanitize|titleRules)(\\.js)?$/]`,
                    message: 'Settings internals are private to the facade — require settings.js instead.',
                })),
            ],
        },
    },
    // Renderer IPC boundary. Components, hooks and contexts reach the shell
    // bridge only through src/js/react/api/ (the ipc.js wrappers and the
    // query/action hooks), so the bridge surface stays in one place and no
    // component grows per-platform branching.
    {
        files: ['src/js/react/**/*.jsx', 'src/js/react/**/*.js'],
        ignores: ['src/js/react/api/**'],
        rules: {
            'no-restricted-properties': [
                'error',
                ...['window', 'globalThis'].map((object) => ({
                    object,
                    property: 'api',
                    message:
                        'Call the shell bridge through src/js/react/api/ (e.g. `import * as ipc from "@/api/ipc"`).',
                })),
            ],
        },
    },
    // Jest test files. `pnpm lint` only scans src/ + scripts/, but the lefthook
    // pre-commit hook lints any staged *.{js,jsx} — tests included — so the Jest
    // globals (describe/it/test/expect/jest/beforeEach/…) must be declared here
    // or a staged test edit fails no-undef. Browser globals come too: the
    // happy-dom-project tests touch window/document.
    {
        files: ['tests/**/*.js', 'tests/**/*.jsx'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser,
                ...globals.jest,
            },
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
            },
        },
    },
    eslintConfigPrettier,
];
