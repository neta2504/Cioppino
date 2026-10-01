/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // warm linen — sun-bleached old seafood-shack tablecloth
        cream: '#F5ECDA',
        // ciop-* is the primary brand scale: ocean blue, light → deep
        ciop: {
          50:  '#EAF4F8',
          100: '#CFE6EE',
          200: '#A8D2DF',
          300: '#74B5C9',
          400: '#3F95B0',
          500: '#1E7898', // primary ocean
          600: '#155F7B',
          700: '#0E4961',
          800: '#093247',
          900: '#051F2E',
        },
        // accents
        saffron: '#F2A65A',  // sunset coral / lemon zest
        coral:   '#F47B5C',  // tomato of the sea — accent
        basil:   '#2FA388',  // seafoam green (kept the name to avoid churn)
        brass:   '#C8A45C',  // patinated brass for retro accents
        seafoam: '#7DC9B7',
        // text
        espresso: '#0F2A3A', // deep navy-slate (still very readable on cream)
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
        display: ['Georgia', '"Times New Roman"', 'serif'],
      },
      boxShadow: {
        soft:  '0 4px 18px -8px rgba(15, 42, 58, 0.18)',
        glow:  '0 0 0 1px rgba(30, 120, 152, 0.22), 0 10px 30px -10px rgba(30, 120, 152, 0.45)',
        brass: '0 0 0 1px rgba(200, 164, 92, 0.5), 0 6px 18px -8px rgba(200, 164, 92, 0.4)',
      },
      backgroundImage: {
        'cioppino-grad':
          'linear-gradient(135deg, #EAF4F8 0%, #CFE6EE 45%, #A8D2DF 100%)',
        'cioppino-warm':
          'radial-gradient(1200px 420px at 0% 0%, rgba(242, 166, 90, 0.30), transparent), radial-gradient(900px 420px at 100% 0%, rgba(30, 120, 152, 0.28), transparent)',
        // a faint wave pattern (encoded SVG)
        'waves':
          'url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%27160%27 height=%2740%27 viewBox=%270 0 160 40%27><path d=%27M0 20 Q 20 5 40 20 T 80 20 T 120 20 T 160 20%27 fill=%27none%27 stroke=%27%231E7898%27 stroke-opacity=%270.10%27 stroke-width=%271.5%27/></svg>")',
        // tiny diagonal stripes — bistro tablecloth feel
        'stripe':
          'repeating-linear-gradient(135deg, rgba(242,166,90,0.22) 0 8px, transparent 8px 16px)',
      },
      animation: {
        steam: 'steam 4s ease-in-out infinite',
        bob:   'bob 6s ease-in-out infinite',
      },
      keyframes: {
        steam: {
          '0%':   { transform: 'translateY(0) scale(1)',   opacity: '0.45' },
          '50%':  { transform: 'translateY(-10px) scale(1.05)', opacity: '0.25' },
          '100%': { transform: 'translateY(-20px) scale(1.1)',  opacity: '0' },
        },
        bob: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%':      { transform: 'translateY(-3px)' },
        },
      },
    },
  },
  plugins: [],
};
