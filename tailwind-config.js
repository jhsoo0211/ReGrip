/* ReGrip — Tailwind CDN config (unified across all pages)
 * This is the union of every per-page inline `tailwind.config` block.
 * Must be loaded AFTER the Tailwind CDN <script> so the CDN can read it.
 */
tailwind.config = {
  theme: {
    extend: {
      colors: {
        primary: '#5E86B8',
        'primary-container': '#B9D7EA',
        'on-primary': '#ffffff',
        'on-primary-container': '#2A4A6F',
        surface: '#F7FBFC',
        'surface-warm': '#EFF6FB',
        'surface-container': '#D6E6F2',
        'surface-container-high': '#C9DEEF',
        'surface-container-highest': '#B9D7EA',
        'on-surface': '#12263A',
        'on-surface-variant': '#3F5A75',
        'outline-variant': '#B9D7EA',
        'background-sky': '#F7FBFC',
        'ink-black': '#12263A',
        secondary: '#006c49',
        'secondary-container': '#6cf8bb',
        'mint-green': '#10B981',
        'cool-gray': '#64748B',
      },
      fontFamily: { display: ['Pretendard Variable','Noto Sans KR','sans-serif'], body: ['Pretendard Variable','Noto Sans KR','sans-serif'] },
      boxShadow: { retro: '0 8px 32px rgba(42,74,111,0.12)', 'retro-sm': '0 4px 16px rgba(42,74,111,0.10)' },
    },
  },
};
