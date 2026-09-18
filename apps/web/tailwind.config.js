/** Colours are aliases of the tokens in `src/index.css`, so the palette lives in one place. */
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
