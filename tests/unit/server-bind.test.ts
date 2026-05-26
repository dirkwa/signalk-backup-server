// Regression: rootless-podman+pasta breaks with Node's default `::` binding (undici hangs on ::1); explicit '0.0.0.0' keeps the healthcheck reachable.
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
