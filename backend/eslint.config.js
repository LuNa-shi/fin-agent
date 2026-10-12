// 最小 lint 配置：只查正确性类问题，不做风格重排（风格以 .editorconfig 为准）。
// 原则见 CONTRIBUTING.md——不引入全量 reformat，保护 git blame。
import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', 'data/**'] },
  {
    files: ['src/**/*.js', 'evals/**/*.js', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        console: 'readonly', process: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly',
        TextDecoder: 'readonly', TextEncoder: 'readonly', crypto: 'readonly', structuredClone: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // 正确性（error）
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-constant-binary-expression': 'error',
      // 卫生（warn，存量多，增量不再新增）
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'prefer-const': 'warn',
      'no-var': 'error',
      // 关闭/降级与现有代码习惯冲突的噪声项
      'no-empty': 'off',                 // catch {} 兜底是刻意设计
      'no-control-regex': 'off',
      'no-async-promise-executor': 'off',
      'no-useless-assignment': 'off',    // `let x = 兜底; try { x = ... }` 防御性初始化是仓库惯用法
      'preserve-caught-error': 'off',    // 重抛不带 cause 属存量风格，增量代码建议带上
      'no-useless-escape': 'warn',
    },
  },
];
