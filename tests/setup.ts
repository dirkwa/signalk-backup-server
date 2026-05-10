/**
 * Global test setup for Vitest
 */

import { beforeAll, afterAll, vi } from 'vitest';

// Mock environment variables for tests
beforeAll(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('KEEPER_BYPASS_AUTH', 'true');
  vi.stubEnv('PODMAN_SOCKET', '/var/run/test.sock');
});

afterAll(() => {
  vi.unstubAllEnvs();
});
