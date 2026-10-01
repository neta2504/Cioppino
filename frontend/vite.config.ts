import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5174',
    },
  },
  build: {
    outDir: 'dist',
    // Split large vendor libs into their own chunks so:
    //  - recharts (~140KB) only loads on pages that use it
    //  - router/react stay cached across deploys that don't change them
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = id.replaceAll('\\', '/');
          if (moduleId.includes('/node_modules/react/') ||
              moduleId.includes('/node_modules/react-dom/') ||
              moduleId.includes('/node_modules/react-router/') ||
              moduleId.includes('/node_modules/react-router-dom/')) {
            return 'react';
          }
          if (moduleId.includes('/node_modules/recharts/')) return 'recharts';
          if (moduleId.includes('/node_modules/lucide-react/')) return 'icons';
          return undefined;
        },
      },
    },
  },
});
