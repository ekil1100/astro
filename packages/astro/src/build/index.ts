import type { AstroConfig, BuildOptions } from '../@types/astro';

import fs from 'fs';
import vite from 'vite';
import { fileURLToPath } from 'url';
import ssr from '../ssr/index.js';
import { buildURLMap } from '../ssr/util.js';
import astroPlugin from '../ssr/vite_astro.js';
import { ASTRO_RUNTIME_DEPS, CJS_MODULES, ES_MODULES } from '../ssr/modules.js';
import { getUserDeps } from '../util.js';
import { warn } from '../logger.js';

type ReturnCode = number;

const FRONTEND_DIR = new URL('../frontend/hydrate/', import.meta.url);

/** `astro build` */
export default async function build(config: AstroConfig, options: BuildOptions): Promise<ReturnCode> {
  let urlMap = await buildURLMap(config.pages);
  const port = config.devOptions.port;
  if (!config.buildOptions.site) {
    warn(options.logging, 'config', `Set "buildOptions.site" to generate correct canonical URLs and sitemap`);
  }
  let origin = config.buildOptions.site ? new URL(config.buildOptions.site).origin : `http://localhost:${port}`;
  const entries: Record<string, string> = {};
  const outDir = new URL(config.dist.replace(/^\//, './').replace(/\/?$/, '/'), config.projectRoot);

  // create server
  const viteConfig: vite.InlineConfig & { ssr?: { external?: string[]; noExternal?: string[] } } = {
    mode: 'production',
    logLevel: 'error',
    optimizeDeps: {
      entries: ['**/*'],
      include: [...ASTRO_RUNTIME_DEPS],
    },
    plugins: [
      astroPlugin({
        astroConfig: config,
        logging: options.logging,
        mode: 'development',
      }),
    ],
    publicDir: fileURLToPath(config.public),
    root: fileURLToPath(config.projectRoot),
    server: {
      middlewareMode: 'ssr',
    },
    ssr: {
      external: [...CJS_MODULES],
      noExternal: [...ES_MODULES, ...(await getUserDeps(config.projectRoot))],
    },
  };
  const viteServer = await vite.createServer(viteConfig);

  // write static pages to disk
  await Promise.all(
    [...urlMap.staticPages.entries()].map(async ([k, v]) => {
      if (!k.endsWith('.html')) return; // urlMap contains many duplicate aliases; only build full paths with file extensions
      const html = await ssr({ logging: options.logging, reqURL: k, origin, urlMap, viteServer });
      const filePath = new URL(k.replace(/^\//, './'), outDir);
      await fs.promises.writeFile(filePath, html, 'utf8');
      const entryID = k === '/index.html' ? 'index' : k.replace(/^\//, '').replace(/\/index\.html$/, '');
      entries[entryID] = fileURLToPath(filePath);
    })
  );

  // write collections to disk

  vite.build({
    build: {
      outDir: config.dist,
      rollupOptions: {
        input: entries,
        output: {
          assetFileNames: 'assets/[name]-[hash][extname]',
          chunkFileNames: 'chunks/[name]-[hash].js',
          entryFileNames: '[name].js',
          format: 'esm',
          inlineDynamicImports: true,
        },
      },
      ssr: true,
      target: 'es2018',
    },
    optimizeDeps: viteConfig.optimizeDeps,
    plugins: viteConfig.plugins,
  });

  return 0;
}
