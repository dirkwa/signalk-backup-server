// WHY end-to-end http: catches header/writer-shape regressions a pure unit test would miss.
// fetch() here is intentional (vs httpFetch in src/): tests run on the CI runner where native
// fetch works, and they need ReadableStream getReader() for SSE — httpFetch buffers the full body.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';

vi.mock('../../../src/services/logger.js', () => {
  const fakeLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fakeLogger,
  };
  return { logger: fakeLogger };
});

vi.mock('../../../src/config/index.js', () => ({
  config: {
    dataDir: '/tmp/sk-events-test-data',
    signalkDataPath: '/tmp/sk-events-test-signalk',
    maxUploadSize: 1024,
    kopiaBinaryPath: '/usr/local/bin/kopia',
    kopiaRepoPath: '/tmp/sk-events-test-repo',
    kopiaConfigPath: '/tmp/sk-events-test-kopia.config',
  },
}));

vi.mock('../../../src/services/backup-service.js', () => ({
  backupService: { getBackup: vi.fn() },
}));
vi.mock('../../../src/services/backup-scheduler.js', () => ({
  backupScheduler: {},
}));
vi.mock('../../../src/services/cloud-sync-service.js', () => ({
  cloudSyncService: {},
}));
vi.mock('../../../src/services/settings-service.js', () => ({
  settingsService: {},
}));
vi.mock('../../../src/services/restore-service.js', () => ({
  restoreService: { isRestoring: () => false, getProgress: () => null, reset: vi.fn() },
}));
vi.mock('../../../src/services/restore-partial-service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/services/restore-partial-service.js')
  >('../../../src/services/restore-partial-service.js');
  return {
    ...actual,
    restorePartialService: {
      getProgress: () => null,
      reset: vi.fn(),
      describeExistingTarget: vi.fn(),
      restorePartial: vi.fn(),
      isRestoring: () => false,
    },
  };
});

const { backupRouter } = await import('../../../src/api/backup-routes.js');
const { setRoutePrefixByTag, generateOpenApiDocument } = await import(
  '../../../src/api/openapi-registry.js'
);
const { backupEvents } = await import('../../../src/services/backup-events.js');
import type { BackupCompletedEventType } from '../../../src/schemas/events.js';

let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use('/api/backups', backupRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}/api/backups/events/stream`;
});

afterAll(() => {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// WHY clean per-test: prior-test connections may not have unwound their close handler yet.
beforeEach(() => {
  backupEvents.removeAllListeners('backup-completed');
});

async function waitForListenerCount(target: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (backupEvents.listenerCount('backup-completed') !== target) {
    if (Date.now() > deadline) {
      throw new Error(
        `listener count never reached ${target} (still ${backupEvents.listenerCount('backup-completed')})`
      );
    }
    await new Promise((r) => setImmediate(r));
  }
}

describe('GET /api/backups/events/stream', () => {
  it('streams a backup-completed event after subscription', async () => {
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First read should at least include the `: connected` keepalive
    // so we know the route handler has subscribed before we emit.
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain(': connected');

    // Emit and pull the next chunk.
    const event: BackupCompletedEventType = {
      type: 'backup-completed',
      tier: 'hourly',
      timestamp: '2026-05-21T12:00:00.000Z',
      localResult: 'success',
      localBytes: 1234,
      backupId: 'snap-abc',
      freeBytes: 1000,
      totalBytes: 2000,
      nextScheduled: {
        hourly: '2026-05-21T13:00:00.000Z',
        daily: '2026-05-22T00:00:00.000Z',
        weekly: '2026-05-24T00:00:00.000Z',
      },
    };
    backupEvents.emit('backup-completed', event);

    // Read until we see a `data:` line.
    let payload = '';
    while (!payload.includes('data:')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('stream closed before data arrived');
      payload += decoder.decode(chunk.value);
    }

    const dataLine = payload.split('\n').find((l) => l.startsWith('data:'))!;
    const json = JSON.parse(dataLine.slice('data:'.length).trim());
    expect(json).toEqual(event);

    controller.abort();
  }, 5_000);

  it('removes its listener on client disconnect', async () => {
    const before = backupEvents.listenerCount('backup-completed');

    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    // Drain the first chunk — guarantees the route handler has reached
    // the listener-registration line, since `: connected` is written before
    // `backupEvents.on(...)`.
    const reader = res.body!.getReader();
    await reader.read();
    expect(backupEvents.listenerCount('backup-completed')).toBe(before + 1);

    controller.abort();
    await waitForListenerCount(before);
    expect(backupEvents.listenerCount('backup-completed')).toBe(before);
  });

  it('registers /events/stream in the OpenAPI document', () => {
    expect(backupRouter).toBeDefined();
    setRoutePrefixByTag('Backups', '/api/backups');
    const doc = generateOpenApiDocument() as {
      paths: Record<string, Record<string, { summary?: string }>>;
    };
    expect(doc.paths['/api/backups/events/stream']?.get?.summary).toBeDefined();
  });
});
