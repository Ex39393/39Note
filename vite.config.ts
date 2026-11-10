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

export function isIntentionalSyncPersistenceBoundaryWarning(warning: {
  code?: string;
  message: string;
  plugin?: string;
}): boolean {
  if (warning.code !== 'PLUGIN_WARNING' || warning.plugin !== 'vite:reporter') {
    return false;
  }
  const normalizedMessage = warning.message.replaceAll('\\', '/');
  const importers = normalizedMessage.match(
    /\/src\/services\/annotationPersistence\.ts is dynamically imported by (.+?) but also statically imported by /u,
  )?.[1];
  if (!importers) return false;
  const sourcePaths = importers.split(', ').map((value) => {
    const sourceOffset = value.lastIndexOf('/src/');
    return sourceOffset >= 0 ? value.slice(sourceOffset) : value;
  });
  return (
    sourcePaths.length === 2 &&
    sourcePaths.includes('/src/sync/storage.ts') &&
    sourcePaths.includes('/src/sync/temporaryOAuthStartup.ts')
  );
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
    // The only JavaScript chunk above Vite's default 500 KiB threshold is
    // fontkit, which is loaded only when a Notes appendix needs its bundled
    // Unicode font. Keep an explicit lazy-chunk ceiling while a separate
    // production budget verifies that it never enters the startup graph.
    chunkSizeWarningLimit: 750,
    manifest: true,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        // These two dynamic imports deliberately keep sync storage and the
        // pre-React OAuth gate independently loadable. The full application
        // also imports document persistence statically, so Vite reports that
        // this boundary cannot create another production chunk. Preserve the
        // isolation and allow only this exact, audited warning.
        if (isIntentionalSyncPersistenceBoundaryWarning(warning)) return;
        defaultHandler(warning);
      },
      output: {
        assetFileNames(assetInfo) {
          if (assetInfo.names.includes('eng.traineddata.gz')) {
            return 'assets/ocr/[name][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        },
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
