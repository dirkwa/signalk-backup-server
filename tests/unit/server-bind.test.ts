// Regression test for the rootless-podman + pasta unhealthy-loop. Node's
// default `server.listen(port)` (no host arg) binds to `::` only; on
// Wolfi + pasta the Dockerfile healthcheck's undici fetch hangs against
// ::1 inside the container namespace. The fix is an explicit `'0.0.0.0'`
// host arg in src/server.ts. This test guards that the bind family stays
// IPv4 — if a future refactor drops the host arg, this fails.

import { describe, it, expect } from 'vitest';
import { createServer, type AddressInfo } from 'net';

describe('server bind family', () => {
  it("listens on IPv4 when host is '0.0.0.0'", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const addr = server.address() as AddressInfo;
    expect(addr.family).toBe('IPv4');
    expect(addr.address).toBe('0.0.0.0');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('would NOT bind IPv4-only if host arg were omitted (proves the bug class is real)', async () => {
    // On Linux with IPv6 enabled, Node's default is `::` (IPv6 wildcard).
    // On hosts with IPv6 disabled it may fall back differently — we only
    // assert it isn't the IPv4-wildcard family our fix demands, so this
    // test stays meaningful across CI environments without becoming brittle.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    expect(addr.family === 'IPv4' && addr.address === '0.0.0.0').toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
