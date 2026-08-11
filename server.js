// quick-replay static file server.
//
// Zero dependencies: only node:http, node:fs, node:path, node:url.
// Serves public/ over http://127.0.0.1:<port> and never sees any audio —
// capture and replay happen entirely in the browser page.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_MAX_SECONDS = 300;
const DEFAULT_PORT = 8080;
const MAX_SECONDS_LIMIT = 1800; // ~346MB of 48kHz mono Float32 audio.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const PLACEHOLDER = '__MAX_LOOKBACK_SECONDS__';

/**
 * Parse CLI args into { max, port }. Pure function — throws on invalid
 * input instead of exiting, so it can be unit tested directly.
 *
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @returns {{ max: number, port: number }}
 */
export function parseArgs(argv) {
  let max = DEFAULT_MAX_SECONDS;
  let port = DEFAULT_PORT;

  const KNOWN_FLAGS = new Set(['--max', '--port']);

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];

    if (!KNOWN_FLAGS.has(flag)) {
      throw new Error(`Unknown flag: ${flag}`);
    }

    const rawValue = argv[i + 1];
    if (rawValue === undefined || KNOWN_FLAGS.has(rawValue)) {
      throw new Error(`Flag ${flag} requires a value`);
    }
    i++; // consume the value

    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Flag ${flag} requires a positive finite number, got: ${rawValue}`);
    }

    if (flag === '--max') {
      if (value > MAX_SECONDS_LIMIT) {
        throw new Error(
          `--max ${value} exceeds the maximum allowed value of ${MAX_SECONDS_LIMIT} seconds ` +
          `(1800s of 48kHz mono Float32 audio is already ~346MB of memory).`
        );
      }
      max = value;
    } else if (flag === '--port') {
      // Bound this here rather than letting listen() throw a raw RangeError.
      if (!Number.isInteger(value) || value > 65535) {
        throw new Error(`--port must be an integer between 1 and 65535, got: ${rawValue}`);
      }
      port = value;
    }
  }

  return { max, port };
}

/**
 * Map a filename (or path) to a Content-Type header value based on its
 * extension. `.js` MUST map to `text/javascript` — browsers reject ES
 * module <script type="module"> and AudioWorklet.addModule() otherwise.
 *
 * @param {string} filename
 * @returns {string}
 */
export function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.js':
      return 'text/javascript';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css';
    case '.json':
      return 'application/json';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function formatMinSec(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function sendText(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function createRequestHandler(max) {
  return function handleRequest(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed');
      return;
    }

    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      sendText(res, 400, 'Bad Request');
      return;
    }

    const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const resolved = path.resolve(PUBLIC_DIR, relativePath);
    const publicRoot = PUBLIC_DIR + path.sep;

    // Path traversal guard: resolved path must stay inside PUBLIC_DIR.
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(publicRoot)) {
      sendText(res, 403, 'Forbidden');
      return;
    }

    fs.readFile(resolved, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          sendText(res, 404, 'Not Found');
        } else if (err.code === 'EISDIR') {
          sendText(res, 404, 'Not Found');
        } else {
          sendText(res, 500, 'Internal Server Error');
        }
        return;
      }

      const contentType = contentTypeFor(resolved);
      let body = data;

      if (path.basename(resolved) === 'index.html') {
        body = Buffer.from(data.toString('utf8').split(PLACEHOLDER).join(String(max)));
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
    });
  };
}

function main() {
  let max;
  let port;
  try {
    ({ max, port } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error('Usage: node server.js [--max <seconds>] [--port <n>]');
    process.exit(1);
    return;
  }

  const server = http.createServer(createRequestHandler(max));

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Error: port ${port} is already in use. Try a different port with --port <n>.`);
      process.exit(1);
    } else {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const bufferBytes = max * 48000 * 4;
    const bufferMB = (bufferBytes / (1024 * 1024)).toFixed(1);
    console.log(`quick-replay listening at http://127.0.0.1:${port}`);
    console.log(`Max lookback: ${max}s (${formatMinSec(max)})`);
    console.log(`Estimated buffer size: ~${bufferMB} MB (48kHz mono Float32)`);
  });
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
