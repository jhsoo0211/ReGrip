/* ReGrip — Tailwind CDN config (unified across all pages)
 * This is the union of every per-page inline `tailwind.config` block.
 * Must be loaded AFTER the Tailwind CDN <script> so the CDN can read it.
 */
tailwind.config = {
  theme: {
    extend: {
      colors: {
        primary: '#994626',
        'primary-container': '#e8825e',
        'on-primary': '#ffffff',
        'on-primary-container': '#621e02',
        surface: '#FFF8F6',
        'surface-warm': '#FFF1ED',
        'surface-container': '#FFE9E3',
        'surface-container-high': '#fae3dc',
        'surface-container-highest': '#f5ded7',
        'on-surface': '#251915',
        'on-surface-variant': '#58423a',
        'outline-variant': '#dfc0b6',
        'background-sky': '#F0F9FF',
        'ink-black': '#0F172A',
        secondary: '#006c49',
        'secondary-container': '#6cf8bb',
        'mint-green': '#10B981',
        'cool-gray': '#64748B',
      },
      fontFamily: { display: ['Space Grotesk'], body: ['DM Sans'] },
      boxShadow: { retro: '4px 4px 0px #0F172A', 'retro-sm': '2px 2px 0px #0F172A' },
    },
  },
};
