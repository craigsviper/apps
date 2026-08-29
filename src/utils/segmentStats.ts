import type { SweepJobRoad, SweepRoad } from '../types';

// BUG FIX (Craig-reported, v73.9): "segments data used in sweep jobs that are
// created in area & roads map instead of making many roads are not been
// included in all graphs data in the sweep reports."
//
// A road drawn with multiple segments in Areas & Roads (one SweepRoad with
// several RouteSegments — the normal way to represent a long road broken
// into sections, rather than creating a separate SweepRoad per section) gets
// its own per-segment run data (SegmentRunDetail[], in
// `SweepJobRoad.segmentSettings`) once it has more than one segment — see
// `isMultiSeg`/`updateJobRoadSegment` in SweepJobs.tsx (v73.6 fixed that data
// not even auto-saving). The ROAD-level fields on `SweepJobRoad` itself
// (`debrisLevel`, `coverageMethod`, `passCount`, `weather`, `debrisType`)
// are only ever populated for a *single-segment* road — for a multi-segment
// road they stay at their initial/default values, because the UI writes to
// `segmentSettings[]` instead. Every chart/summary that read `road.debrisLevel`
// etc. directly was therefore blind to any multi-segment road's real data.
//
// `getRoadRunEntries()` is the one place this distinction should be handled —
// anything that wants "the debris level(s)/coverage method(s)/etc. recorded
// for this road" should call this instead of reading SweepJobRoad's fields
// directly, so multi-segment roads are never silently excluded again.

export interface RoadRunEntry {
  debrisLevel: string;
  debrisType?: string;
  coverageMethod: SweepJobRoad['coverageMethod'];
  percentSwept?: number;
  passCount: number;
  weather?: string;
  segLabel?: string; // set only when this entry represents one segment of a multi-segment road
}

/** True when a road has real per-segment run data recorded (not just >1 segment defined but never filled in). */
export function hasSegmentRunData(jr: SweepJobRoad, road?: SweepRoad): boolean {
  return !!(road?.segments && road.segments.length > 1 && jr.segmentSettings && jr.segmentSettings.length > 0);
}

/**
 * One entry per segment for a multi-segment road with recorded segment data,
 * or a single entry from the road-level fields otherwise (single-segment
 * roads, or roads created before segments existed — fully backward compatible).
 */
export function getRoadRunEntries(jr: SweepJobRoad, road?: SweepRoad): RoadRunEntry[] {
  if (hasSegmentRunData(jr, road)) {
    return (jr.segmentSettings || []).map(ss => ({
      debrisLevel: ss.debrisLevel || '',
      debrisType: ss.debrisType,
      coverageMethod: ss.coverageMethod,
      percentSwept: ss.percentSwept,
      passCount: ss.passCount || 0,
      weather: ss.weather,
      segLabel: road?.segments?.[ss.segIdx]?.label || `Segment ${ss.segIdx + 1}`,
    }));
  }
  return [{
    debrisLevel: jr.debrisLevel || '',
    debrisType: jr.debrisType,
    coverageMethod: jr.coverageMethod,
    percentSwept: jr.percentSwept,
    passCount: jr.passCount || 0,
    weather: jr.weather,
  }];
}

const coverageLabel = (m: SweepJobRoad['coverageMethod'], pct?: number) =>
  m === 'full' ? 'Full road' : m === 'percent' ? `${pct ?? 0}%` : m === 'ab' ? 'A→B' : m === 'landmark' ? 'Landmark' : m === 'visual' ? 'Visual' : m;

/**
 * Collapses a road's run entries into short display strings for a compact
 * one-line summary (e.g. the Run Details info strip). For a single entry,
 * returns the plain value. For multiple segment entries, lists each distinct
 * value found with a count when more than one distinct value exists, rather
 * than guessing at a "worst"/"most representative" one — debris levels come
 * from an open-ended SW Categories list with no inherent severity ordering
 * to rank by.
 */
export function summariseRunEntries(entries: RoadRunEntry[]) {
  const summarise = (values: string[]) => {
    const present = values.filter(v => v);
    if (present.length === 0) return '—';
    const counts = new Map<string, number>();
    present.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
    if (counts.size === 1) return [...counts.keys()][0];
    return [...counts.entries()].map(([v, n]) => `${v} ×${n}`).join(', ');
  };
  return {
    coverage: summarise(entries.map(e => coverageLabel(e.coverageMethod, e.percentSwept))),
    debris: summarise(entries.map(e => e.debrisLevel)),
    debrisType: summarise(entries.map(e => e.debrisType || '')),
    weather: summarise(entries.map(e => e.weather || '')),
    passCount: entries.length === 1 ? entries[0].passCount : entries.reduce((s, e) => s + e.passCount, 0),
  };
}
