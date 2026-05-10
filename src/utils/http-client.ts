/**
 * HTTP Client utility using Node.js http/https modules
 *
 * Replaces native fetch() which crashes with SIGILL on ARM64
 * with Wolfi's Node.js 24 build.
 */

import http from 'http';
import https from 'https';

/** HTTP response wrapper */
export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
}

/** HTTP request options */
export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT = 30000;

/**
 * Make HTTP request using http/https modules
 * Drop-in replacement for fetch() that works on ARM64
 */
export function httpFetch(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const reqOptions: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
      timeout: options.timeout || DEFAULT_TIMEOUT,
    };

    // Handle abort signal
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      options.signal.addEventListener('abort', () => {
        req.destroy();
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    }

    const req = httpModule.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;

        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage || '',
          headers: res.headers,
          text: () => Promise.resolve(body),
          json: <T>() => Promise.resolve(JSON.parse(body) as T),
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body && options.method && ['POST', 'PUT', 'PATCH'].includes(options.method)) {
      req.write(options.body);
    }

    req.end();
  });
}

/**
 * AbortSignal.timeout polyfill for environments that don't have it
 */
export function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
