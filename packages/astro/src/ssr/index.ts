import type { ViteDevServer } from 'vite';
import type { LogOptions } from '../logger';

import { fileURLToPath } from 'url';
import loadCollection from './collections.js';
import { canonicalURL, URLMap } from './util.js';

interface SSROptions {
  logging: LogOptions;
  origin: string;
  reqURL: string;
  urlMap: URLMap;
  viteServer: ViteDevServer;
}

/** Transform code for Vite */
function resolveIDs(code: string): string {
  return code.replace(/\/?astro_core:([^\/]+)/g, '/@id/astro_core:$1');
}

/** Use Vite to SSR URL */
export default async function ssr({ logging, reqURL, urlMap, origin, viteServer }: SSROptions): Promise<string> {
  // locate file on disk
  const fullURL = new URL(reqURL, origin);
  const modURL = urlMap.staticPages.get(reqURL) as URL;
  const mod = await viteServer.ssrLoadModule(fileURLToPath(modURL));

  let pageProps = {} as Record<string, any>;

  // load collection, if applicable
  if (mod.collection) {
    const collectionResult = await loadCollection(mod, { logging, reqURL, filePath: modURL });
    pageProps = collectionResult.pageProps;
  }

  const modMeta = await viteServer.moduleGraph.getModuleByUrl(fileURLToPath(modURL));
  const deepImports = new Set<string>();
  async function collectDeepImports(modUrl: string) {
    if (deepImports.has(modUrl)) {
      return;
    }
    deepImports.add(modUrl);
    const depMeta = await viteServer.moduleGraph.getModuleByUrl(modUrl);
    depMeta?.ssrTransformResult?.deps?.forEach(collectDeepImports);
  }
  await Promise.all(modMeta?.ssrTransformResult?.deps?.map(collectDeepImports) || []);
  const deepCssImports = [...deepImports].filter((d) => d.endsWith('.css'));

  // SSR HTML
  let rawHTML: string = await mod.__renderPage({
    request: {
      // params should go here when implemented
      url: fullURL,
      canonicalURL: canonicalURL(fullURL.pathname, fullURL.origin),
    },
    children: [],
    props: pageProps,
    css: mod.css || [],
  });

  // extract hydration code (bug: Vite ruins this for some reason, so we strip it out before Vite can break itself)
  let html = ''; // non-hydration code
  let hydrationCode = ''; // hydration code
  const lines = rawHTML.split('\n');
  while (lines.length) {
    let next = lines.shift();
    if (next === undefined) break; // note: permit empty strings (falsy)!
    if (next.trim() === '<!-- @astro/hydration begin -->') {
      hydrationCode += `${next}\n`;
      while (next.trim() !== '<!-- @astro/hydration end -->') {
        next = lines.shift();
        if (next === undefined) break;
        hydrationCode += `${resolveIDs(next)}\n`;
      }
    } else {
      html += `${next}\n`;
    }
  }

  // prepare template with Vite
  html = await viteServer.transformIndexHtml(reqURL, html);

  // re-inject hydration code
  html = html.replace('</body>', `${hydrationCode}</body>`);

  // inject deeply collected CSS
  html = html.replace('</head>', deepCssImports.map((url) => `  <script type="module" src="${url}"></script>`).join('\n'));

  // finish
  return html;
}
