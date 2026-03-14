/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./client/index.html', './client/src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: 'var(--card)',
        'card-foreground': 'var(--card-foreground)',
        muted: 'var(--surface-2)',
        'muted-foreground': 'var(--muted)',
        border: 'var(--border)',
        input: 'var(--input)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
      },
      borderRadius: {
        lg: '0.875rem',
        md: '0.625rem',
        sm: '0.5rem',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(0,0,0,0.05), 0 6px 24px rgba(21,34,27,0.08)',
      },
      fontFamily: {
        sans: ['Space Grotesk', 'Manrope', 'Avenir Next', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
