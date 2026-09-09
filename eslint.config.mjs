import globals from 'globals';
import pluginJs from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';

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
            // console.error remain allowed for genuinely-bootstrap callers (e.g.
            // translations/index.js loads before the logger is available); the file
            // overrides below disable the rule entirely for logger.js itself (it owns
            // the console) and for scripts/ (build CLIs where console is the output).
            'no-console': ['error', { allow: ['warn', 'error'] }],
        },
    },
    pluginJs.configs.recommended,
    // Underscore-prefixed args/catch bindings are intentionally unused (e.g.
    // params kept for caller positional backward-compat). Lets those sites
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
