import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Get version: prefer env var (Docker), fallback to package.json (local dev)
function getVersion(): string {
  // Docker builds set VITE_APP_VERSION env var
  if (process.env.VITE_APP_VERSION) {
    return process.env.VITE_APP_VERSION;
  }
  // Local dev: read from parent package.json
  const pkgPath = resolve(__dirname, '../../package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.1';
  }
  return '0.0.1';
}

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler', {}]],
        presets: [['@babel/preset-react', { runtime: 'automatic' }]],
      },
    }),
  ],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(getVersion()),
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Silence Sass deprecation warnings from dependencies in node_modules
        quietDeps: true,
        // Silence @import deprecation warnings - migration to @use/@forward
        // would require restructuring all SCSS files and Bootstrap 5 itself
        // still uses @import internally. Will address when Dart Sass 3.0 is released.
        silenceDeprecations: ['import'],
      },
    },
  },
  // Relative base — emits ./assets/... paths so the UI works whether
  // it's served at the container root (/) for local debugging or via the
  // signalk-backup plugin's reverse proxy at /plugins/signalk-backup/console/.
  // The HashRouter in main.tsx makes this safe: route paths are in the URL
  // hash and never affect asset resolution.
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173, // Vite default - dev server only, not production
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
