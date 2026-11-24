import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SHOW_SCHEMAS = ['show-v1.schema.json', 'show-v2.schema.json', 'show-v3.schema.json', 'show-v4.schema.json', 'show-v5.schema.json', 'show-v6.schema.json', 'show-v7.schema.json'] as const;
const schemaDir = new URL('./src/schemas/', import.meta.url);

/**
 * Publish the canonical JSON Schemas from src/schemas/ at the public /schemas/ URL
 * during dev and build without keeping duplicate copies or triggering Vite's public/ import warning.
 */
function showSchemas(): Plugin {
  return {
    name: 'stageforge-show-schemas',
    configureServer(server) {
      const prefix = `${server.config.base.replace(/\/?$/, '/')}schemas/`;
      server.middlewares.use((req, res, next) => {
        const urlPath = req.url?.split('?')[0];
        if (!urlPath || !urlPath.startsWith(prefix)) return next();
        const name = urlPath.slice(prefix.length);
        if (!(SHOW_SCHEMAS as readonly string[]).includes(name)) return next();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(readFileSync(new URL(name, schemaDir)));
      });
    },
    generateBundle() {
      for (const name of SHOW_SCHEMAS) {
        this.emitFile({
          type: 'asset',
          fileName: `schemas/${name}`,
          source: readFileSync(new URL(name, schemaDir)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), showSchemas()],
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    rolldownOptions: {
      output: {
        // three.js core and React change far less often than the app, so they get their own long-lived
        // chunks that stay cached across deploys. three's examples (GLB exporter…) keep loading on demand.
        codeSplitting: {
          groups: [
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/](build|src)[\\/]/, priority: 2 },
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});
