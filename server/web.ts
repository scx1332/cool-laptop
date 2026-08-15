/**
 * Serves the built frontend.
 *
 * From source that is web/dist on disk. The compiled executable has no such
 * directory, so the build bakes those files into a generated module and they
 * are served from memory — that is what makes the binary a single file rather
 * than a file plus a folder that must travel with it.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.ts';

type EmbeddedFile = { type: string; b64: string };

let embedded: Record<string, EmbeddedFile> = {};
try {
  embedded = (await import('./generated/web-assets.ts')).files;
} catch {
  // Not generated yet: only the on-disk path is available. Normal when running
  // from source.
}

const DIST = resolve(config.root, 'web', 'dist');
const decoded = new Map<string, ArrayBuffer>();

export const haveEmbeddedWeb = Object.keys(embedded).length > 0;

function fromEmbedded(rel: string): Response | null {
  const file = embedded[rel];
  if (!file) return null;
  let bytes = decoded.get(rel);
  if (!bytes) {
    bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
    decoded.set(rel, bytes);
  }
  return new Response(bytes, { headers: { 'content-type': file.type } });
}

/** Resolves a request path to a static file, falling back to index.html so
 *  client-side routes still load. Null when there is no frontend at all. */
export async function serveWeb(path: string): Promise<Response | null> {
  const rel = path === '/' || path === '' ? 'index.html' : path.replace(/^\/+/, '');

  if (haveEmbeddedWeb) return fromEmbedded(rel) ?? fromEmbedded('index.html');

  if (!existsSync(DIST)) return null;
  // Keep ../ out: the server runs with the user's rights and there is no
  // reason a request should reach anything outside the built frontend.
  const target = resolve(DIST, rel);
  if (!target.startsWith(DIST)) return null;
  const file = Bun.file(target);
  if (await file.exists()) return new Response(file);
  const index = Bun.file(resolve(DIST, 'index.html'));
  return (await index.exists()) ? new Response(index) : null;
}
