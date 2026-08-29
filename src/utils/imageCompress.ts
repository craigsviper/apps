/**
 * Image compression utility — Critical for field use.
 * Phone cameras produce 3-10MB photos. Without compression,
 * localStorage (5-10MB limit) fills after 1-2 photos = DATA LOSS.
 * This reduces photos to ~100-300KB while maintaining quality.
 */

export function compressImage(
  dataUrl: string,
  maxDimension = 1200,
  quality = 0.65
): Promise<string> {
  return new Promise((resolve) => {
    if (!dataUrl.startsWith('data:image')) {
      resolve(dataUrl);
      return;
    }

    const img = new Image();
    img.onload = () => {
      let { width, height } = img;

      // Only resize if larger than maxDimension
      if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }

      // White background (handles transparent PNGs)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      // Compress to JPEG
      const compressed = canvas.toDataURL('image/jpeg', quality);

      // Only use compressed if actually smaller
      resolve(compressed.length < dataUrl.length ? compressed : dataUrl);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}


/**
 * Format bytes to human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Get current IndexedDB / origin storage usage — sync fallback version.
 * Returns a conservative estimate; call getRealStorageQuota() for actual figures.
 *
 * NOTE: Data is stored in IndexedDB (not localStorage). The "quota" figure below
 * comes from the browser's OWN internal estimate/policy for this origin — it is
 * NOT a live reading of the device's actual free disk space, and can diverge
 * from it significantly (see the v73.141/v73.142 caveat shown in Backup.tsx,
 * added after a real-world case where the browser reported ~112GB "available"
 * while the phone's own file manager showed only ~50GB genuinely free). There
 * is no cross-browser API that exposes a page to the OS's real free-space
 * number directly. See getAndroidRealFreeSpaceBytes() below for the one place
 * this app CAN get a genuinely accurate number — inside the native Android
 * wrapper specifically, via a native bridge.
 */
export function getStorageUsage(): { used: number; total: number; percentage: number } {
  // We can't read IndexedDB synchronously, so return a placeholder while the
  // async getRealStorageQuota() call resolves in the background.
  return { used: 0, total: 1, percentage: 0 };
}

// v73.142 — the Android wrapper (android/app/src/main/java/nz/co/rsw/fieldapp/
// MainActivity.kt) exposes a JS bridge, "AndroidNative", ONLY when this page is
// running inside that native app — not in any browser (Firefox mobile/desktop,
// Chrome, etc), where `window.AndroidNative` simply won't exist. Its
// getRealFreeSpaceBytes() method calls Android's own StatFs API, which reports
// the device's actual current free space on the same partition the phone's own
// Settings > Storage screen reads from — genuinely accurate, unlike the browser
// quota estimate above. Returns null when unavailable (any non-Android context,
// or if the native call itself fails) so callers can cleanly fall back to the
// browser estimate.
declare global {
  interface Window {
    AndroidNative?: { getRealFreeSpaceBytes?: () => number };
  }
}
export function getAndroidRealFreeSpaceBytes(): number | null {
  try {
    const bytes = window.AndroidNative?.getRealFreeSpaceBytes?.();
    return typeof bytes === 'number' && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Get the REAL storage quota from the browser's Storage API.
 *
 * The key difference between Chrome and Firefox:
 *  - Firefox automatically grants persistent storage → full device quota visible
 *  - Chrome defaults to "best-effort" (~10 GB cap) until persist() is explicitly
 *    requested AND the browser grants it. Once granted, Chrome reports a much
 *    larger quota — but this is still the browser's OWN estimate/policy, not a
 *    verified reading of actual free disk space (see the note on getStorageUsage
 *    above — that gap is real and has been observed in practice, not hypothetical).
 *
 * So we MUST:
 *  1. await persist() (not fire-and-forget)
 *  2. Re-run estimate() AFTER persist() resolves, because Chrome only updates
 *     the reported quota once persistence is confirmed.
 */
export async function getRealStorageQuota(): Promise<{
  used: number;
  total: number;
  percentage: number;
  isPersisted: boolean;
  persistGranted: boolean | null; // null = API unavailable
}> {
  let isPersisted   = false;
  let persistGranted: boolean | null = null;

  try {
    if (navigator.storage?.persisted) {
      isPersisted = await navigator.storage.persisted();
    }

    // If not yet persisted, request it — AWAIT the result.
    // Chrome only gives the full large quota once this resolves true.
    if (!isPersisted && navigator.storage?.persist) {
      try {
        persistGranted = await navigator.storage.persist();
        isPersisted = persistGranted;
      } catch {
        persistGranted = false;
      }
    } else if (isPersisted) {
      persistGranted = true;
    }

    if (navigator.storage?.estimate) {
      // Re-run estimate() AFTER persist() so Chrome reports the updated quota
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      if (quota > 0) {
        return {
          used:          usage,
          total:         quota,
          percentage:    Math.min(100, Math.round((usage / quota) * 100)),
          isPersisted,
          persistGranted,
        };
      }
    }
  } catch { /* fall through */ }

  return { used: 0, total: 0, percentage: 0, isPersisted, persistGranted };
}
