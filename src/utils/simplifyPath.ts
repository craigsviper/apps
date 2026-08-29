// v73.37 — Craig confirmed the app-wide lag from v73.34–v73.36 traces back
// (in part) to real-road-routed segments carrying far more coordinate points
// than they need to. buildLocalRoadGraph() (server.js) keys a graph node on
// EVERY vertex of every OSM way, not just true intersections, so a routed
// detour returned by /api/roads/connect includes every survey vertex along
// the road — many of them nearly collinear and adding no visible shape.
// Nothing thinned that before it was spliced into a job's `segments`, so
// routed segments could be substantially larger than they needed to be.
//
// This is a standard Douglas-Peucker simplifier, done in local equirectangular
// meters (not raw lng/lat degrees) so a single tolerance value means the same
// real-world distance regardless of latitude — a fixed degree-tolerance would
// be too loose near the equator and too tight near the poles.
export interface LatLng { lat: number; lng: number; }

function toLocalXY(points: LatLng[]): { x: number; y: number }[] {
  const lat0 = points[0].lat;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return points.map(p => ({ x: (p.lng - points[0].lng) * mPerDegLng, y: (p.lat - lat0) * mPerDegLat }));
}

function perpendicularDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // Distance from p to the infinite line through a-b (not clamped to the
  // segment) — standard for Douglas-Peucker, where a/b are always the
  // current segment's own endpoints.
  const num = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x);
  return num / Math.sqrt(lenSq);
}

function douglasPeucker(xy: { x: number; y: number }[], toleranceMetres: number): boolean[] {
  const keep = new Array(xy.length).fill(false);
  keep[0] = true;
  keep[xy.length - 1] = true;
  const stack: [number, number][] = [[0, xy.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end <= start + 1) continue;
    let maxDist = -1, maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(xy[i], xy[start], xy[end]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > toleranceMetres) {
      keep[maxIdx] = true;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return keep;
}

// Simplifies a lat/lng polyline, always preserving the first and last points
// exactly (callers rely on endpoints staying put — e.g. detour splicing
// assumes index 0 and index length-1 are still the original snap points).
// Tolerance is in metres; points closer to the line between their
// neighbours than this are dropped. Returns the input unchanged if it has
// fewer than 3 points (nothing to simplify).
export function simplifyPath(points: LatLng[], toleranceMetres = 1.5): LatLng[] {
  if (points.length < 3) return points;
  const xy = toLocalXY(points);
  const keep = douglasPeucker(xy, toleranceMetres);
  return points.filter((_, i) => keep[i]);
}
