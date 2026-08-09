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
