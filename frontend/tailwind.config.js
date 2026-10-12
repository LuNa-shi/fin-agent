export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0f172a',
        sub: '#475569',
        line: '#e2e8f0',
        panel: '#ffffff',
        bg: '#f6f8fb',
        brand: '#1e5eff',
        up: '#e5443b',   // 中国市场：涨=红
        down: '#12a45f', // 跌=绿
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
