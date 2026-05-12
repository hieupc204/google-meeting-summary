/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#4F46E5',
          light: '#EEF2FF',
          dark: '#3730A3',
        },
        cyan: { DEFAULT: '#06B6D4' },
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#EF4444',
        pause: '#8B5CF6',
        surface: '#FFFFFF',
        bg: '#F8FAFC',
      },
      borderRadius: { DEFAULT: '10px' },
      boxShadow: {
        soft: '0 4px 16px rgba(0,0,0,0.08)',
      },
    },
  },
  plugins: [],
};
