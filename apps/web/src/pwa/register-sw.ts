/**
 * Registers the service worker that vite-plugin-pwa generates at build time
 * (dist/sw.js): it caches the app shell so the app opens instantly and offline,
 * and makes it installable. API calls always go to the network.
 */
export function registerServiceWorker(navigator: Navigator, url = '/sw.js'): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register(url, { scope: '/' }).catch((error: unknown) => {
    console.warn('Offline support is not available:', error);
  });
}
