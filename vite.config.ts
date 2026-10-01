import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function normalizeBasePath(value: string | undefined): string {
  const trimmedValue = value?.trim();
  if (!trimmedValue || trimmedValue === '/') {
    return '/';
  }

  return `/${trimmedValue.replace(/^\/+|\/+$/g, '')}/`;
}

export default defineConfig({
  base: normalizeBasePath(process.env.VITE_BASE_PATH),
  plugins: [react(), tailwindcss()],
  // Keep the PDF.js API and worker on the same live module graph in dev. A
  // long-running Vite optimizer can otherwise retain an older pre-bundled API
  // while the worker URL resolves from a newly installed pdfjs-dist package.
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  resolve: {
    dedupe: ['pdfjs-dist'],
  },
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/pdfjs-dist/')) return 'pdfjs';
          if (id.includes('node_modules/jszip/')) return 'zip';
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/')
          )
            return 'react';
          return undefined;
        },
      },
    },
  },
});
