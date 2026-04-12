/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        discord: '#5865F2',
        surface: '#1a1a24',
        background: '#0f0f13',
        textPrimary: '#ffffff',
        textSecondary: '#8e8ea0',
      }
    },
  },
  plugins: [],
}
