import globals from 'globals';
import pluginJs from '@eslint/js';

/** @type {import('eslint').Linter.Config[]} */
export default [
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            indent: ['error', 4],
            quotes: ['error', 'single'],
            semi: ['error', 'always'],
            'comma-dangle': ['error', 'always-multiline'],
        },
    },
    pluginJs.configs.recommended,
    // Override for renderer processes (browser environment)
    {
        files: [
            'src/js/app.js',
            'src/js/login.js',
            'src/js/translations.js',
            'src/js/ui/**/*.js'
        ],
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
];
