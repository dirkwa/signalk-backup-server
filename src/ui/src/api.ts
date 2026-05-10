// The UI is served from the same Express server as the API, but it's
// reachable via two paths:
//   1. Direct (container debugging): http://<host>:3010/ — base is "/"
//   2. Through the signalk-backup plugin's reverse proxy:
//        http://<signalk>:4000/plugins/signalk-backup/console/ — base is
//        "/plugins/signalk-backup/console"
// Detect at module load by scanning the current URL for the marker. This
// keeps the UI agnostic to the deployment model.

function detectApiBase(): string {
  const path = typeof window !== 'undefined' ? window.location.pathname : '';
  const marker = '/console';
  const idx = path.indexOf(marker);
  if (idx !== -1) {
    return path.slice(0, idx + marker.length);
  }
  return '';
}

export const API_BASE = detectApiBase();

export function apiUrl(path: string): string {
  // Caller passes "/api/foo"; we prepend the detected base so it becomes
  // "/api/foo" (direct) or "/plugins/signalk-backup/console/api/foo" (proxied).
  return API_BASE + path;
}
