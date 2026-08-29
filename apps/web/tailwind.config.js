/** Кольори — псевдоніми токенів з `src/index.css`, щоб палітра жила в одному місці. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        ground: 'var(--ground)',
        panel: 'var(--panel)',
        ink: 'var(--ink)',
        'ink-muted': 'var(--ink-muted)',
        hairline: 'var(--hairline)',
        refuse: 'var(--refuse)',
      },
    },
  },
}
