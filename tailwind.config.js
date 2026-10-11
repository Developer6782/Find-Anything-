/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        void: {
          900: '#05060a',
          850: '#080a11',
          800: '#0b0e16',
          700: '#11141f',
          600: '#171b28',
        },
        cyan: {
          400: '#22e0ff',
          500: '#00c8ef',
        },
        violet: {
          400: '#a78bfa',
          500: '#8b5cf6',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Inter',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(34,224,255,0.18), 0 0 40px -12px rgba(34,224,255,0.45)',
        'glow-violet': '0 0 0 1px rgba(167,139,250,0.2), 0 0 44px -12px rgba(139,92,246,0.5)',
        panel: '0 24px 60px -30px rgba(0,0,0,0.9)',
      },
      keyframes: {
        scan: {
          '0%': { transform: 'translateY(-8%)', opacity: '0' },
          '12%': { opacity: '0.9' },
          '88%': { opacity: '0.9' },
          '100%': { transform: 'translateY(108%)', opacity: '0' },
        },
        floaty: {
          '0%,100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        pulseRing: {
          '0%': { transform: 'scale(0.9)', opacity: '0.55' },
          '70%': { transform: 'scale(1.35)', opacity: '0' },
          '100%': { transform: 'scale(1.35)', opacity: '0' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-300% 0' },
          '100%': { backgroundPosition: '300% 0' },
        },
        riseIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        blink: {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.25' },
        },
      },
      animation: {
        scan: 'scan 3.4s ease-in-out infinite',
        floaty: 'floaty 6s ease-in-out infinite',
        'pulse-ring': 'pulseRing 2.4s ease-out infinite',
        shimmer: 'shimmer 2.2s linear infinite',
        'rise-in': 'riseIn 0.45s cubic-bezier(0.22,1,0.36,1) both',
        blink: 'blink 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
