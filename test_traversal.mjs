// Standalone reimplementation of the v73.112 traversal algorithm (spine +
// branch/turnaround-return), mirroring SweepJobs.tsx's logic exactly, to
// verify it against Craig's specific complaint: T1/T2 creation order must
// NOT determine servicing order — graph topology (distance along the A->B
// spine) must.

function haversine(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function key(p) { return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`; }

function buildGraph(features) {
  const nodes = new Map(), edges = new Map();
  let c = 0;
  const ensure = p => { const k = key(p); if (!nodes.has(k)) nodes.set(k, { key: k, lat: p.lat, lng: p.lng, edgeIds: [] }); return k; };
  for (const f of features) {
    for (let i = 0; i < f.coords.length - 1; i++) {
      const a = { lng: f.coords[i][0], lat: f.coords[i][1] };
      const b = { lng: f.coords[i+1][0], lat: f.coords[i+1][1] };
      const ak = ensure(a), bk = ensure(b);
      if (ak === bk) continue;
      const id = `e${c++}`;
      edges.set(id, { id, aKey: ak, bKey: bk, dist: haversine(a,b), roadName: f.name });
      nodes.get(ak).edgeIds.push(id); nodes.get(bk).edgeIds.push(id);
    }
  }
  return { nodes, edges };
}
function nearestNode(graph, p) {
  let best = null, bd = Infinity;
  for (const n of graph.nodes.values()) { const d = haversine(p, n); if (d < bd) { bd = d; best = n.key; } }
  return best;
}
function dijkstraPath(graph, fromKey, toKey) {
  const dist = new Map([[fromKey, 0]]), prevN = new Map(), prevE = new Map(), visited = new Set();
  while (true) {
    let u = null, ud = Infinity;
    for (const [k,d] of dist) if (!visited.has(k) && d < ud) { ud = d; u = k; }
    if (u === null || u === toKey) break;
    visited.add(u);
    for (const eid of graph.nodes.get(u).edgeIds) {
      const e = graph.edges.get(eid);
      const v = e.aKey === u ? e.bKey : e.aKey;
      const nd = ud + e.dist;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prevN.set(v, u); prevE.set(v, eid); }
    }
  }
  if (!dist.has(toKey)) return null;
  const edgeIds = [];
  let cur = toKey;
  while (cur !== fromKey) { const eid = prevE.get(cur); if (!eid) return null; edgeIds.push(eid); cur = prevN.get(cur); }
  edgeIds.reverse();
  return { edgeIds };
}
function dijkstraDistances(graph, fromKey) {
  const dist = new Map([[fromKey, 0]]), visited = new Set();
  while (true) {
    let u = null, ud = Infinity;
    for (const [k,d] of dist) if (!visited.has(k) && d < ud) { ud = d; u = k; }
    if (u === null) break;
    visited.add(u);
    for (const eid of graph.nodes.get(u).edgeIds) {
      const e = graph.edges.get(eid);
      const v = e.aKey === u ? e.bKey : e.aKey;
      const nd = ud + e.dist;
      if (nd < (dist.get(v) ?? Infinity)) dist.set(v, nd);
    }
  }
  return dist;
}
// v73.118 — computeArticulationPoints + the cut-vertex branch inside
// traverseLoopCoverage below now mirror SweepJobs.tsx exactly (see that
// file's own v73.118 comment for the full rationale): a turnaround that
// sits on the ONLY connection through to a whole section (a true graph
// cut vertex, e.g. Craig's T1) still gets its mandatory stop-and-reverse,
// but isn't permanently blocked the way an optional-detour turnaround
// (e.g. T3, not a cut vertex) still correctly is.
function computeArticulationPoints(graph) {
  const disc = new Map(), low = new Map(), result = new Set(), visited = new Set();
  let timer = 0;
  for (const rootKey of graph.nodes.keys()) {
    if (visited.has(rootKey)) continue;
    visited.add(rootKey); disc.set(rootKey, timer); low.set(rootKey, timer); timer++;
    const stack = [{ nodeKey: rootKey, parentKey: null, parentEdgeId: null, edgeIdx: 0, childCount: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const node = graph.nodes.get(top.nodeKey);
      if (top.edgeIdx < node.edgeIds.length) {
        const eid = node.edgeIds[top.edgeIdx]; top.edgeIdx++;
        if (eid === top.parentEdgeId) continue;
        const e = graph.edges.get(eid);
        const to = e.aKey === top.nodeKey ? e.bKey : e.aKey;
        if (!visited.has(to)) {
          visited.add(to); disc.set(to, timer); low.set(to, timer); timer++;
          top.childCount++;
          stack.push({ nodeKey: to, parentKey: top.nodeKey, parentEdgeId: eid, edgeIdx: 0, childCount: 0 });
        } else {
          low.set(top.nodeKey, Math.min(low.get(top.nodeKey), disc.get(to)));
        }
      } else {
        stack.pop();
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          low.set(parent.nodeKey, Math.min(low.get(parent.nodeKey), low.get(top.nodeKey)));
          if (parent.parentKey === null) { if (parent.childCount > 1) result.add(parent.nodeKey); }
          else if (low.get(top.nodeKey) >= disc.get(parent.nodeKey)) result.add(parent.nodeKey);
        }
      }
    }
  }
  return result;
}
function traverseLoopCoverage(graph, startKey, turnaroundNodeKeys) {
  const articulationPoints = computeArticulationPoints(graph);
  const edgeUseCounts = new Map(), steps = [];
  const visitedEdges = new Set();
  const record = (eid, from, to, reason) => {
    const e = graph.edges.get(eid);
    steps.push({ edgeId: eid, from, to, reason, roadName: e.roadName, lengthM: e.dist });
    edgeUseCounts.set(eid, (edgeUseCounts.get(eid) ?? 0) + 1);
  };
  const stack = [{ nodeKey: startKey, edgeIdx: 0, enteredViaEdge: null, reversedAtCutVertex: false }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const node = graph.nodes.get(top.nodeKey);
    const mustReverseHere = top.enteredViaEdge !== null && turnaroundNodeKeys.has(top.nodeKey);
    const isCutVertexTurnaround = mustReverseHere && articulationPoints.has(top.nodeKey);
    if (isCutVertexTurnaround && !top.reversedAtCutVertex) {
      const enteredEdge = top.enteredViaEdge;
      const parent = stack[stack.length - 2];
      record(enteredEdge, top.nodeKey, parent.nodeKey, 'turnaround-return');
      record(enteredEdge, parent.nodeKey, top.nodeKey, 'turnaround-return');
      top.reversedAtCutVertex = true;
    }
    const blockFurtherEdges = mustReverseHere && !isCutVertexTurnaround;
    let descended = false;
    if (!blockFurtherEdges) {
      while (top.edgeIdx < node.edgeIds.length) {
        const eid = node.edgeIds[top.edgeIdx];
        top.edgeIdx++;
        if (visitedEdges.has(eid)) continue;
        visitedEdges.add(eid);
        const e = graph.edges.get(eid);
        const to = e.aKey === top.nodeKey ? e.bKey : e.aKey;
        record(eid, top.nodeKey, to, stack.length === 1 ? 'main-spine' : 'branch-out');
        stack.push({ nodeKey: to, edgeIdx: 0, enteredViaEdge: eid, reversedAtCutVertex: false });
        descended = true;
        break;
      }
    }
    if (!descended) {
      stack.pop();
      if (top.enteredViaEdge !== null && stack.length > 0) {
        const parent = stack[stack.length - 1];
        record(top.enteredViaEdge, top.nodeKey, parent.nodeKey, 'turnaround-return');
      }
    }
  }
  const totalM = steps.reduce((s,x)=>s+x.lengthM,0);
  return { steps, edgeUseCounts, branchOrder: [], totalM };
}
function traverse(graph, start, waypointsInOrder, end) {
  const startKey = nearestNode(graph, start), endKey = nearestNode(graph, end);
  if (startKey === endKey) {
    const turnaroundNodeKeys = new Set();
    for (const wp of waypointsInOrder) { const k = nearestNode(graph, wp); if (k) turnaroundNodeKeys.add(k); }
    return traverseLoopCoverage(graph, startKey, turnaroundNodeKeys);
  }
  const spine = dijkstraPath(graph, startKey, endKey);
  if (!spine) return null;
  const spineNodeKeys = [startKey];
  { let at = startKey; for (const eid of spine.edgeIds) { const e = graph.edges.get(eid); at = e.aKey===at?e.bKey:e.aKey; spineNodeKeys.push(at); } }
  const spineIndexOf = new Map(); spineNodeKeys.forEach((k,i) => { if (!spineIndexOf.has(k)) spineIndexOf.set(k,i); });
  const branchesByEntry = new Map();
  for (const wp of waypointsInOrder) {
    const tKey = nearestNode(graph, wp);
    if (!tKey || spineIndexOf.has(tKey)) continue;
    const distFromT = dijkstraDistances(graph, tKey);
    let bestKey = null, bestDist = Infinity;
    for (const sk of spineIndexOf.keys()) { const d = distFromT.get(sk); if (d !== undefined && d < bestDist) { bestDist = d; bestKey = sk; } }
    if (bestKey === null) continue;
    const outbound = dijkstraPath(graph, bestKey, tKey);
    if (!outbound || outbound.edgeIds.length === 0) continue;
    const list = branchesByEntry.get(bestKey) ?? [];
    list.push({ entryKey: bestKey, outEdgeIds: outbound.edgeIds, label: wp.label });
    branchesByEntry.set(bestKey, list);
  }
  const steps = [];
  const edgeUseCounts = new Map();
  const record = (eid, from, to, reason) => {
    const e = graph.edges.get(eid);
    steps.push({ edgeId: eid, from, to, reason, roadName: e.roadName, lengthM: e.dist });
    edgeUseCounts.set(eid, (edgeUseCounts.get(eid) ?? 0) + 1);
  };
  const branchOrder = [];
  for (let i = 0; i < spineNodeKeys.length; i++) {
    const nodeKey = spineNodeKeys[i];
    for (const br of branchesByEntry.get(nodeKey) ?? []) {
      branchOrder.push(br.label);
      let at = nodeKey;
      for (const eid of br.outEdgeIds) { const e = graph.edges.get(eid); const to = e.aKey===at?e.bKey:e.aKey; record(eid, at, to, 'branch-out'); at = to; }
      for (let j = br.outEdgeIds.length - 1; j >= 0; j--) { const eid = br.outEdgeIds[j]; const e = graph.edges.get(eid); const to = e.aKey===at?e.bKey:e.aKey; record(eid, at, to, 'turnaround-return'); at = to; }
    }
    if (i < spineNodeKeys.length - 1) { const eid = spine.edgeIds[i]; const e = graph.edges.get(eid); const to = e.aKey===nodeKey?e.bKey:e.aKey; record(eid, nodeKey, to, 'main-spine'); }
  }
  const totalM = steps.reduce((s,x)=>s+x.lengthM,0);
  return { steps, edgeUseCounts, branchOrder, totalM };
}

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log(`OK   ${name}`); } else { fail++; console.log(`FAIL ${name}`); } }

// --- Test 1: T-creation-order independence ---
// A --J1--J2--B, with J1 having a branch to T2 (left, created SECOND) and
// J2 having a branch to T1 (right, created FIRST). Correct service order
// must be J1's branch (T2) first, since J1 comes first along the spine —
// regardless of T1 being created before T2.
{
  const A = {lat:0,lng:0}, J1 = {lat:0,lng:1}, J2 = {lat:0,lng:2}, B = {lat:0,lng:3};
  const T1 = {lat:1,lng:2}; // right branch off J2, created FIRST
  const T2 = {lat:-1,lng:1}; // left branch off J1, created SECOND
  const features = [
    { name: 'Spine A-J1', coords: [[A.lng,A.lat],[J1.lng,J1.lat]] },
    { name: 'Spine J1-J2', coords: [[J1.lng,J1.lat],[J2.lng,J2.lat]] },
    { name: 'Spine J2-B', coords: [[J2.lng,J2.lat],[B.lng,B.lat]] },
    { name: 'Branch J2-T1', coords: [[J2.lng,J2.lat],[T1.lng,T1.lat]] },
    { name: 'Branch J1-T2', coords: [[J1.lng,J1.lat],[T2.lng,T2.lat]] },
  ];
  const graph = buildGraph(features);
  // waypointsInOrder = creation order: T1 (right) first, T2 (left) second
  const result = traverse(graph, A, [{...T1, label:'T1'}, {...T2, label:'T2'}], B);
  check('T-order: J1 branch (T2) serviced before J2 branch (T1), despite T1 created first',
    result.branchOrder[0] === 'T2' && result.branchOrder[1] === 'T1');
}

// --- Test 2: turnaround return doesn't get pushed onto an alternate loop ---
// J --e1--e2-- T, no alternate path exists. Return must be the exact
// reverse (e2 then e1), not some detour (there is none here, but this also
// checks e1/e2 both get used exactly twice: once out, once back).
{
  const A = {lat:0,lng:0}, J = {lat:0,lng:1}, M = {lat:0,lng:2}, T = {lat:0,lng:3}, B = {lat:0,lng:4};
  const features = [
    { name: 'A-J', coords: [[A.lng,A.lat],[J.lng,J.lat]] },
    { name: 'J-B', coords: [[J.lng,J.lat],[B.lng,B.lat]] },
    { name: 'J-M', coords: [[J.lng,J.lat],[M.lng,M.lat]] },
    { name: 'M-T', coords: [[M.lng,M.lat],[T.lng,T.lat]] },
  ];
  const graph = buildGraph(features);
  const result = traverse(graph, A, [{...T, label:'T'}], B);
  const branchSteps = result.steps.filter(s => s.reason !== 'main-spine');
  const branchCounts = branchSteps.reduce((m,s) => (m.set(s.edgeId,(m.get(s.edgeId)??0)+1),m), new Map());
  check('dead-end branch: both branch edges (J-M, M-T) used exactly twice (out+return)', [...branchCounts.values()].every(c => c === 2) && branchCounts.size === 2);
  const spineSteps = result.steps.filter(s => s.reason === 'main-spine');
  check('dead-end branch: spine edges (A-J, J-B) used exactly once each, no extra retracing', spineSteps.length === 2);
  const reasons = branchSteps.map(s => s.reason);
  check('dead-end branch: reasons are branch-out,branch-out,turnaround-return,turnaround-return in order', reasons.join(',') === 'branch-out,branch-out,turnaround-return,turnaround-return');
}

// --- Test 3: loop with alternate path — no unnecessary repeat ---
// A simple 4-edge loop from J1 to J2, no turnarounds: main spine only,
// each edge used exactly once.
{
  const A = {lat:0,lng:0}, J1 = {lat:0,lng:1}, J2 = {lat:0,lng:2}, B = {lat:0,lng:3};
  const Ltop = {lat:0.5,lng:1.5};
  const features = [
    { name: 'A-J1', coords: [[A.lng,A.lat],[J1.lng,J1.lat]] },
    { name: 'J1-J2 direct', coords: [[J1.lng,J1.lat],[J2.lng,J2.lat]] },
    { name: 'J1-Ltop', coords: [[J1.lng,J1.lat],[Ltop.lng,Ltop.lat]] },
    { name: 'Ltop-J2', coords: [[Ltop.lng,Ltop.lat],[J2.lng,J2.lat]] },
    { name: 'J2-B', coords: [[J2.lng,J2.lat],[B.lng,B.lat]] },
  ];
  const graph = buildGraph(features);
  const result = traverse(graph, A, [], B);
  const counts = [...result.edgeUseCounts.values()];
  check('no turnarounds: every spine edge used exactly once', counts.every(c => c === 1));
}

// --- Test 4: closed loop (A=B), multiple turnarounds sharing an approach ---
// This reproduces Craig's real regression: A===B (loop route), 3 turnarounds
// all hanging off the far end of the same shared road (T1,T2,T3 all past a
// long shared stretch), plus one turnaround on a separate branch. Old
// spine-shortest-path(A,A) collapsed to zero edges, so each turnaround
// independently re-walked the whole shared stretch. Full DFS coverage
// should walk every edge exactly twice (there+back) — no matter how many
// turnarounds/dead-ends hang off it.
{
  const A = {lat:0,lng:0}, J1 = {lat:0,lng:1}, J2 = {lat:0,lng:2};
  const shared1 = {lat:0,lng:3}, shared2 = {lat:0,lng:4}, deadEnd = {lat:0,lng:5};
  const otherBranch = {lat:1,lng:1};
  const features = [
    { name: 'A-J1', coords: [[A.lng,A.lat],[J1.lng,J1.lat]] },
    { name: 'J1-J2', coords: [[J1.lng,J1.lat],[J2.lng,J2.lat]] },
    { name: 'J1-otherBranch', coords: [[J1.lng,J1.lat],[otherBranch.lng,otherBranch.lat]] },
    { name: 'J2-shared1', coords: [[J2.lng,J2.lat],[shared1.lng,shared1.lat]] },
    { name: 'shared1-shared2', coords: [[shared1.lng,shared1.lat],[shared2.lng,shared2.lat]] },
    { name: 'shared2-deadEnd', coords: [[shared2.lng,shared2.lat],[deadEnd.lng,deadEnd.lat]] },
    { name: 'J2-A loop-close', coords: [[J2.lng,J2.lat],[A.lng,A.lat]] }, // closes the loop back to A
  ];
  const graph = buildGraph(features);
  // 3 "turnarounds" all effectively pointing at/near the same dead end —
  // in the old bug each of these independently re-walked J2->shared1->shared2.
  const result = traverse(graph, A, [
    {...deadEnd, label:'T1'}, {...deadEnd, label:'T2'}, {...otherBranch, label:'T3'}
  ], A);
  const countsByEdgeName = new Map();
  for (const s of result.steps) countsByEdgeName.set(s.roadName, (countsByEdgeName.get(s.roadName)??0)+1);
  check('loop coverage: shared1-shared2 edge used exactly twice, not repeated per turnaround', countsByEdgeName.get('shared1-shared2') === 2);
  check('loop coverage: shared2-deadEnd edge used exactly twice', countsByEdgeName.get('shared2-deadEnd') === 2);
  check('loop coverage: loop-closing edge traversed at most twice (bounded — see note below, not the reported bug)', countsByEdgeName.get('J2-A loop-close') <= 2);
  const totalM = result.totalM;
  check('loop coverage: total distance is sane (not 3x-4x inflated)', totalM < 2_000_000); // sanity ceiling, real check is per-edge counts above
}

// --- Test 5: mandatory turnaround at a CONNECTED junction (not a dead end) ---
// Craig's real T3 case: Moa Crescent meets Weka Street at a real, driveable
// junction (Weka Street continues on to a loop-closing node C). A turnaround
// marker at that junction must still force an immediate stop-and-reverse
// back onto Moa Crescent — never flow straight through onto Weka Street —
// even though continuing is topologically available. Weka Street's onward
// stretch must still get swept, just reached from the OTHER side (via C).
{
  const A = {lat:0,lng:0}; // also the loop's B (A=B closed loop)
  const J = {lat:0,lng:1}; // junction where Moa Crescent branches off the main loop
  const moaEnd = {lat:1,lng:1}; // Moa Crescent's dead end
  const T3junction = {lat:0,lng:2}; // the T3 junction itself — Moa Crescent meets Weka Street here
  const C = {lat:0,lng:3}; // Weka Street's far end, closing the loop back to A
  const features = [
    { name: 'A-J (main loop)', coords: [[A.lng,A.lat],[J.lng,J.lat]] },
    { name: 'J-MoaCrescent', coords: [[J.lng,J.lat],[moaEnd.lng,moaEnd.lat]] },
    { name: 'J-T3junction (Moa continuing to the junction)', coords: [[J.lng,J.lat],[T3junction.lng,T3junction.lat]] },
    { name: 'T3junction-WekaStreet', coords: [[T3junction.lng,T3junction.lat],[C.lng,C.lat]] },
    { name: 'C-A (closes loop)', coords: [[C.lng,C.lat],[A.lng,A.lat]] },
  ];
  const graph = buildGraph(features);
  const result = traverse(graph, A, [{...T3junction, label:'T3'}], A);
  // The step arriving AT T3junction must be immediately followed by a
  // turnaround-return over the SAME edge — never a branch-out onto Weka
  // Street from that visit.
  const arrivalIdx = result.steps.findIndex(s => s.to === '0.00000,2.00000');
  check('T3: an arrival step at the turnaround junction exists', arrivalIdx !== -1);
  const arrival = result.steps[arrivalIdx];
  const nextStep = result.steps[arrivalIdx + 1];
  check('T3: the step immediately after arrival reverses over the exact same edge (mandatory turnaround, not flow-through)',
    nextStep && nextStep.edgeId === arrival.edgeId && nextStep.reason === 'turnaround-return' && nextStep.from === arrival.to && nextStep.to === arrival.from);
  // Weka Street onward (T3junction -> C) must still get swept — just from
  // the other side, not as a direct continuation out of T3 on this visit.
  const wekaCount = result.steps.filter(s => s.roadName === 'T3junction-WekaStreet').length;
  check('T3: Weka Street beyond the junction is still swept (reached from the other side), not skipped entirely', wekaCount === 2);
}

// --- Test 6: mandatory turnaround at a CUT VERTEX (v73.117's own bug,
// fixed in v73.118) --- Craig's exact regression: T1 sits on the road that
// is the ONLY connection through to T2's whole section — a true cut
// vertex, not a spur like T3. v73.117's unconditional "block every other
// edge at a turnaround" rule silently dropped that whole section (75
// selected edges in, only 59 points out). It must now still get a
// mandatory stop-and-reverse at T1, but T2's section must still be swept.
{
  const A = {lat:0,lng:0}; // also B (closed loop)
  const loopL1 = {lat:1,lng:0}, loopL2 = {lat:1,lng:1}; // an unrelated loop back to A, so A itself isn't a dead end
  const T1 = {lat:0,lng:1}; // sits on the ONLY road through to T2's whole section
  const M = {lat:0,lng:2};  // mid-point of that section
  const T2 = {lat:0,lng:3}; // a genuine dead end, only reachable via T1
  const features = [
    { name: 'A-T1 (approach)', coords: [[A.lng,A.lat],[T1.lng,T1.lat]] },
    { name: 'T1-M (section road)', coords: [[T1.lng,T1.lat],[M.lng,M.lat]] },
    { name: 'M-T2 (section road)', coords: [[M.lng,M.lat],[T2.lng,T2.lat]] },
    { name: 'A-loopL1', coords: [[A.lng,A.lat],[loopL1.lng,loopL1.lat]] },
    { name: 'loopL1-loopL2', coords: [[loopL1.lng,loopL1.lat],[loopL2.lng,loopL2.lat]] },
    { name: 'loopL2-A', coords: [[loopL2.lng,loopL2.lat],[A.lng,A.lat]] },
  ];
  const graph = buildGraph(features);
  const result = traverse(graph, A, [{...T1, label:'T1'}, {...T2, label:'T2'}], A);
  const countsByEdgeName = new Map();
  for (const s of result.steps) countsByEdgeName.set(s.roadName, (countsByEdgeName.get(s.roadName)??0)+1);
  check('T1 cut vertex: the section beyond T1 (T1-M) is still swept, not silently dropped',
    (countsByEdgeName.get('T1-M (section road)') ?? 0) >= 1);
  check("T1 cut vertex: T2's dead end (M-T2) is still swept, not silently dropped",
    (countsByEdgeName.get('M-T2 (section road)') ?? 0) >= 1);
  // A cycle closing back onto the DFS root naturally backtracks the whole
  // way once it runs out of unvisited edges at the root — same pre-existing,
  // already-accepted "loop-closing edge traversed at most twice" bound
  // Test 4 documents above, unrelated to the cut-vertex fix itself.
  check('T1 cut vertex: the unrelated loop is unaffected by the T1 fix (each edge swept at most twice, same bound as Test 4)',
    countsByEdgeName.get('A-loopL1') <= 2 && countsByEdgeName.get('loopL1-loopL2') <= 2 && countsByEdgeName.get('loopL2-A') <= 2);
  // T1 must still visibly stop-and-reverse on arrival — two consecutive
  // turnaround-return steps over the SAME entry edge, back-and-forth,
  // before continuing on to T1-M.
  const t1ArrivalIdx = result.steps.findIndex(s => s.to === '0.00000,1.00000' && s.reason !== 'turnaround-return');
  check('T1 cut vertex: an arrival step at T1 exists', t1ArrivalIdx !== -1);
  const arrival = result.steps[t1ArrivalIdx];
  const rev1 = result.steps[t1ArrivalIdx + 1];
  const rev2 = result.steps[t1ArrivalIdx + 2];
  check('T1 cut vertex: mandatory stop-and-reverse recorded immediately on arrival (reverse then return over the same edge)',
    rev1 && rev1.edgeId === arrival.edgeId && rev1.reason === 'turnaround-return' &&
    rev2 && rev2.edgeId === arrival.edgeId && rev2.reason === 'turnaround-return');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
