// Shared lock check for full + partial restores. Route handlers and
// services consult this before starting a restore so a partial restore
// cannot run while a full is active and vice versa. Registration pattern
// avoids a circular import between restore-service and
// restore-partial-service.

type IsActiveProbe = () => boolean;

const probes: IsActiveProbe[] = [];

export function registerRestoreActiveProbe(probe: IsActiveProbe): void {
  probes.push(probe);
}

export function isAnyRestoreActive(): boolean {
  return probes.some((p) => p());
}
