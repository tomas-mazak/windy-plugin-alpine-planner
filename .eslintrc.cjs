const jsRules = {
    indent: 'off',
    'no-fallthrough': ['warn', { commentPattern: 'break[\\s\\w]*omitted' }],
    'no-cond-assign': 'off',
    'no-console': 'off',
    'no-irregular-whitespace': 'off',
    'no-prototype-builtins': 'off',
    'no-mixed-spaces-and-tabs': 'error',
    'no-const-assign': 'error',
    'no-undef-init': 'error',
    'no-undef': 'error',
    curly: 'error',
    'no-var': 'error',
    'prefer-const': 'error',
    'no-tabs': 'error',
    'no-use-before-define': ['error', { functions: false }], // function declarations are hoisted, so it's safe
    'one-var': ['error', { const: 'never' }],
    'import/no-duplicates': 'error',
    'no-empty': 'error',
    'no-redeclare': 'error',
    'prefer-rest-params': 'off',
    'prefer-spread': 'off',
    'no-import-assign': 'warn',
    'a11y-no-static-element-interactions': 'off',
    'a11y-missing-attribute': 'off',
};

const tsRules = {
    '@typescript-eslint/no-explicit-any': 'off',
    // Both T[] and Array<T> are used
    '@typescript-eslint/array-type': 'off',
    //'@typescript-eslint/no-fallthrough': ['warn', { commentPattern: 'break[\\s\\w]*omitted' }],
    '@typescript-eslint/ban-types': [
        'error',
        {
            types: {
                Boolean: 'Avoid using the `Boolean` type. Did you mean `boolean`?',
                Function:
                    'Avoid using the `Function` type. Prefer a specific function type, like `() => void`.',
                Number: 'Avoid using the `Number` type. Did you mean `number`?',
                Object: 'Avoid using the `Object` type. Did you mean `object`?',
                String: 'Avoid using the `String` type. Did you mean `string`?',
                Symbol: 'Avoid using the `Symbol` type. Did you mean `symbol`?',
            },
        },
    ],
    '@typescript-eslint/explicit-member-accessibility': 'off',
    '@typescript-eslint/member-ordering': [
        'error',
        {
            default: [
                'private-static-field',
                'public-static-field',
                'private-instance-field',
                'public-instance-field',
                'private-constructor',
                'public-constructor',
                'public-instance-method',
                'protected-instance-method',
                'private-instance-method',
            ],
        },
    ],
    '@typescript-eslint/type-annotation-spacing': 'error',
    '@typescript-eslint/unified-signatures': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/promise-function-async': 'off',
    '@typescript-eslint/no-var-requires': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-this-alias': 'off',
    '@typescript-eslint/member-delimiter-style': [
        'error',
        {
            multiline: { delimiter: 'semi', requireLast: true },
            singleline: { delimiter: 'semi', requireLast: false },
        },
    ],
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-misused-new': 'error',
    '@typescript-eslint/semi': ['error', 'always'],
    '@typescript-eslint/no-shadow': ['warn', { hoist: 'all' }],
    '@typescript-eslint/no-inferrable-types': 'off',
    'no-undef': 'off', // TS handles no-undef on its own, this JS rule is buggy for TS files
    'no-use-before-define': 'off', // TS handles this rule with '@typescript-eslint/no-use-before-define'
    'no-redeclare': 'off', // TS handles this rule with '@typescript-eslint/no-redeclare'
    '@typescript-eslint/no-redeclare': 'error',
    // Module constants may be used in functions declared above them
    '@typescript-eslint/no-use-before-define': ['error', { functions: false, variables: false }],
};

// https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/order.md
const importOrder = {
    'import/order': [
        'warn',
        {
            groups: [['builtin', 'internal', 'external'], ['parent', 'sibling', 'index'], 'type'],

            // NOTE: Using @windy/**, @capacitor/**  pattern collides, with 'type' group
            pathGroups: [
                {
                    pattern: 'svelte',
                    group: 'type',
                    position: 'before',
                },
            ],
        },
    ],
};

module.exports = {
    root: true,
    env: {
        es6: true,
        node: true,
        browser: true,
        jest: true,
    },
    parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
    },
    globals: {
        L: true,
        W: true,
        console: true,
    },
    plugins: ['import'],
    extends: ['eslint:recommended'],
    overrides: [
        {
            files: ['**/*.svelte'],
            // WARN import plugin could be an issue in a combination with svelte
            // https://github.com/sveltejs/eslint-plugin-svelte3/blob/master/OTHER_PLUGINS.md
            plugins: ['@typescript-eslint', 'import'],
            parser: 'svelte-eslint-parser',
            parserOptions: {
                parser: '@typescript-eslint/parser',
                // Use separate tsconfig to make linting faster
                project: './tsconfig.eslint.json',
                ecmaVersion: 2022,
                tsconfigRootDir: __dirname,
                sourceType: 'module',
                extraFileExtensions: ['.svelte'],
            },
            extends: [
                'eslint:recommended',
                'plugin:@typescript-eslint/recommended',
                'plugin:import/typescript',
            ],
            rules: {
                ...jsRules,
                ...tsRules,
                ...importOrder,
                'no-undef-init': 'off',
                '@typescript-eslint/no-use-before-define': 'off',
                'no-inner-declarations': 'off',
                'no-self-assign': 'off',
                // Svelte component state is declared with let even when only its fields are assigned
                'prefer-const': 'off',
            },
            settings: {
                'svelte/ignore-styles': () => true,
                'svelte/ignore-warnings': w => w.code.startsWith('a11y-'),
                'svelte/typescript': require('typescript'),
            },
        },
        {
            files: ['**/*.ts'],
            plugins: ['@typescript-eslint', 'import'],
            extends: [
                'eslint:recommended',
                'plugin:@typescript-eslint/recommended',
                'plugin:import/typescript',
            ],
            parser: '@typescript-eslint/parser',
            parserOptions: {
                project: './tsconfig.json',
                ecmaVersion: 2022,
                sourceType: 'module',
            },
            rules: { ...jsRules, ...tsRules, ...importOrder },
            settings: {
                'import/parsers': {
                    '@typescript-eslint/parser': ['.ts'],
                },
                'import/resolver': {
                    'eslint-import-resolver-typescript': true,
                },
            },
        },
        // The end-to-end tests (Playwright, in Node) have their own TypeScript project.
        {
            files: ['e2e/**/*.ts', 'playwright.config.ts'],
            parserOptions: { project: './e2e/tsconfig.json' },
        },
    ],
    rules: jsRules,
    // Unit tests run in Node (npm test) and are outside tsconfig.json's browser project.
    ignorePatterns: ['dist/**', 'node_modules/**', '**/*.test.ts'],
};
