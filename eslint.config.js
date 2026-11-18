import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier/flat'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  globalIgnores(['dist/', '.dist/', '.materials/', '.venv/']),
  js.configs.recommended,
  {
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['*.config.*', 'scripts/**/*.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/**/*.{js,ts,vue}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.{ts,vue}'],
    extends: [tseslint.configs.recommended],
    languageOptions: { parserOptions: { projectService: true, extraFileExtensions: ['.vue'] } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'memberLike', modifiers: ['private'], format: ['camelCase'] },
        {
          // 这些对象键由 DOM 和第三方库的接口定义。
          selector: 'objectLiteralProperty',
          types: ['boolean'],
          filter:
            '^(alpha|antialias|colorWrite|depthBuffer|depthTest|depthWrite|fog|forceSinglePass|immediate|once|passive|polygonOffset|strictPort|transparent|value|vertexColors)$',
          format: null,
        },
        {
          selector: ['variable', 'parameter', 'parameterProperty', 'property', 'accessor'],
          types: ['boolean'],
          format: ['PascalCase'],
          prefix: [
            'is',
            'has',
            'can',
            'should',
            'was',
            'did',
            'will',
            'must',
            'need',
            'allow',
            'support',
            'contain',
            'include',
            'exist',
            'match',
          ],
        },
      ],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-inferrable-types': 'error',
      '@typescript-eslint/only-throw-error': 'error',
    },
  },
  {
    files: ['src/**/*.vue'],
    extends: [vue.configs['flat/essential']],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  prettier,
  {
    // `all` 与 Prettier 兼容。放在这里以覆盖 eslint-config-prettier 的默认设置。
    rules: { curly: ['error', 'all'] },
  },
)
