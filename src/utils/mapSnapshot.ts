/**
 * Canvas-based map snapshot generator.
 * Draws map tiles (for online maps) or uploaded images onto a canvas,
 * then draws a pin marker. Returns a base64 JPEG string.
 * Works without Leaflet — uses raw tile math + Image loading.
 */

import type { InspectionMap, MapPin } from '../types';

export async function generateMapSnapshot(
  map: InspectionMap,
  pin?: MapPin,
  width = 480,
  height = 320
): Promise<string | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const isImage = (map.type === 'uploaded' || map.type === 'company') && !!map.imageData;

    if (isImage) {
      await renderImageMap(ctx, map.imageData, pin, width, height);
    } else {
      const lat = pin?.lat ?? map.centerLat ?? 0;
      const lng = pin?.lng ?? map.centerLng ?? 0;
      const zoom = map.zoom ?? 15;
      // Use type field — 'google' provider uses Esri satellite tiles; others use OSM
      const isEsri = map.type === 'online' && (map.url?.includes('maps.google') ?? false);
      if (lat === 0 && lng === 0 && !pin) {
        // No valid coordinates — draw placeholder
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#9ca3af';
        ctx.font = '14px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Map preview not available (no coordinates)', width / 2, height / 2);
        return canvas.toDataURL('image/jpeg', 0.85);
      }
      await renderTileMap(ctx, lat, lng, zoom, isEsri, pin, width, height);
    }

    // Subtle border
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, width, height);

    return canvas.toDataURL('image/jpeg', 0.8);
  } catch (err) {
    console.error('Map snapshot generation failed:', err);
    return null;
  }
}

/* ── Render uploaded/company image map ── */
async function renderImageMap(
  ctx: CanvasRenderingContext2D,
  imageData: string,
  pin: MapPin | undefined,
  width: number,
  height: number
) {
  return new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(0, 0, width, height);
      const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = (width - dw) / 2;
      const dy = (height - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);
      if (pin) {
        const px = dx + (pin.x / 100) * dw;
        const py = dy + (pin.y / 100) * dh;
        drawPinMarker(ctx, px, py, pin.color, pin.label);
      }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = imageData;
  });
}

/* ── Render online map using tiles ── */
async function renderTileMap(
  ctx: CanvasRenderingContext2D,
  lat: number,
  lng: number,
  zoom: number,
  isEsri: boolean,
  pin: MapPin | undefined,
  width: number,
  height: number
) {
  ctx.fillStyle = '#e5e7eb';
  ctx.fillRect(0, 0, width, height);

  const tileSize = 256;
  const n = Math.pow(2, zoom);
  const latRad = lat * Math.PI / 180;

  // World pixel coordinates of the center
  const worldX = ((lng + 180) / 360) * n * tileSize;
  const worldY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * tileSize;

  const halfW = width / 2;
  const halfH = height / 2;

  // Which tiles are visible
  const startTileX = Math.floor((worldX - halfW) / tileSize);
  const endTileX = Math.floor((worldX + halfW) / tileSize);
  const startTileY = Math.floor((worldY - halfH) / tileSize);
  const endTileY = Math.floor((worldY + halfH) / tileSize);

  const promises: Promise<void>[] = [];

  for (let ty = startTileY; ty <= endTileY; ty++) {
    for (let tx = startTileX; tx <= endTileX; tx++) {
      if (ty < 0 || ty >= n) continue;
      const wrappedTx = ((tx % n) + n) % n;
      const canvasX = tx * tileSize - worldX + halfW;
      const canvasY = ty * tileSize - worldY + halfH;

      const tileUrl = isEsri
        ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${wrappedTx}`
        : `https://tile.openstreetmap.org/${zoom}/${wrappedTx}/${ty}.png`;

      promises.push(
        new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { ctx.drawImage(img, canvasX, canvasY, tileSize, tileSize); resolve(); };
          img.onerror = () => {
            ctx.fillStyle = '#d1d5db';
            ctx.fillRect(canvasX, canvasY, tileSize, tileSize);
            ctx.strokeStyle = '#e5e7eb';
            ctx.strokeRect(canvasX, canvasY, tileSize, tileSize);
            resolve();
          };
          img.src = tileUrl;
        })
      );
    }
  }

  await Promise.all(promises);

  // Attribution text
  ctx.font = '10px Arial, sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.textAlign = 'right';
  ctx.fillText(isEsri ? '© Esri' : '© OpenStreetMap', width - 6, height - 6);

  // Draw pin at center
  if (pin) {
    drawPinMarker(ctx, halfW, halfH, pin.color, pin.label);
  }
}

/**
 * BUG FIX (Craig-reported): exported/downloaded inspection reports showed
 * "Access blocked — Referer is required by tile usage policy of
 * OpenStreetMap's volunteer-run servers" in place of every GPS map, but only
 * in Firefox — Chrome opened the same file fine. Root cause, confirmed
 * against OSM's own documentation: a report opened as a local `file://`
 * document has genuinely no HTTP referrer to send — there is no code-level
 * fix for this (Chrome happens to be more lenient here; that's a Chrome
 * quirk, not something to rely on). OSM's own suggested fix for this exact
 * situation is to pre-render a static map image instead of embedding a live,
 * tile-fetching map in a document that might later be opened offline or
 * without a referrer.
 *
 * This mirrors generateMapSnapshot() above (which already solves this for
 * the single map+pin snapshots saved on inspections) but supports an
 * arbitrary number of points with an auto-fitted bounding box, for the
 * report's per-photo GPS maps and its multi-point GPS overview map. Called
 * from Reports.tsx *while the live app is open* (a real https:// page, so
 * OpenStreetMap's tiles load normally) — the result is a plain embedded
 * <img>, so the exported report never makes a single network request when
 * opened later, in any browser, online or off.
 */
export async function generateMultiPointGpsMap(
  points: { lat: number; lng: number; label?: string; icon?: string }[],
  width = 640,
  height = 360
): Promise<string | null> {
  try {
    if (points.length === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, 0, width, height);

    const tileSize = 256;
    const lats = points.map(p => p.lat);
    const lngs = points.map(p => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;

    // Pick the highest zoom (0–18) at which the full point spread still fits
    // in the canvas, with padding — single-point sets fall straight to 16.
    const lat2y = (lat: number, z: number) => {
      const r = lat * Math.PI / 180;
      return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z) * tileSize;
    };
    const lng2x = (lng: number, z: number) => (lng + 180) / 360 * Math.pow(2, z) * tileSize;

    const padding = 60; // px, keeps pins/labels off the edge
    let zoom = 16;
    if (points.length > 1) {
      for (let z = 18; z >= 2; z--) {
        const spanX = lng2x(maxLng, z) - lng2x(minLng, z);
        const spanY = lat2y(minLat, z) - lat2y(maxLat, z); // y is inverted
        if (spanX <= width - padding * 2 && spanY <= height - padding * 2) { zoom = z; break; }
        zoom = z; // if nothing fits (huge spread), settle for the lowest zoom tried
      }
    }

    const n = Math.pow(2, zoom);
    const worldX = lng2x(centerLng, zoom);
    const worldY = lat2y(centerLat, zoom);
    const halfW = width / 2, halfH = height / 2;
    const startTileX = Math.floor((worldX - halfW) / tileSize);
    const endTileX = Math.floor((worldX + halfW) / tileSize);
    const startTileY = Math.floor((worldY - halfH) / tileSize);
    const endTileY = Math.floor((worldY + halfH) / tileSize);

    const loads: Promise<void>[] = [];
    for (let ty = startTileY; ty <= endTileY; ty++) {
      for (let tx = startTileX; tx <= endTileX; tx++) {
        if (ty < 0 || ty >= n) continue;
        const wrappedTx = ((tx % n) + n) % n;
        const canvasX = tx * tileSize - worldX + halfW;
        const canvasY = ty * tileSize - worldY + halfH;
        const tileUrl = `https://tile.openstreetmap.org/${zoom}/${wrappedTx}/${ty}.png`;
        loads.push(new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { ctx.drawImage(img, canvasX, canvasY, tileSize, tileSize); resolve(); };
          img.onerror = () => {
            ctx.fillStyle = '#d1d5db';
            ctx.fillRect(canvasX, canvasY, tileSize, tileSize);
            resolve();
          };
          img.src = tileUrl;
        }));
      }
    }
    await Promise.all(loads);

    ctx.font = '10px Arial, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.textAlign = 'right';
    ctx.fillText('© OpenStreetMap', width - 6, height - 6);

    // Project each point to canvas coordinates and draw its pin.
    // Only label points when there aren't so many they'd overlap into mush.
    const showLabels = points.length <= 12;
    points.forEach((p) => {
      const px = lng2x(p.lng, zoom) - worldX + halfW;
      const py = lat2y(p.lat, zoom) - worldY + halfH;
      drawPinMarker(ctx, px, py, '#4f46e5', showLabels ? (p.label || '') : '');
    });

    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, width, height);

    return canvas.toDataURL('image/jpeg', 0.82);
  } catch (err) {
    console.error('Multi-point GPS map generation failed:', err);
    return null;
  }
}

/* ── Pin marker drawing ── */
function drawPinMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  label: string
) {
  ctx.save();

  // Shadow
  ctx.beginPath();
  ctx.ellipse(x, y + 3, 10, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fill();

  // Pin teardrop shape
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - 15, y - 18, x - 15, y - 38, x, y - 38);
  ctx.bezierCurveTo(x + 15, y - 38, x + 15, y - 18, x, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Inner dot
  ctx.beginPath();
  ctx.arc(x, y - 25, 6, 0, Math.PI * 2);
  ctx.fillStyle = 'white';
  ctx.fill();

  // Label
  if (label) {
    ctx.font = 'bold 11px Arial, sans-serif';
    ctx.textAlign = 'center';
    const metrics = ctx.measureText(label);
    const tw = metrics.width + 12;
    const th = 20;
    const lx = x - tw / 2;
    const ly = y - 58;

    // Background pill
    ctx.fillStyle = 'rgba(30,30,30,0.85)';
    ctx.beginPath();
    const r = 5;
    ctx.moveTo(lx + r, ly);
    ctx.lineTo(lx + tw - r, ly);
    ctx.quadraticCurveTo(lx + tw, ly, lx + tw, ly + r);
    ctx.lineTo(lx + tw, ly + th - r);
    ctx.quadraticCurveTo(lx + tw, ly + th, lx + tw - r, ly + th);
    ctx.lineTo(lx + r, ly + th);
    ctx.quadraticCurveTo(lx, ly + th, lx, ly + th - r);
    ctx.lineTo(lx, ly + r);
    ctx.quadraticCurveTo(lx, ly, lx + r, ly);
    ctx.closePath();
    ctx.fill();

    // Arrow pointing down
    ctx.beginPath();
    ctx.moveTo(x - 5, ly + th);
    ctx.lineTo(x, ly + th + 5);
    ctx.lineTo(x + 5, ly + th);
    ctx.closePath();
    ctx.fill();

    // Text
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, ly + th / 2);
  }

  ctx.restore();
}
