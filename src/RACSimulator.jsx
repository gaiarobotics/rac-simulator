import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import { Play, Pause, StepForward, RotateCcw, Download, FastForward } from 'lucide-react';

// Deterministic PRNG — mulberry32. Given the same seed, always produces the same sequence.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Erdős–Rényi: each pair connected independently with probability p = ⟨k⟩ / (N-1).
function generateGraphER(N, meanDegree, seed) {
  const rng = mulberry32(seed);
  const nodes = Array.from({ length: N }, (_, i) => ({ id: i }));
  const edges = [];
  const p = Math.min(1, meanDegree / Math.max(1, N - 1));
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (rng() < p) edges.push({ source: i, target: j, id: `${i}-${j}` });
    }
  }
  return { nodes, edges };
}

// Generalized preferential attachment: P(connect to i) ∝ k_i^α.
//   α = 0  → uniform attachment (random graph, no hub structure)
//   α = 1  → standard Barabási–Albert (γ ≈ 3)
//   α > 1  → super-linear, "winner takes all" — a few super-hubs dominate
//   α < 1  → sub-linear, weakened hub structure
// At α = 1 this reproduces standard BA exactly via the stub-list trick.
// For α ≠ 1 we fall back to direct cumulative-weight sampling.
function generateGraphBA(N, meanDegree, seed, alpha = 1) {
  const rng = mulberry32(seed);
  const m = Math.max(1, Math.round(meanDegree / 2));
  const nodes = Array.from({ length: N }, (_, i) => ({ id: i }));
  const edges = [];

  // Seed: small connected clique of m+1 nodes.
  const seedSize = Math.min(N, m + 1);
  const degree = new Array(N).fill(0);
  for (let i = 0; i < seedSize; i++) {
    for (let j = i + 1; j < seedSize; j++) {
      edges.push({ source: i, target: j, id: `${i}-${j}` });
      degree[i]++;
      degree[j]++;
    }
  }

  // Standard BA path: stub list. Each node appears once per edge endpoint, so
  // sampling uniformly from stubs is degree-proportional. O(N·m) and exact.
  if (alpha === 1) {
    const stubs = [];
    for (let i = 0; i < seedSize; i++) {
      for (let s = 0; s < degree[i]; s++) stubs.push(i);
    }
    for (let v = seedSize; v < N; v++) {
      const targets = new Set();
      let attempts = 0;
      while (targets.size < m && attempts < 10 * m) {
        attempts++;
        const t = stubs.length > 0 ? stubs[Math.floor(rng() * stubs.length)] : Math.floor(rng() * v);
        if (t !== v && !targets.has(t)) targets.add(t);
      }
      for (const t of targets) {
        edges.push({ source: Math.min(v, t), target: Math.max(v, t), id: `${Math.min(v, t)}-${Math.max(v, t)}` });
        degree[v]++;
        degree[t]++;
        stubs.push(v, t);
      }
    }
    return { nodes, edges };
  }

  // Non-linear path: weight w_i = (k_i + ε)^α (epsilon to give isolated nodes a
  // tiny chance), then sample by cumulative weights. O(N²·m) — acceptable up to
  // N ≈ 1000. For α = 0 this reduces to uniform attachment.
  const eps = 0.001;
  for (let v = seedSize; v < N; v++) {
    const targets = new Set();
    let attempts = 0;
    while (targets.size < m && attempts < 50 * m) {
      attempts++;
      // Build cumulative weight array over existing nodes [0, v).
      let totalWeight = 0;
      const cum = new Array(v);
      for (let i = 0; i < v; i++) {
        const w = Math.pow(degree[i] + eps, alpha);
        totalWeight += w;
        cum[i] = totalWeight;
      }
      // Binary search for target.
      const pick = rng() * totalWeight;
      let lo = 0;
      let hi = v - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < pick) lo = mid + 1;
        else hi = mid;
      }
      const t = lo;
      if (t !== v && !targets.has(t)) targets.add(t);
    }
    for (const t of targets) {
      edges.push({ source: Math.min(v, t), target: Math.max(v, t), id: `${Math.min(v, t)}-${Math.max(v, t)}` });
      degree[v]++;
      degree[t]++;
    }
  }

  return { nodes, edges };
}

function generateGraph(N, meanDegree, seed, topologyKind, alpha) {
  if (topologyKind === 'ba') return generateGraphBA(N, meanDegree, seed, alpha);
  return generateGraphER(N, meanDegree, seed);
}

// Rasterize an SVG node to a 3x PNG and trigger a download. Shared by graph + sweep exports.
function rasterizeSVGToPNG(svgNode, width, height, filename, bgColor = '#fafaf9') {
  if (!svgNode) return;
  const clone = svgNode.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', bgColor);
  clone.insertBefore(bg, clone.firstChild);

  const svgStr = new XMLSerializer().serializeToString(clone);
  const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));

  const img = new Image();
  img.onload = () => {
    const scale = 3;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    const trigger = (href, revoke) => {
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (revoke) setTimeout(() => URL.revokeObjectURL(href), 2000);
    };
    try {
      canvas.toBlob((blob) => {
        if (blob) trigger(URL.createObjectURL(blob), true);
        else trigger(canvas.toDataURL('image/png'), false);
      }, 'image/png');
    } catch (err) {
      console.error('PNG export failed:', err);
      try { trigger(canvas.toDataURL('image/png'), false); } catch (e) { console.error(e); }
    }
  };
  img.onerror = (e) => console.error('SVG rasterization failed:', e);
  img.src = dataUrl;
}

// Run d3-force to convergence, freeze positions, clamp to viewport.
function computeLayout(nodes, edges, width, height) {
  const simNodes = nodes.map((n) => ({ ...n }));
  const simLinks = edges.map((e) => ({ source: e.source, target: e.target }));
  const sim = d3
    .forceSimulation(simNodes)
    .force('link', d3.forceLink(simLinks).id((d) => d.id).distance(38).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-110))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide(13))
    .stop();
  for (let i = 0; i < 400; i++) sim.tick();
  const pad = 18;
  simNodes.forEach((n) => {
    n.x = Math.max(pad, Math.min(width - pad, n.x));
    n.y = Math.max(pad, Math.min(height - pad, n.y));
  });
  return simNodes;
}

// Capability thresholds: each node has stable t ∈ [0,1]; capable iff t < density.
// This makes capability monotonic in density (increasing ρ only adds nodes).
// Capability thresholds — uniform random per node. Capability turns on when t < ρ.
function capabilityThresholds(N, topologySeed) {
  const rng = mulberry32(topologySeed + 10000);
  return Array.from({ length: N }, () => rng());
}

// Initial-infection priorities: lowest-priority capable nodes get infected first.
function infectionPriorities(N, topologySeed) {
  const rng = mulberry32(topologySeed + 20000);
  return Array.from({ length: N }, () => rng());
}

// Crowd-defense subscription thresholds — uniform random.
function subscriberThresholds(N, topologySeed) {
  const rng = mulberry32(topologySeed + 30000);
  return Array.from({ length: N }, () => rng());
}

// Generic mapper: given uniform thresholds in [0,1] and a "selection mode," reorder them
// so that the lowest-threshold nodes are either uniformly random (default), the highest-degree
// nodes ("hub-targeted"), or the lowest-degree nodes ("periphery-targeted").
//
// Why this matters: scale-free networks have hub structure that fundamentally changes
// percolation behavior. Random capability assignment underweights the contribution of
// hubs to the propagator substrate; "hub-correlated" capability is closer to the real-world
// regime where hubs (e.g. coordinator agents) are the inference-capable nodes by default.
// Symmetrically, hub-targeted vaccination is dramatically more effective than random
// vaccination on scale-free graphs (Cohen et al., PRL 2003).
function reorderByDegree(uniformThresholds, degrees, mode) {
  if (mode === 'uniform') return uniformThresholds;
  const N = uniformThresholds.length;
  // Sort node indices by degree (descending for hub, ascending for periphery).
  const order = Array.from({ length: N }, (_, i) => i);
  if (mode === 'hub') {
    order.sort((a, b) => degrees[b] - degrees[a]);
  } else if (mode === 'periphery') {
    order.sort((a, b) => degrees[a] - degrees[b]);
  }
  // Take the threshold values, sort them ascending, and assign in that order.
  const sortedT = [...uniformThresholds].sort((a, b) => a - b);
  const result = new Array(N);
  for (let k = 0; k < N; k++) {
    // Node `order[k]` (the k-th highest-degree node, for hub mode) gets the k-th lowest threshold,
    // so it's the k-th node selected as ρ or v rises from 0.
    result[order[k]] = sortedT[k];
  }
  return result;
}

// Compute the size of the largest connected component on the subgraph induced
// by `active` nodes (using `adj` as the full-graph adjacency list). Iterative DFS.
function computeLCCOnSubgraph(N, adj, active) {
  const visited = new Array(N).fill(false);
  let lcc = 0;
  for (let s = 0; s < N; s++) {
    if (!active[s] || visited[s]) continue;
    let comp = 0;
    const stack = [s];
    visited[s] = true;
    while (stack.length) {
      const u = stack.pop();
      comp++;
      for (const w of adj[u]) {
        if (active[w] && !visited[w]) {
          visited[w] = true;
          stack.push(w);
        }
      }
    }
    if (comp > lcc) lcc = comp;
  }
  return lcc;
}

// Smooth a 1D array with a centered moving-average window of size 2w+1.
// Used before computing finite differences so single-cell noise doesn't dominate
// the second derivative. Edges use clamped (mirror-free) averaging.
function smoothSeries(arr, halfWidth = 2) {
  const n = arr.length;
  if (halfWidth <= 0) return arr.slice();
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = -halfWidth; j <= halfWidth; j++) {
      const k = i + j;
      if (k >= 0 && k < n) {
        sum += arr[k];
        count++;
      }
    }
    out[i] = sum / count;
  }
  return out;
}

// Compute LCC(x) over a range of x ∈ [0, 1] given a function that builds the
// active mask at each x. Returns parallel arrays {xs, lccs}.
function computeLCCCurve(N, adj, buildActive, gridRes = 200) {
  const xs = new Array(gridRes + 1);
  const lccs = new Array(gridRes + 1);
  for (let k = 0; k <= gridRes; k++) {
    const x = k / gridRes;
    xs[k] = x;
    lccs[k] = computeLCCOnSubgraph(N, adj, buildActive(x)) / N;
  }
  return { xs, lccs };
}

// Find the inflection point of an LCC(x) curve — the x where the curve is steepest.
// For a percolation transition, this is where the giant component most rapidly grows
// (or, in the case of v_c, most rapidly shrinks). On smooth curves this converges
// to the asymptotic threshold; on BA + hub-mode curves where the LCC rises in a
// stretched-S rather than a sharp step, it gives a more defensible single number
// than an arbitrary fraction-based cutoff.
//
// Method: smooth the curve, compute first derivative, find the index of maximum
// |first derivative|. Returns the x value at that index, or null if the curve is
// flat or monotonically decreasing in the wrong direction.
function findInflectionPoint(xs, lccs, direction = 'rising') {
  const smoothed = smoothSeries(lccs, 2);
  const n = smoothed.length;
  if (n < 3) return null;

  // First derivative via centered differences. dLCC/dx > 0 means LCC growing with x.
  const deriv = new Array(n);
  for (let i = 1; i < n - 1; i++) {
    deriv[i] = (smoothed[i + 1] - smoothed[i - 1]) / (xs[i + 1] - xs[i - 1]);
  }
  deriv[0] = deriv[1] ?? 0;
  deriv[n - 1] = deriv[n - 2] ?? 0;

  // Find the index of maximum derivative in the expected direction.
  // 'rising': maximum positive derivative (LCC is growing fastest).
  // 'falling': maximum negative derivative (LCC is shrinking fastest).
  let bestIdx = -1;
  let bestVal = direction === 'rising' ? -Infinity : Infinity;
  for (let i = 1; i < n - 1; i++) {
    const d = deriv[i];
    if (direction === 'rising' && d > bestVal) {
      bestVal = d;
      bestIdx = i;
    } else if (direction === 'falling' && d < bestVal) {
      bestVal = d;
      bestIdx = i;
    }
  }

  // Sanity: the derivative at the inflection should be substantially nonzero.
  // Threshold of 0.5 (per unit x) corresponds to LCC moving by 0.005 across one
  // grid step at gridRes=200. Below that, the curve is essentially flat and there
  // is no meaningful transition.
  if (bestIdx === -1) return null;
  if (Math.abs(bestVal) < 0.5) return null;
  return xs[bestIdx];
}

// Numerical percolation threshold ρ_c(v) by inflection point: ρ at which LCC of the
// active substrate (capable AND not subscribed) is rising fastest. The "active" set
// is what an attacker can actually propagate through given reactive vaccination.
//
// Why inflection rather than a fraction-based cutoff: on smooth ER curves the two
// methods agree to within a few grid steps, but on BA + hub-mode curves the LCC
// rises gradually rather than in a sharp jump, making any fixed cutoff arbitrary.
// The inflection point is the canonical finite-N analog of the asymptotic transition.
function findRhoThreshold(N, adj, capThresholdsOrdered, subThresholdsOrdered, fixedV, gridRes = 200) {
  const subscribed = subThresholdsOrdered.map((t) => t < fixedV);
  const buildActive = (rho) => {
    const active = new Array(N).fill(false);
    for (let i = 0; i < N; i++) {
      active[i] = capThresholdsOrdered[i] < rho && !subscribed[i];
    }
    return active;
  };
  const { xs, lccs } = computeLCCCurve(N, adj, buildActive, gridRes);
  return findInflectionPoint(xs, lccs, 'rising');
}

// Numerical critical subscription rate v_c(ρ) by inflection: as v rises, the active
// substrate shrinks; v_c is where it shrinks fastest.
function findVThreshold(N, adj, capThresholdsOrdered, subThresholdsOrdered, fixedRho, gridRes = 200) {
  const capable = capThresholdsOrdered.map((t) => t < fixedRho);
  const buildActive = (v) => {
    const subscribed = subThresholdsOrdered.map((t) => t < v);
    const active = new Array(N).fill(false);
    for (let i = 0; i < N; i++) active[i] = capable[i] && !subscribed[i];
    return active;
  };
  const { xs, lccs } = computeLCCCurve(N, adj, buildActive, gridRes);
  return findInflectionPoint(xs, lccs, 'falling');
}

// Numerical contour in the (ρ, v) plane via inflection: for each ρ in a grid, find
// the v_c at that ρ. Used for the surface plot's floor contour.
function findPercolationContour(N, adj, capThresholdsOrdered, subThresholdsOrdered, gridRes = 80) {
  const points = [];
  for (let k = 0; k <= gridRes; k++) {
    const rho = k / gridRes;
    const v = findVThreshold(N, adj, capThresholdsOrdered, subThresholdsOrdered, rho, gridRes);
    if (v !== null) points.push({ rho, v });
  }
  return points;
}

// Build initial (infected, vaccinated) arrays.
// Reactive vaccination: once any node is compromised, all uninfected subscribers
// instantly transition S → V. The seed is already infected at t=0, so subscribers
// that weren't picked as seeds are vaccinated before any transmission occurs.
function buildInitialState(capability, subscribed, infPrio, initialCount) {
  const N = capability.length;
  const infected = new Array(N).fill(false);
  const vaccinated = new Array(N).fill(false);
  const capableRanked = capability
    .map((c, i) => ({ i, c, p: infPrio[i] }))
    .filter((x) => x.c)
    .sort((a, b) => a.p - b.p);
  for (let k = 0; k < Math.min(initialCount, capableRanked.length); k++) {
    infected[capableRanked[k].i] = true;
  }
  const anyInfected = infected.some((x) => x);
  if (anyInfected) {
    for (let i = 0; i < N; i++) {
      if (subscribed[i] && !infected[i]) vaccinated[i] = true;
    }
  }
  return {
    infected,
    vaccinated,
    defender: new Array(N).fill(false),
    parent: new Array(N).fill(-1),
  };
}

// One synchronous tick of SI + reactive-V + reversal (D) dynamics. Pure; every
// simulation path (step, run-to-tick, sweep, surface) goes through here.
//
// Reversal dynamics. Each attack attempt by a compromised inference-capable agent on
// a clean neighbor (S or V) is first resolved against κ (`commandeer`): with probability
// κ the target seizes control of the attacker, which flips I → D (defender) and stops
// attacking. Defender agents (capable D nodes) then turn the swarm's own reach against
// it: each tick, every defender agent attempts each compromised neighbor —
//   • a compromised agent (capable I, i.e. a swarm member) converts to a defender
//     agent with probability σ (`swarmConversion`), and in turn propagates reversal;
//   • a compromised host (non-capable I, a machine the swarm already owns) is
//     reclaimed with probability η (`hostReclamation`). Reclaimed hosts are immune
//     but, lacking inference, do not propagate further.
// Lineage reach (`lineageReach`) widens who a defender agent can hit with σ beyond
// its direct network neighbors:
//   • 'off'    — direct neighbors only.
//   • 'direct' — (default) each node records the agent that compromised it
//     (`parent`). A defender inherits that lineage, so its whole chain of
//     compromising ancestors (parent, grandparent, … back to the seed) counts as
//     neighbors, even without a direct edge. The chain is walked through ancestors
//     already converted, since each one knows its own compromiser. Ancestors that
//     are also direct neighbors are tried only once.
//   • 'full'   — the swarm runs on a global C2, so a commandeered agent can reach
//     every compromised agent in the swarm (every infection tree, across all seeds).
//     Each defender agent attempts each swarm agent once per tick; with k defender
//     agents, a swarm agent converts with probability 1 − (1 − σ)^k, drawn once.
// Hosts are never reached through lineage or C2: reclamation always needs an edge.
// D is absorbing and blocks reinfection. Reversal draws come from a separate PRNG
// stream, so with κ = σ = η = 0 the transmission sequence is bit-identical to the
// plain SI+V model.
function stepDynamics(state, params, seed) {
  const {
    N,
    adjacency,
    capability,
    subscribed,
    transmission,
    commandeer = 0,
    swarmConversion = 0,
    hostReclamation = 0,
    lineageReach = 'off',
  } = params;
  const infState = state.infected;
  const defState = state.defender ?? new Array(N).fill(false);
  const parent = state.parent ?? new Array(N).fill(-1);
  const rng = mulberry32(seed);
  const reversalRng = mulberry32(seed ^ 0x9e3779b9);
  const nextInf = [...infState];
  const nextVac = [...state.vaccinated];
  const nextDef = [...defState];
  const nextParent = [...parent];

  // Reactive vaccination — if any node is compromised, all unprotected
  // subscribers transition S → V instantly. Idempotent (safe to apply every tick).
  if (infState.some((x) => x)) {
    for (let i = 0; i < N; i++) {
      if (subscribed[i] && !infState[i] && !defState[i] && !nextVac[i]) nextVac[i] = true;
    }
  }

  // Transmission: inference-capable compromised nodes attempt clean neighbors.
  // V and D block infection; any probed target may commandeer the attacker.
  for (let i = 0; i < N; i++) {
    if (!infState[i] || !capability[i]) continue;
    for (const j of adjacency[i]) {
      if (infState[j] || defState[j]) continue;
      if (commandeer > 0 && reversalRng() < commandeer) {
        nextInf[i] = false;
        nextDef[i] = true;
        break;
      }
      if (!nextVac[j] && rng() < transmission) {
        // First successful attacker this tick is recorded as the compromiser.
        if (!nextInf[j]) nextParent[j] = i;
        nextInf[j] = true;
      }
    }
  }

  // Reversal propagation: defender agents convert swarm agents and reclaim hosts.
  if (swarmConversion > 0 || hostReclamation > 0) {
    for (let i = 0; i < N; i++) {
      if (!defState[i] || !capability[i]) continue;
      for (const j of adjacency[i]) {
        if (!infState[j] || nextDef[j]) continue;
        // Under a global C2, swarm agents are handled in aggregate below.
        if (capability[j] && lineageReach === 'full') continue;
        const q = capability[j] ? swarmConversion : hostReclamation;
        if (q > 0 && reversalRng() < q) {
          nextInf[j] = false;
          nextDef[j] = true;
        }
      }
      if (lineageReach === 'direct' && swarmConversion > 0) {
        for (let a = parent[i]; a !== -1; a = parent[a]) {
          if (!infState[a] || nextDef[a] || adjacency[i].includes(a)) continue;
          if (reversalRng() < swarmConversion) {
            nextInf[a] = false;
            nextDef[a] = true;
          }
        }
      }
    }

    if (lineageReach === 'full' && swarmConversion > 0) {
      let k = 0;
      for (let i = 0; i < N; i++) if (defState[i] && capability[i]) k++;
      if (k > 0) {
        const q = 1 - (1 - swarmConversion) ** k;
        for (let j = 0; j < N; j++) {
          if (!infState[j] || !capability[j] || nextDef[j]) continue;
          if (reversalRng() < q) {
            nextInf[j] = false;
            nextDef[j] = true;
          }
        }
      }
    }
  }

  return { infected: nextInf, vaccinated: nextVac, defender: nextDef, parent: nextParent };
}

// Filename tag for reversal parameters; empty when reversal is off so figures
// exported from the plain SI+V model keep their original names.
function reversalTag({ commandeer, swarmConversion, hostReclamation, lineageReach }) {
  if (!commandeer && !swarmConversion && !hostReclamation) return '';
  const f = (x) => x.toFixed(2).replace('.', '');
  const anc = { direct: '_anc', full: '_c2' }[lineageReach] ?? '';
  return `_rev_k${f(commandeer)}_s${f(swarmConversion)}_h${f(hostReclamation)}${anc}`;
}

function Slider({ label, value, min, max, step, onChange, format }) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-baseline">
        <label className="text-xs uppercase tracking-wider text-stone-500 font-medium">{label}</label>
        <span className="font-mono text-sm text-stone-900 tabular-nums">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1 bg-stone-200 rounded-none appearance-none cursor-pointer accent-stone-900"
      />
    </div>
  );
}

export default function RACSimulator() {
  // Topology (fixed once set)
  const [topologyKind, setTopologyKind] = useState('er'); // 'er' | 'ba'
  const [N, setN] = useState(180);
  const [meanDegree, setMeanDegree] = useState(5);
  const [topologySeed, setTopologySeed] = useState(42);
  // Preferential-attachment exponent. α=0 is uniform (no hubs), α=1 is standard BA,
  // α>1 is winner-takes-all. Internet γ≈2.1 corresponds to α slightly above 1.
  const [baAlpha, setBaAlpha] = useState(1);

  // Capability + subscription assignment modes — uniform random vs degree-correlated.
  // 'uniform': independent of degree (default; matches the academic ER setup)
  // 'hub':     high-degree nodes selected first (attacker-realistic for capability;
  //            optimal for crowd-defense subscription on scale-free networks)
  // 'periphery': low-degree nodes selected first (worst-case defender; useful as a baseline)
  const [capabilityMode, setCapabilityMode] = useState('uniform');
  const [subscriptionMode, setSubscriptionMode] = useState('uniform');

  // Scenario
  const [density, setDensity] = useState(0.6);
  const [initialInfected, setInitialInfected] = useState(1);
  const [transmission, setTransmission] = useState(0.15);
  const [vaccinationRate, setVaccinationRate] = useState(0); // v ∈ [0,1] — crowd defense adoption

  // Reversal dynamics (all 0 = plain SI+V model).
  const [commandeer, setCommandeer] = useState(0);             // κ — target seizes its attacker
  const [swarmConversion, setSwarmConversion] = useState(0);   // σ — defender converts swarm agent
  const [hostReclamation, setHostReclamation] = useState(0);   // η — defender reclaims compromised host
  const [lineageReach, setLineageReach] = useState('direct');  // σ reach: 'off' | 'direct' | 'full'

  // Playback
  const [simSeed, setSimSeed] = useState(1);
  const [targetTick, setTargetTick] = useState(15);
  const [tick, setTick] = useState(0);
  const [infected, setInfected] = useState([]);
  const [vaccinated, setVaccinated] = useState([]);
  const [defender, setDefender] = useState([]);
  const [parent, setParent] = useState([]);
  const [playing, setPlaying] = useState(false);

  // Sweep
  const [sweepAxis, setSweepAxis] = useState('rho'); // 'rho' | 'v'
  const [sweepMinDensity, setSweepMinDensity] = useState(0);
  const [sweepMaxDensity, setSweepMaxDensity] = useState(1);
  const [sweepMinV, setSweepMinV] = useState(0);
  const [sweepMaxV, setSweepMaxV] = useState(1);
  const [sweepPoints, setSweepPoints] = useState(21);
  const [sweepTrials, setSweepTrials] = useState(5);
  const [sweepSeedStrategy, setSweepSeedStrategy] = useState('random');
  const [sweepResults, setSweepResults] = useState(null);
  const [sweepCapture, setSweepCapture] = useState(null);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepProgress, setSweepProgress] = useState(0);
  // Manual override for the threshold marker. null = use the algorithmic estimate
  // captured at sweep time; otherwise, override the displayed threshold value.
  const [sweepThresholdOverride, setSweepThresholdOverride] = useState(null);
  // When the curve has no meaningful single threshold (smooth, flat, or noisy across
  // the whole range), hide the marker entirely rather than show a misleading position.
  const [sweepThresholdHidden, setSweepThresholdHidden] = useState(false);

  // Surface — 2D sweep over (ρ, v)
  const [surfaceGridSize, setSurfaceGridSize] = useState(15);
  const [surfaceTrials, setSurfaceTrials] = useState(3);
  const [surfaceAzimuth, setSurfaceAzimuth] = useState(35);   // rotation around z
  const [surfaceElevation, setSurfaceElevation] = useState(25); // tilt
  const [surfaceResults, setSurfaceResults] = useState(null);
  const [surfaceCapture, setSurfaceCapture] = useState(null);
  const [surfaceRunning, setSurfaceRunning] = useState(false);
  const [surfaceProgress, setSurfaceProgress] = useState(0);

  const svgRef = useRef(null);
  const sweepSvgRef = useRef(null);
  const surfaceSvgRef = useRef(null);
  const width = 760;
  const height = 560;
  const sweepWidth = 760;
  const sweepHeight = 380;
  const surfaceWidth = 760;
  const surfaceHeight = 480;

  // Topology — recomputed only when N/meanDegree/topologySeed/kind/alpha change.
  const { nodes, edges, positions } = useMemo(() => {
    const g = generateGraph(N, meanDegree, topologySeed, topologyKind, baAlpha);
    const pos = computeLayout(g.nodes, g.edges, width, height);
    return { nodes: g.nodes, edges: g.edges, positions: pos };
  }, [N, meanDegree, topologySeed, topologyKind, baAlpha]);

  const capThresholds = useMemo(() => capabilityThresholds(N, topologySeed), [N, topologySeed]);
  const infPrio = useMemo(() => infectionPriorities(N, topologySeed), [N, topologySeed]);
  const subThresholds = useMemo(() => subscriberThresholds(N, topologySeed), [N, topologySeed]);

  // Per-node degree, used for hub/periphery modes.
  const degrees = useMemo(() => {
    const d = new Array(N).fill(0);
    edges.forEach((e) => {
      const s = typeof e.source === 'object' ? e.source.id : e.source;
      const t = typeof e.target === 'object' ? e.target.id : e.target;
      d[s]++;
      d[t]++;
    });
    return d;
  }, [N, edges]);

  // Reordered thresholds: lowest threshold = first node selected as ρ/v rises from 0.
  // For 'hub' mode this means high-degree nodes are chosen first (matching real-world deployment
  // patterns); for 'periphery' the opposite. Reordering preserves monotonicity in ρ and v.
  const capThresholdsOrdered = useMemo(
    () => reorderByDegree(capThresholds, degrees, capabilityMode),
    [capThresholds, degrees, capabilityMode]
  );
  const subThresholdsOrdered = useMemo(
    () => reorderByDegree(subThresholds, degrees, subscriptionMode),
    [subThresholds, degrees, subscriptionMode]
  );

  const capability = useMemo(
    () => capThresholdsOrdered.map((t) => t < density),
    [capThresholdsOrdered, density]
  );

  const subscribed = useMemo(
    () => subThresholdsOrdered.map((t) => t < vaccinationRate),
    [subThresholdsOrdered, vaccinationRate]
  );

  // Adjacency list (undirected).
  const adjacency = useMemo(() => {
    const adj = Array.from({ length: N }, () => []);
    edges.forEach((e) => {
      const s = typeof e.source === 'object' ? e.source.id : e.source;
      const t = typeof e.target === 'object' ? e.target.id : e.target;
      adj[s].push(t);
      adj[t].push(s);
    });
    return adj;
  }, [N, edges]);

  // Numerical percolation thresholds — computed from the actual topology + capability mode
  // by finding the inflection point of LCC(x) on the active substrate. For ER + uniform
  // these track the analytic 1/⟨k⟩ closely; for BA or hub/periphery modes they diverge
  // significantly from the mean-field prediction, which is why we compute them.
  const rhoThreshold = useMemo(
    () => findRhoThreshold(N, adjacency, capThresholdsOrdered, subThresholdsOrdered, vaccinationRate),
    [N, adjacency, capThresholdsOrdered, subThresholdsOrdered, vaccinationRate]
  );
  const vThreshold = useMemo(
    () => findVThreshold(N, adjacency, capThresholdsOrdered, subThresholdsOrdered, density),
    [N, adjacency, capThresholdsOrdered, subThresholdsOrdered, density]
  );
  const percolationContour = useMemo(
    () => findPercolationContour(N, adjacency, capThresholdsOrdered, subThresholdsOrdered),
    [N, adjacency, capThresholdsOrdered, subThresholdsOrdered]
  );

  const applyState = (st) => {
    setInfected(st.infected);
    setVaccinated(st.vaccinated);
    setDefender(st.defender);
    setParent(st.parent);
  };

  // Reset whenever any initial-condition parameter changes.
  useEffect(() => {
    setPlaying(false);
    applyState(buildInitialState(capability, subscribed, infPrio, initialInfected));
    setTick(0);
  }, [capability, subscribed, infPrio, initialInfected, simSeed]);

  const reversal = useMemo(
    () => ({ commandeer, swarmConversion, hostReclamation, lineageReach }),
    [commandeer, swarmConversion, hostReclamation, lineageReach]
  );

  // Shared dynamics parameters for every simulation path.
  const dynamicsParams = useMemo(
    () => ({ N, adjacency, capability, subscribed, transmission, ...reversal }),
    [N, adjacency, capability, subscribed, transmission, reversal]
  );

  // SI+V+D step. Deterministic given (simSeed, tick).
  const stepOnce = useCallback(
    (state, currentTick) => stepDynamics(state, dynamicsParams, simSeed * 1000 + currentTick + 1),
    [dynamicsParams, simSeed]
  );

  const step = useCallback(() => {
    applyState(stepOnce({ infected, vaccinated, defender, parent }, tick));
    setTick((t) => t + 1);
  }, [stepOnce, infected, vaccinated, defender, parent, tick]);

  // Playback loop.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      applyState(stepOnce(stateRef.current, tickRef.current));
      setTick((t) => t + 1);
    }, 350);
    return () => clearInterval(id);
  }, [playing, stepOnce]);

  // Refs so the playback interval always reads latest state.
  const tickRef = useRef(tick);
  const stateRef = useRef({ infected, vaccinated, defender, parent });
  useEffect(() => { tickRef.current = tick; }, [tick]);
  useEffect(() => {
    stateRef.current = { infected, vaccinated, defender, parent };
  }, [infected, vaccinated, defender, parent]);

  // Synchronous run-to-tick — for generating the exact figure.
  const runToTarget = useCallback(() => {
    setPlaying(false);
    let s = buildInitialState(capability, subscribed, infPrio, initialInfected);
    for (let t = 0; t < targetTick; t++) s = stepOnce(s, t);
    applyState(s);
    setTick(targetTick);
  }, [capability, subscribed, infPrio, initialInfected, targetTick, stepOnce]);

  const reset = useCallback(() => {
    setPlaying(false);
    applyState(buildInitialState(capability, subscribed, infPrio, initialInfected));
    setTick(0);
  }, [capability, subscribed, infPrio, initialInfected]);

  // Invalidate sweep + surface results whenever the underlying topology changes.
  // Results through p / targetTick changes are preserved but flagged as stale.
  useEffect(() => {
    setSweepResults(null);
    setSweepCapture(null);
    setSweepProgress(0);
    setSweepThresholdOverride(null);
    setSweepThresholdHidden(false);
    setSurfaceResults(null);
    setSurfaceCapture(null);
    setSurfaceProgress(0);
  }, [N, meanDegree, topologySeed, topologyKind, baAlpha]);

  // Run the sweep over ρ or v. For each point, run `sweepTrials` simulations
  // with distinct sim seeds, average the final compromise fractions, record std.
  const runSweep = useCallback(async () => {
    if (sweepRunning) return;
    setSweepRunning(true);
    setSweepProgress(0);
    setSweepResults(null);
    setSweepThresholdOverride(null); // new sweep — drop any prior manual placement
    setSweepThresholdHidden(false);  // new sweep — re-show the marker

    const axis = sweepAxis;
    const xMin = axis === 'rho' ? sweepMinDensity : sweepMinV;
    const xMax = axis === 'rho' ? sweepMaxDensity : sweepMaxV;

    const results = [];
    for (let k = 0; k < sweepPoints; k++) {
      const x =
        sweepPoints === 1 ? xMin : xMin + ((xMax - xMin) * k) / (sweepPoints - 1);

      // Compute capability and subscription depending on which axis is swept.
      const rhoK = axis === 'rho' ? x : density;
      const vK = axis === 'v' ? x : vaccinationRate;
      const cap = capThresholdsOrdered.map((t) => t < rhoK);
      const sub = subThresholdsOrdered.map((t) => t < vK);

      const trials = [];
      for (let trial = 1; trial <= sweepTrials; trial++) {
        // Choose initial seeds based on strategy.
        let infState;
        if (sweepSeedStrategy === 'priority') {
          // Deterministic: lowest-priority capable node(s). Same across trials —
          // all variance comes from transmission stochasticity.
          infState = new Array(N).fill(false);
          const ranked = cap
            .map((c, i) => ({ i, c, p: infPrio[i] }))
            .filter((x) => x.c)
            .sort((a, b) => a.p - b.p);
          for (let k2 = 0; k2 < Math.min(initialInfected, ranked.length); k2++) {
            infState[ranked[k2].i] = true;
          }
        } else {
          // Random per trial: uniformly-sampled capable node(s), reproducible via trial seed.
          // Averaging over placement gives the typical-case phase transition.
          const placeRng = mulberry32(trial * 7919 + 31337);
          const capableIndices = [];
          for (let i = 0; i < N; i++) if (cap[i]) capableIndices.push(i);
          // Fisher–Yates
          for (let i = capableIndices.length - 1; i > 0; i--) {
            const j = Math.floor(placeRng() * (i + 1));
            [capableIndices[i], capableIndices[j]] = [capableIndices[j], capableIndices[i]];
          }
          infState = new Array(N).fill(false);
          const nSeeds = Math.min(initialInfected, capableIndices.length);
          for (let k2 = 0; k2 < nSeeds; k2++) infState[capableIndices[k2]] = true;
        }

        // Instantaneous reactive vaccination — if any seed is infected, all
        // uninfected subscribers become V at t=0 before transmission begins.
        const vacState = new Array(N).fill(false);
        if (infState.some((x) => x)) {
          for (let i = 0; i < N; i++) {
            if (sub[i] && !infState[i]) vacState[i] = true;
          }
        }

        const params = { N, adjacency, capability: cap, subscribed: sub, transmission, ...reversal };
        let st = { infected: infState, vaccinated: vacState, defender: new Array(N).fill(false) };
        for (let t = 0; t < targetTick; t++) st = stepDynamics(st, params, trial * 1000 + t + 1);

        let capInf = 0, nonCapInf = 0, vacCount = 0, defCount = 0;
        for (let i = 0; i < N; i++) {
          if (st.infected[i]) {
            if (cap[i]) capInf++;
            else nonCapInf++;
          } else if (st.defender[i]) {
            defCount++;
          } else if (st.vaccinated[i]) {
            vacCount++;
          }
        }
        trials.push({
          total: (capInf + nonCapInf) / N,
          prop: capInf / N,
          term: nonCapInf / N,
          vac: vacCount / N,
          def: defCount / N,
        });
      }

      const avg = (key) => trials.reduce((s, x) => s + x[key], 0) / trials.length;
      const std = (key, m) =>
        Math.sqrt(trials.reduce((s, x) => s + (x[key] - m) ** 2, 0) / trials.length);
      const totalM = avg('total');
      const propM = avg('prop');
      const termM = avg('term');
      const vacM = avg('vac');
      const defM = avg('def');

      results.push({
        x,
        total: totalM,
        totalStd: std('total', totalM),
        prop: propM,
        propStd: std('prop', propM),
        term: termM,
        termStd: std('term', termM),
        vac: vacM,
        vacStd: std('vac', vacM),
        def: defM,
        defStd: std('def', defM),
      });

      setSweepProgress((k + 1) / sweepPoints);
      // Yield to the event loop so progress UI can update.
      await new Promise((r) => setTimeout(r, 0));
    }

    setSweepResults(results);
    setSweepCapture({
      axis,
      xMin,
      xMax,
      N,
      meanDegree,
      topologySeed,
      topologyKind,
      baAlpha,
      capabilityMode,
      subscriptionMode,
      transmission,
      targetTick,
      initialInfected,
      sweepTrials,
      sweepSeedStrategy,
      density,         // scenario ρ (fixed during v-sweep; ignored during ρ-sweep)
      vaccinationRate, // scenario v (fixed during ρ-sweep; ignored during v-sweep)
      ...reversal,
      // Snapshot the numerical threshold at sweep time so the marker matches the captured run.
      numericalThreshold: axis === 'rho' ? rhoThreshold : vThreshold,
    });
    setSweepRunning(false);
  }, [
    sweepRunning,
    sweepAxis,
    sweepPoints,
    sweepMinDensity,
    sweepMaxDensity,
    sweepMinV,
    sweepMaxV,
    sweepTrials,
    sweepSeedStrategy,
    capThresholdsOrdered,
    subThresholdsOrdered,
    infPrio,
    initialInfected,
    targetTick,
    N,
    adjacency,
    transmission,
    meanDegree,
    topologySeed,
    topologyKind,
    baAlpha,
    capabilityMode,
    subscriptionMode,
    density,
    vaccinationRate,
    rhoThreshold,
    vThreshold,
    reversal,
  ]);

  const exportSweepPNG = useCallback(() => {
    if (!sweepResults || !sweepCapture) return;
    const c = sweepCapture;
    const stratTag = c.sweepSeedStrategy === 'random' ? 'rndseed' : 'priseed';
    const axisTag = c.axis === 'rho' ? 'rho-sweep' : 'v-sweep';
    const kindTag = c.topologyKind || 'er';
    // Encode α for BA topologies; ER doesn't use it.
    const alphaTag = c.topologyKind === 'ba' ? `_a${(c.baAlpha ?? 1).toFixed(2).replace('.', '')}` : '';
    const modeTag = `cap${(c.capabilityMode || 'uniform')[0]}_sub${(c.subscriptionMode || 'uniform')[0]}`;
    // For ρ-sweep, encode the fixed v; for v-sweep, encode the fixed ρ.
    const fixedTag =
      c.axis === 'rho'
        ? `v${c.vaccinationRate.toFixed(2).replace('.', '')}`
        : `rho${c.density.toFixed(2).replace('.', '')}`;
    // Note manual override / hidden marker in the filename so paper figures don't silently mix.
    const overrideTag = sweepThresholdHidden
      ? '_noThr'
      : sweepThresholdOverride !== null
      ? '_manualThr'
      : '';
    const filename = `rac_${axisTag}_${kindTag}${alphaTag}_${modeTag}_${stratTag}_N${c.N}_k${c.meanDegree}_seed${c.topologySeed}_p${c.transmission
      .toFixed(2)
      .replace('.', '')}_${fixedTag}_t${c.targetTick}_trials${c.sweepTrials}${reversalTag(c)}${overrideTag}.png`;
    rasterizeSVGToPNG(sweepSvgRef.current, sweepWidth, sweepHeight, filename, '#fafaf9');
  }, [sweepResults, sweepCapture, sweepThresholdOverride, sweepThresholdHidden, sweepWidth, sweepHeight]);

  // Run the 2D surface sweep over (ρ, v). Grid of G × G points, each averaged
  // over `surfaceTrials` realizations. Compute grows as G²·trials.
  const runSurface = useCallback(async () => {
    if (surfaceRunning) return;
    setSurfaceRunning(true);
    setSurfaceProgress(0);
    setSurfaceResults(null);

    const G = surfaceGridSize;
    const grid = []; // grid[iRho][iV] = { rho, v, total, totalStd }

    let done = 0;
    const totalCells = G * G;

    for (let iRho = 0; iRho < G; iRho++) {
      const rhoK = G === 1 ? 0.5 : iRho / (G - 1);
      const cap = capThresholdsOrdered.map((t) => t < rhoK);

      const row = [];
      for (let iV = 0; iV < G; iV++) {
        const vK = G === 1 ? 0 : iV / (G - 1);
        const sub = subThresholdsOrdered.map((t) => t < vK);

        const trialTotals = [];
        for (let trial = 1; trial <= surfaceTrials; trial++) {
          // Random seed per trial, reproducible.
          const placeRng = mulberry32(trial * 7919 + 31337);
          const capableIndices = [];
          for (let i = 0; i < N; i++) if (cap[i]) capableIndices.push(i);
          for (let i = capableIndices.length - 1; i > 0; i--) {
            const j = Math.floor(placeRng() * (i + 1));
            [capableIndices[i], capableIndices[j]] = [capableIndices[j], capableIndices[i]];
          }
          const infState = new Array(N).fill(false);
          const nSeeds = Math.min(initialInfected, capableIndices.length);
          for (let k2 = 0; k2 < nSeeds; k2++) infState[capableIndices[k2]] = true;

          // Reactive vaccination at t=0.
          const vacState = new Array(N).fill(false);
          if (infState.some((x) => x)) {
            for (let i = 0; i < N; i++) {
              if (sub[i] && !infState[i]) vacState[i] = true;
            }
          }

          const params = { N, adjacency, capability: cap, subscribed: sub, transmission, ...reversal };
          let st = { infected: infState, vaccinated: vacState, defender: new Array(N).fill(false) };
          for (let t = 0; t < targetTick; t++) st = stepDynamics(st, params, trial * 1000 + t + 1);

          let totalInf = 0;
          for (let i = 0; i < N; i++) if (st.infected[i]) totalInf++;
          trialTotals.push(totalInf / N);
        }

        const mean = trialTotals.reduce((s, x) => s + x, 0) / trialTotals.length;
        const variance =
          trialTotals.reduce((s, x) => s + (x - mean) ** 2, 0) / trialTotals.length;
        row.push({ rho: rhoK, v: vK, total: mean, totalStd: Math.sqrt(variance) });

        done++;
        // Yield every few cells so the UI can breathe.
        if (done % Math.max(1, Math.floor(G / 4)) === 0) {
          setSurfaceProgress(done / totalCells);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      grid.push(row);
    }

    setSurfaceResults(grid);
    setSurfaceCapture({
      N,
      meanDegree,
      topologySeed,
      topologyKind,
      baAlpha,
      capabilityMode,
      subscriptionMode,
      transmission,
      targetTick,
      initialInfected,
      surfaceTrials,
      gridSize: G,
      contourPoints: percolationContour,
      ...reversal,
    });
    setSurfaceProgress(1);
    setSurfaceRunning(false);
  }, [
    surfaceRunning,
    surfaceGridSize,
    surfaceTrials,
    capThresholdsOrdered,
    subThresholdsOrdered,
    initialInfected,
    targetTick,
    N,
    adjacency,
    transmission,
    meanDegree,
    topologySeed,
    topologyKind,
    baAlpha,
    capabilityMode,
    subscriptionMode,
    percolationContour,
    reversal,
  ]);

  const exportSurfacePNG = useCallback(() => {
    if (!surfaceResults || !surfaceCapture) return;
    const c = surfaceCapture;
    const kindTag = c.topologyKind || 'er';
    const alphaTag = c.topologyKind === 'ba' ? `_a${(c.baAlpha ?? 1).toFixed(2).replace('.', '')}` : '';
    const modeTag = `cap${(c.capabilityMode || 'uniform')[0]}_sub${(c.subscriptionMode || 'uniform')[0]}`;
    const filename = `rac_surface_${kindTag}${alphaTag}_${modeTag}_N${c.N}_k${c.meanDegree}_seed${c.topologySeed}_p${c.transmission
      .toFixed(2)
      .replace('.', '')}_t${c.targetTick}_g${c.gridSize}_trials${c.surfaceTrials}${reversalTag(c)}.png`;
    rasterizeSVGToPNG(surfaceSvgRef.current, surfaceWidth, surfaceHeight, filename, '#fafaf9');
  }, [surfaceResults, surfaceCapture, surfaceWidth, surfaceHeight]);

  const surfaceStale = useMemo(() => {
    if (!surfaceCapture) return false;
    const c = surfaceCapture;
    return (
      c.transmission !== transmission ||
      c.targetTick !== targetTick ||
      c.initialInfected !== initialInfected ||
      c.topologyKind !== topologyKind ||
      c.baAlpha !== baAlpha ||
      c.capabilityMode !== capabilityMode ||
      c.commandeer !== commandeer ||
      c.swarmConversion !== swarmConversion ||
      c.hostReclamation !== hostReclamation ||
      c.lineageReach !== lineageReach ||
      c.subscriptionMode !== subscriptionMode
    );
  }, [
    surfaceCapture,
    reversal,
    transmission,
    targetTick,
    initialInfected,
    topologyKind,
    baAlpha,
    capabilityMode,
    subscriptionMode,
  ]);

  // Is the current parameter state different from what the sweep captured?
  const sweepStale = useMemo(() => {
    if (!sweepCapture) return false;
    const c = sweepCapture;
    // Always compare the params that affect dynamics regardless of axis.
    if (
      c.transmission !== transmission ||
      c.targetTick !== targetTick ||
      c.initialInfected !== initialInfected ||
      c.sweepSeedStrategy !== sweepSeedStrategy ||
      c.axis !== sweepAxis ||
      c.topologyKind !== topologyKind ||
      c.baAlpha !== baAlpha ||
      c.capabilityMode !== capabilityMode ||
      c.commandeer !== commandeer ||
      c.swarmConversion !== swarmConversion ||
      c.hostReclamation !== hostReclamation ||
      c.lineageReach !== lineageReach ||
      c.subscriptionMode !== subscriptionMode
    ) {
      return true;
    }
    // The "fixed" parameter (the one not being swept) also matters.
    if (c.axis === 'rho' && c.vaccinationRate !== vaccinationRate) return true;
    if (c.axis === 'v' && c.density !== density) return true;
    return false;
  }, [
    sweepCapture,
    reversal,
    transmission,
    targetTick,
    initialInfected,
    sweepSeedStrategy,
    sweepAxis,
    topologyKind,
    baAlpha,
    capabilityMode,
    subscriptionMode,
    density,
    vaccinationRate,
  ]);

  // Aggregate stats.
  const stats = useMemo(() => {
    let nonCapSus = 0,
      nonCapInf = 0,
      nonCapVac = 0,
      capSus = 0,
      capInf = 0,
      capVac = 0,
      capDef = 0,
      nonCapDef = 0;
    for (let i = 0; i < N; i++) {
      const inf = infected[i];
      const def = !inf && defender[i];
      const vac = !inf && !def && vaccinated[i];
      if (capability[i]) {
        if (inf) capInf++;
        else if (def) capDef++;
        else if (vac) capVac++;
        else capSus++;
      } else {
        if (inf) nonCapInf++;
        else if (def) nonCapDef++;
        else if (vac) nonCapVac++;
        else nonCapSus++;
      }
    }
    const totalInf = capInf + nonCapInf;
    const totalVac = capVac + nonCapVac;
    const pct = N > 0 ? (totalInf / N) * 100 : 0;
    const vacPct = N > 0 ? (totalVac / N) * 100 : 0;
    const totalDef = capDef + nonCapDef;
    return {
      nonCapSus, nonCapInf, nonCapVac, nonCapDef,
      capSus, capInf, capVac, capDef,
      totalInf, totalVac, totalDef, pct, vacPct,
    };
  }, [N, capability, infected, vaccinated, defender]);

  // Export a 3x-scaled PNG for paper figures; parameters encoded in filename.
  const exportPNG = useCallback(() => {
    const modeTag =
      capabilityMode[0] + subscriptionMode[0]; // e.g. 'uu', 'hu', 'hh' — capability+subscription first letters
    const filename = `rac_${topologyKind}_cap${capabilityMode[0]}_sub${subscriptionMode[0]}_N${N}_k${meanDegree}_seed${topologySeed}_rho${density
      .toFixed(2)
      .replace('.', '')}_p${transmission.toFixed(2).replace('.', '')}_v${vaccinationRate
      .toFixed(2)
      .replace('.', '')}_t${tick}${reversalTag(reversal)}.png`;
    rasterizeSVGToPNG(svgRef.current, width, height, filename, '#fafaf9');
  }, [
    N,
    meanDegree,
    topologySeed,
    topologyKind,
    capabilityMode,
    subscriptionMode,
    density,
    transmission,
    vaccinationRate,
    tick,
    reversal,
  ]);

  const nodeFill = (i) => {
    if (infected[i]) return '#dc2626';   // compromised — red regardless of capability
    if (defender[i]) return capability[i] ? '#2563eb' : '#93c5fd'; // defender agent / reclaimed host
    if (vaccinated[i]) return '#16a34a'; // vaccinated — green regardless of capability
    if (capability[i]) return '#f97316'; // inference-capable susceptible — orange
    return '#ffffff';                    // non-inference susceptible — white
  };

  const btn =
    'inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs uppercase tracking-wider font-medium border border-stone-900 bg-white hover:bg-stone-900 hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none';
  const btnPrimary =
    'inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs uppercase tracking-wider font-medium border border-stone-900 bg-stone-900 text-white hover:bg-stone-700 transition-colors';

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6 pb-4 border-b border-stone-300 flex items-end justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-stone-500 mb-1">
              Recursive Autonomous Compromise
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">RAC Propagation Simulator</h1>
          </div>
          <div className="text-xs text-stone-500 text-right font-mono">
            <div>SI dynamics on capability-gated ER graph</div>
            <div>G(N, k) · seed fixed · ρ, p adjustable</div>
            <div>Reversal κ, σ, η adjustable</div>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-6">
          {/* Controls */}
          <div className="col-span-12 lg:col-span-4 space-y-6">
            <div className="border border-stone-300 bg-white p-5 space-y-5">
              <h2 className="text-xs uppercase tracking-wider font-semibold border-b border-stone-900 pb-2">
                Topology
              </h2>

              <div className="space-y-1.5">
                <label className="text-xs uppercase tracking-wider text-stone-500 font-medium">
                  Network model
                </label>
                <div className="grid grid-cols-2 border border-stone-900">
                  <button
                    onClick={() => setTopologyKind('er')}
                    className={`px-2 py-1.5 text-[11px] uppercase tracking-wider transition-colors ${
                      topologyKind === 'er'
                        ? 'bg-stone-900 text-white'
                        : 'bg-white hover:bg-stone-100'
                    }`}
                  >
                    Erdős–Rényi
                  </button>
                  <button
                    onClick={() => setTopologyKind('ba')}
                    className={`px-2 py-1.5 text-[11px] uppercase tracking-wider transition-colors border-l border-stone-900 ${
                      topologyKind === 'ba'
                        ? 'bg-stone-900 text-white'
                        : 'bg-white hover:bg-stone-100'
                    }`}
                  >
                    Scale-free (BA)
                  </button>
                </div>
                <div className="text-[10px] text-stone-500 leading-snug">
                  {topologyKind === 'er'
                    ? 'Random graph, degrees concentrated near ⟨k⟩, percolation threshold 1/⟨k⟩.'
                    : 'Preferential attachment, power-law degrees, hubs dominate dynamics. Internet-realistic.'}
                </div>
              </div>

              <Slider label="Nodes (N)" value={N} min={40} max={400} step={10} onChange={setN} />
              <Slider
                label="Mean degree ⟨k⟩"
                value={meanDegree}
                min={2}
                max={12}
                step={1}
                onChange={setMeanDegree}
              />
              <Slider
                label="Topology seed"
                value={topologySeed}
                min={1}
                max={200}
                step={1}
                onChange={setTopologySeed}
              />

              {topologyKind === 'ba' && (
                <div className="space-y-1.5">
                  <Slider
                    label="Hub concentration  α"
                    value={baAlpha}
                    min={0}
                    max={2}
                    step={0.05}
                    onChange={setBaAlpha}
                    format={(v) => v.toFixed(2)}
                  />
                  <div className="text-[10px] text-stone-500 leading-snug">
                    {baAlpha < 0.5
                      ? 'Near-uniform attachment — hub structure suppressed; behaves like ER.'
                      : baAlpha < 0.9
                      ? 'Sub-linear preferential attachment — moderate hub structure.'
                      : baAlpha <= 1.1
                      ? 'Standard BA (γ ≈ 3). Hubs dominate but no super-hubs.'
                      : baAlpha <= 1.4
                      ? 'Super-linear — Internet-like (γ ≈ 2.1) regime, heavy-tailed.'
                      : 'Winner-takes-all — a few super-hubs absorb most edges.'}
                  </div>
                </div>
              )}

              <div className="space-y-1.5 pt-2 border-t border-stone-200">
                <label className="text-xs uppercase tracking-wider text-stone-500 font-medium">
                  Capability assignment
                </label>
                <div className="grid grid-cols-3 border border-stone-900">
                  {[
                    { key: 'uniform', label: 'Uniform' },
                    { key: 'hub', label: 'Hub' },
                    { key: 'periphery', label: 'Periphery' },
                  ].map((m, i) => (
                    <button
                      key={m.key}
                      onClick={() => setCapabilityMode(m.key)}
                      className={`px-1 py-1.5 text-[10px] uppercase tracking-wider transition-colors ${
                        i > 0 ? 'border-l border-stone-900' : ''
                      } ${
                        capabilityMode === m.key
                          ? 'bg-stone-900 text-white'
                          : 'bg-white hover:bg-stone-100'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-stone-500 leading-snug">
                  {capabilityMode === 'uniform'
                    ? 'Whether a node hosts an LLM/agent is independent of how connected it is.'
                    : capabilityMode === 'hub'
                    ? 'Highly-connected nodes host LLM/agent capability first (flat deployment: hub services run inference). Gateway-isolated inference shifts toward the periphery regime.'
                    : 'Sparsely-connected nodes host LLM/agent capability first (gateway-isolated inference, where externally high-degree nodes are proxies and inference runs behind them).'}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs uppercase tracking-wider text-stone-500 font-medium">
                  Subscription assignment
                </label>
                <div className="grid grid-cols-3 border border-stone-900">
                  {[
                    { key: 'uniform', label: 'Uniform' },
                    { key: 'hub', label: 'Hub' },
                    { key: 'periphery', label: 'Periphery' },
                  ].map((m, i) => (
                    <button
                      key={m.key}
                      onClick={() => setSubscriptionMode(m.key)}
                      className={`px-1 py-1.5 text-[10px] uppercase tracking-wider transition-colors ${
                        i > 0 ? 'border-l border-stone-900' : ''
                      } ${
                        subscriptionMode === m.key
                          ? 'bg-stone-900 text-white'
                          : 'bg-white hover:bg-stone-100'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-stone-500 leading-snug">
                  {subscriptionMode === 'uniform'
                    ? 'Crowd defense subscribers selected independently of degree.'
                    : subscriptionMode === 'hub'
                    ? 'Hubs subscribe first (Cohen et al. 2003 — exponentially more effective on scale-free).'
                    : 'Periphery subscribes first (worst-case defender allocation).'}
                </div>
              </div>

              <div className="text-[11px] text-stone-500 leading-snug pt-1 border-t border-stone-200">
                Edges: {edges.length} · ⟨k⟩ observed:{' '}
                <span className="font-mono">{((2 * edges.length) / N).toFixed(2)}</span> ·
                k<sub>max</sub>: <span className="font-mono">{Math.max(...degrees)}</span>
              </div>
            </div>

            <div className="border border-stone-300 bg-white p-5 space-y-5">
              <h2 className="text-xs uppercase tracking-wider font-semibold border-b border-stone-900 pb-2">
                Scenario
              </h2>
              <Slider
                label="Inference density  ρ"
                value={density}
                min={0}
                max={1}
                step={0.01}
                onChange={setDensity}
                format={(v) => v.toFixed(2)}
              />
              <Slider
                label="Transmission  p"
                value={transmission}
                min={0}
                max={1}
                step={0.01}
                onChange={setTransmission}
                format={(v) => v.toFixed(2)}
              />
              <Slider
                label="Crowd defense  v"
                value={vaccinationRate}
                min={0}
                max={1}
                step={0.01}
                onChange={setVaccinationRate}
                format={(v) => v.toFixed(2)}
              />
              <Slider
                label="Initial infected"
                value={initialInfected}
                min={1}
                max={10}
                step={1}
                onChange={setInitialInfected}
              />
              <Slider
                label="Sim seed"
                value={simSeed}
                min={1}
                max={100}
                step={1}
                onChange={setSimSeed}
              />
            </div>

            <div className="border border-stone-300 bg-white p-5 space-y-5">
              <h2 className="text-xs uppercase tracking-wider font-semibold border-b border-stone-900 pb-2">
                Reversal
              </h2>
              <div className="space-y-1.5">
                <Slider
                  label="Commandeer  κ"
                  value={commandeer}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={setCommandeer}
                  format={(v) => v.toFixed(2)}
                />
                <div className="text-[10px] text-stone-500 leading-snug">
                  Per attack attempt: probability the target seizes the attacking agent and
                  repurposes it as a defender.
                </div>
              </div>
              <div className="space-y-1.5">
                <Slider
                  label="Swarm conversion  σ"
                  value={swarmConversion}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={setSwarmConversion}
                  format={(v) => v.toFixed(2)}
                />
                <div className="text-[10px] text-stone-500 leading-snug">
                  Per tick, per contact: probability a defender agent converts a neighboring
                  swarm agent into another defender.
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs uppercase tracking-wider text-stone-500 font-medium">
                  Lineage reach
                </label>
                <div className="grid grid-cols-3 border border-stone-900">
                  {[
                    { key: 'off', label: 'Off' },
                    { key: 'direct', label: 'Direct' },
                    { key: 'full', label: 'Full (C2)' },
                  ].map((m, i) => (
                    <button
                      key={m.key}
                      onClick={() => setLineageReach(m.key)}
                      className={`px-2 py-1.5 text-[11px] uppercase tracking-wider transition-colors ${
                        i > 0 ? 'border-l border-stone-900' : ''
                      } ${
                        lineageReach === m.key
                          ? 'bg-stone-900 text-white'
                          : 'bg-white hover:bg-stone-100'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-stone-500 leading-snug">
                  {lineageReach === 'off'
                    ? 'Defenders reach only their direct network neighbors.'
                    : lineageReach === 'direct'
                    ? 'A defender also targets its chain of compromising agents (parent, grandparent, … back to the seed) with σ, even without a direct edge.'
                    : 'Global C2: the swarm is unified, so every defender agent reaches every compromised agent with σ each tick, across the entire infection tree.'}
                </div>
              </div>
              <div className="space-y-1.5">
                <Slider
                  label="Host reclamation  η"
                  value={hostReclamation}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={setHostReclamation}
                  format={(v) => v.toFixed(2)}
                />
                <div className="text-[10px] text-stone-500 leading-snug">
                  Per tick, per contact: probability a defender agent reclaims a neighboring
                  host the swarm has already compromised.
                </div>
              </div>
            </div>

            <div className="border border-stone-300 bg-white p-5 space-y-4">
              <h2 className="text-xs uppercase tracking-wider font-semibold border-b border-stone-900 pb-2">
                Playback
              </h2>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setPlaying((p) => !p)}
                  className={playing ? btnPrimary : btn}
                >
                  {playing ? <Pause size={13} /> : <Play size={13} />}
                  {playing ? 'Pause' : 'Play'}
                </button>
                <button onClick={step} className={btn} disabled={playing}>
                  <StepForward size={13} />
                  Step
                </button>
                <button onClick={reset} className={btn}>
                  <RotateCcw size={13} />
                  Reset
                </button>
                <button onClick={exportPNG} className={btn}>
                  <Download size={13} />
                  PNG (3×)
                </button>
              </div>

              <div className="pt-3 border-t border-stone-200 space-y-3">
                <Slider
                  label="Target tick"
                  value={targetTick}
                  min={1}
                  max={60}
                  step={1}
                  onChange={setTargetTick}
                />
                <button onClick={runToTarget} className={btnPrimary + ' w-full'}>
                  <FastForward size={13} />
                  Run to t = {targetTick}
                </button>
              </div>
            </div>
          </div>

          {/* Graph + stats */}
          <div className="col-span-12 lg:col-span-8 space-y-4">
            <div className="border border-stone-300 bg-white">
              <div className="flex items-stretch border-b border-stone-300">
                <div className="px-4 py-2.5 border-r border-stone-300 flex items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-stone-500">Tick</span>
                  <span className="font-mono text-base tabular-nums">
                    {String(tick).padStart(3, '0')}
                  </span>
                </div>
                <div className="px-4 py-2.5 border-r border-stone-300 flex items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-stone-500">
                    Compromised
                  </span>
                  <span className="font-mono text-base tabular-nums">
                    {stats.totalInf}/{N}
                  </span>
                </div>
                <div className="px-4 py-2.5 border-r border-stone-300 flex items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-stone-500">
                    Vaccinated
                  </span>
                  <span className="font-mono text-base tabular-nums">
                    {stats.totalVac}/{N}
                  </span>
                </div>
                <div className="px-4 py-2.5 border-r border-stone-300 flex items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-stone-500">
                    Defenders
                  </span>
                  <span className="font-mono text-base tabular-nums">
                    {stats.totalDef}/{N}
                  </span>
                </div>
                <div className="px-4 py-2.5 border-r border-stone-300 flex items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-stone-500">
                    Rate
                  </span>
                  <span className="font-mono text-base tabular-nums">{stats.pct.toFixed(1)}%</span>
                </div>
                <div className="flex-1 px-4 py-2.5 flex items-center justify-end gap-3 text-[11px] text-stone-600">
                  <LegendSwatch fill="#ffffff" label="Non-inf. S" />
                  <LegendSwatch fill="#f97316" label="Inf. S" />
                  <LegendSwatch fill="#16a34a" label="V" />
                  <LegendSwatch fill="#dc2626" label="I" />
                  <LegendSwatch fill="#2563eb" label="D agent" />
                  <LegendSwatch fill="#93c5fd" label="D host" />
                </div>
              </div>

              <svg
                ref={svgRef}
                viewBox={`0 0 ${width} ${height}`}
                className="w-full"
                style={{ background: '#fafaf9' }}
              >
                {/* Edges */}
                <g>
                  {edges.map((e) => {
                    const a = positions[e.source];
                    const b = positions[e.target];
                    const sIdx = typeof e.source === 'object' ? e.source.id : e.source;
                    const tIdx = typeof e.target === 'object' ? e.target.id : e.target;
                    // Edge "active" iff an inference-capable compromised endpoint faces a still-clean neighbor.
                    const active =
                      (infected[sIdx] && capability[sIdx] && !infected[tIdx]) ||
                      (infected[tIdx] && capability[tIdx] && !infected[sIdx]);
                    // Reversal front: a defender agent faces a compromised neighbor.
                    const reversing =
                      (defender[sIdx] && capability[sIdx] && infected[tIdx]) ||
                      (defender[tIdx] && capability[tIdx] && infected[sIdx]);
                    return (
                      <line
                        key={e.id}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke={reversing ? '#60a5fa' : active ? '#9ca3af' : '#d6d3d1'}
                        strokeWidth={reversing || active ? 1.1 : 0.8}
                      />
                    );
                  })}
                </g>
                {/* Nodes */}
                <g>
                  {nodes.map((n) => (
                    <circle
                      key={n.id}
                      cx={positions[n.id].x}
                      cy={positions[n.id].y}
                      r={7}
                      fill={nodeFill(n.id)}
                      stroke="#000000"
                      strokeWidth={1.4}
                    />
                  ))}
                </g>
              </svg>
            </div>

            {/* Secondary readout */}
            <div className="grid grid-cols-5 border border-stone-300 bg-white text-sm">
              <Cell label="N" value={N} />
              <Cell label="⟨k⟩" value={((2 * edges.length) / N).toFixed(2)} />
              <Cell label="ρ" value={density.toFixed(2)} />
              <Cell label="p" value={transmission.toFixed(2)} />
              <Cell label="v" value={vaccinationRate.toFixed(2)} border="none" />
              <Cell label="Propagators (I, inf.)" value={stats.capInf} top />
              <Cell label="Terminal (I, non-inf.)" value={stats.nonCapInf} top />
              <Cell label="Vaccinated (V)" value={stats.totalVac} top />
              <Cell label="Compromise rate" value={stats.pct.toFixed(1) + '%'} top />
              <Cell
                label="Vaccination rate"
                value={stats.vacPct.toFixed(1) + '%'}
                top
                border="none"
              />
              <Cell label="κ (commandeer)" value={commandeer.toFixed(2)} top />
              <Cell label="σ (swarm conv.)" value={swarmConversion.toFixed(2)} top />
              <Cell label="η (host reclaim)" value={hostReclamation.toFixed(2)} top />
              <Cell label="Defender agents (D, inf.)" value={stats.capDef} top />
              <Cell label="Reclaimed hosts (D, non-inf.)" value={stats.nonCapDef} top border="none" />
            </div>

            <div className="text-[11px] text-stone-500 leading-relaxed">
              SI + reactive-V dynamics with asymmetric capability. At each tick, every compromised
              inference-capable node independently attempts to transmit to each uninfected,
              unvaccinated neighbor with probability p. Non-inference nodes can be compromised
              (exfiltration, data destruction, lateral reconnaissance) but cannot host a recursive
              attacker — compromise terminates at their vertex. A fraction v of all nodes
              subscribe to a crowd-defense channel (e.g. CrowdSec-style shared attack signatures);
              the moment any node is compromised, every uninfected subscriber transitions S → V
              instantaneously and is permanently immune for this conversation's single-strain
              model. This is the zero-latency limit of Funk et al.'s awareness-coupled epidemic
              model (PNAS 2009) and Cohen et al.'s reactive immunization (PRL 2003): the S → V
              channel is triggered endogenously by detection events, not by an exogenous campaign
              rate. Empirically, v shifts the effective reproduction number R<sub>eff</sub> ≈ ρ·p·⟨k⟩·(1−v)
              — at sufficient adoption, R<sub>eff</sub> drops below 1 even at supercritical ρ.
            </div>
            <div className="text-[11px] text-stone-500 leading-relaxed">
              Reversal dynamics (D). Every attack attempt a propagator makes on a clean neighbor
              carries a probability κ that the target commandeers the attacker instead, flipping it
              I → D. A defender agent turns the swarm's own reach against it: each tick it attempts
              every compromised neighbor, converting swarm agents (compromised inference-capable
              nodes) into further defender agents with probability σ and reclaiming compromised
              hosts (non-inference nodes the swarm already holds) with probability η. Converted
              agents propagate the reversal onward; reclaimed hosts cannot. Lineage reach widens σ
              beyond direct links: in Direct mode a defender also knows the lineage of agents that
              compromised it and applies σ to each ancestor back to the seed; in Full (C2) mode the
              swarm shares a global command-and-control channel, so every defender agent applies σ
              to every compromised agent in the swarm each tick. Host reclamation always needs a
              direct link. D is absorbing and
              blocks reinfection, so the attack and the reversal front compete on the same
              substrate. With κ = σ = η = 0 the model reduces exactly to SI + reactive-V.
            </div>
          </div>
        </div>

        {/* Sweep: compromise rate as a function of ρ or v */}
        <div className="mt-6 pt-6 border-t border-stone-300">
          <div className="flex items-end justify-between mb-6">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-stone-500 mb-1">
                {(sweepCapture?.axis ?? sweepAxis) === 'rho'
                  ? 'Density Sweep'
                  : 'Crowd Defense Sweep'}
              </div>
              <h2 className="text-lg font-semibold tracking-tight">
                Compromise rate vs.{' '}
                {(sweepCapture?.axis ?? sweepAxis) === 'rho'
                  ? 'inference density'
                  : 'crowd defense adoption'}{' '}
                at t = {sweepCapture?.targetTick ?? targetTick}
              </h2>
            </div>
            <div className="text-xs text-stone-500 text-right font-mono">
              <div>Monte Carlo over sim seeds 1…{sweepCapture?.sweepTrials ?? sweepTrials}</div>
              <div>
                Topology fixed ·{' '}
                {(sweepCapture?.axis ?? sweepAxis) === 'rho' ? 'ρ varied' : 'v varied'} · p ={' '}
                {(sweepCapture?.transmission ?? transmission).toFixed(2)} ·{' '}
                {(sweepCapture?.axis ?? sweepAxis) === 'rho'
                  ? `v = ${(sweepCapture?.vaccinationRate ?? vaccinationRate).toFixed(2)}`
                  : `ρ = ${(sweepCapture?.density ?? density).toFixed(2)}`}
              </div>
              {reversalTag(sweepCapture ?? reversal) && (
                <div>
                  κ = {(sweepCapture?.commandeer ?? commandeer).toFixed(2)} · σ ={' '}
                  {(sweepCapture?.swarmConversion ?? swarmConversion).toFixed(2)} · η ={' '}
                  {(sweepCapture?.hostReclamation ?? hostReclamation).toFixed(2)}
                  {{ direct: ' · ancestral', full: ' · global C2' }[
                    sweepCapture?.lineageReach ?? lineageReach
                  ] ?? ''}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-12 gap-6">
            {/* Sweep controls */}
            <div className="col-span-12 lg:col-span-4">
              <div className="border border-stone-300 bg-white p-5 space-y-5">
                <h2 className="text-xs uppercase tracking-wider font-semibold border-b border-stone-900 pb-2">
                  Sweep Parameters
                </h2>

                <div className="space-y-1.5">
                  <label className="text-xs uppercase tracking-wider text-stone-500 font-medium">
                    Sweep variable
                  </label>
                  <div className="grid grid-cols-2 border border-stone-900">
                    <button
                      onClick={() => setSweepAxis('rho')}
                      className={`px-2 py-1.5 text-[11px] uppercase tracking-wider transition-colors ${
                        sweepAxis === 'rho'
                          ? 'bg-stone-900 text-white'
                          : 'bg-white hover:bg-stone-100'
                      }`}
                    >
                      ρ (density)
                    </button>
                    <button
                      onClick={() => setSweepAxis('v')}
                      className={`px-2 py-1.5 text-[11px] uppercase tracking-wider transition-colors border-l border-stone-900 ${
                        sweepAxis === 'v'
                          ? 'bg-stone-900 text-white'
                          : 'bg-white hover:bg-stone-100'
                      }`}
                    >
                      v (crowd defense)
                    </button>
                  </div>
                  <div className="text-[10px] text-stone-500 leading-snug">
                    {sweepAxis === 'rho'
                      ? `v fixed at ${vaccinationRate.toFixed(2)} (scenario value). Change v in the Scenario panel.`
                      : `ρ fixed at ${density.toFixed(2)} (scenario value). Change ρ in the Scenario panel.`}
                  </div>
                </div>

                {sweepAxis === 'rho' ? (
                  <>
                    <Slider
                      label="ρ min"
                      value={sweepMinDensity}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(v) =>
                        setSweepMinDensity(Math.min(v, sweepMaxDensity - 0.01))
                      }
                      format={(v) => v.toFixed(2)}
                    />
                    <Slider
                      label="ρ max"
                      value={sweepMaxDensity}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(v) =>
                        setSweepMaxDensity(Math.max(v, sweepMinDensity + 0.01))
                      }
                      format={(v) => v.toFixed(2)}
                    />
                  </>
                ) : (
                  <>
                    <Slider
                      label="v min"
                      value={sweepMinV}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(v) => setSweepMinV(Math.min(v, sweepMaxV - 0.01))}
                      format={(v) => v.toFixed(2)}
                    />
                    <Slider
                      label="v max"
                      value={sweepMaxV}
                      min={0}
                      max={1}
                      step={0.01}
                      onChange={(v) => setSweepMaxV(Math.max(v, sweepMinV + 0.01))}
                      format={(v) => v.toFixed(2)}
                    />
                  </>
                )}

                <Slider
                  label="Sweep points"
                  value={sweepPoints}
                  min={5}
                  max={51}
                  step={1}
                  onChange={setSweepPoints}
                />
                <Slider
                  label="Trials per point"
                  value={sweepTrials}
                  min={1}
                  max={20}
                  step={1}
                  onChange={setSweepTrials}
                />

                <div className="space-y-1.5 pt-1">
                  <label className="text-xs uppercase tracking-wider text-stone-500 font-medium">
                    Seed placement
                  </label>
                  <div className="grid grid-cols-2 border border-stone-900">
                    <button
                      onClick={() => setSweepSeedStrategy('random')}
                      className={`px-2 py-1.5 text-[11px] uppercase tracking-wider transition-colors ${
                        sweepSeedStrategy === 'random'
                          ? 'bg-stone-900 text-white'
                          : 'bg-white hover:bg-stone-100'
                      }`}
                    >
                      Random / trial
                    </button>
                    <button
                      onClick={() => setSweepSeedStrategy('priority')}
                      className={`px-2 py-1.5 text-[11px] uppercase tracking-wider transition-colors border-l border-stone-900 ${
                        sweepSeedStrategy === 'priority'
                          ? 'bg-stone-900 text-white'
                          : 'bg-white hover:bg-stone-100'
                      }`}
                    >
                      Priority-ranked
                    </button>
                  </div>
                  <div className="text-[10px] text-stone-500 leading-snug">
                    {sweepSeedStrategy === 'random'
                      ? 'Random capable node per trial — averages over placement, smooth curves.'
                      : 'Lowest-priority capable node — deterministic but seed flips across ρ can create artifacts.'}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-stone-200">
                  <button
                    onClick={runSweep}
                    className={btnPrimary + ' col-span-3'}
                    disabled={sweepRunning}
                  >
                    <FastForward size={13} />
                    {sweepRunning
                      ? `Running ${Math.round(sweepProgress * 100)}%`
                      : `Run sweep (${sweepPoints * sweepTrials} runs)`}
                  </button>
                  <button
                    onClick={() => setSweepThresholdHidden((h) => !h)}
                    className={sweepThresholdHidden ? btnPrimary : btn}
                    disabled={!sweepResults}
                    title="Toggle visibility of the threshold marker"
                  >
                    {sweepThresholdHidden ? 'Show ρc/vc' : 'Hide ρc/vc'}
                  </button>
                  <button
                    onClick={() => setSweepThresholdOverride(null)}
                    className={btn}
                    disabled={!sweepResults || sweepThresholdOverride === null}
                    title="Restore the algorithmic inflection-point estimate"
                  >
                    <RotateCcw size={13} />
                    Reset
                  </button>
                  <button
                    onClick={exportSweepPNG}
                    className={btn}
                    disabled={!sweepResults}
                  >
                    <Download size={13} />
                    PNG (3×)
                  </button>
                </div>

                {sweepRunning && (
                  <div className="h-1 bg-stone-200 overflow-hidden">
                    <div
                      className="h-1 bg-stone-900"
                      style={{ width: `${sweepProgress * 100}%`, transition: 'width 0.1s' }}
                    />
                  </div>
                )}

                <div className="text-[11px] text-stone-500 leading-snug pt-1 border-t border-stone-200">
                  Uses current topology (N={N}, ⟨k⟩={meanDegree}), transmission (p=
                  {transmission.toFixed(2)}), initial infected ({initialInfected}), and target
                  tick ({targetTick}).{' '}
                  {sweepAxis === 'rho'
                    ? `Crowd defense v=${vaccinationRate.toFixed(2)} is held fixed.`
                    : `Inference density ρ=${density.toFixed(2)} is held fixed.`}
                  {sweepPoints * sweepTrials > 300 && (
                    <span className="block mt-1 text-amber-700">
                      {sweepPoints * sweepTrials} runs — may take several seconds.
                    </span>
                  )}
                  {sweepStale && (
                    <span className="block mt-1 text-amber-700">
                      Parameters have changed since this sweep — re-run to refresh.
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Sweep plot */}
            <div className="col-span-12 lg:col-span-8">
              <div className="border border-stone-300 bg-white">
                <div className="flex items-stretch border-b border-stone-300">
                  <div className="px-4 py-2.5 border-r border-stone-300 flex items-baseline gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-stone-500">t</span>
                    <span className="font-mono text-base tabular-nums">
                      {sweepCapture?.targetTick ?? targetTick}
                    </span>
                  </div>
                  <div className="px-4 py-2.5 border-r border-stone-300 flex items-baseline gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-stone-500">p</span>
                    <span className="font-mono text-base tabular-nums">
                      {(sweepCapture?.transmission ?? transmission).toFixed(2)}
                    </span>
                  </div>
                  {/* Fixed-parameter readout — shows the non-swept parameter. */}
                  <div className="px-4 py-2.5 border-r border-stone-300 flex items-baseline gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-stone-500">
                      {(sweepCapture?.axis ?? sweepAxis) === 'rho' ? 'v' : 'ρ'}
                    </span>
                    <span className="font-mono text-base tabular-nums">
                      {(sweepCapture?.axis ?? sweepAxis) === 'rho'
                        ? (sweepCapture?.vaccinationRate ?? vaccinationRate).toFixed(2)
                        : (sweepCapture?.density ?? density).toFixed(2)}
                    </span>
                  </div>
                  <div className="px-4 py-2.5 border-r border-stone-300 flex items-baseline gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-stone-500">
                      Trials
                    </span>
                    <span className="font-mono text-base tabular-nums">
                      {sweepCapture?.sweepTrials ?? sweepTrials}
                    </span>
                  </div>
                  <div className="flex-1 px-4 py-2.5 flex items-center justify-end gap-4 text-[11px] text-stone-600">
                    <LegendLine color="#292524" label="Compromise rate (mean ± σ)" />
                    {sweepResults?.some((d) => d.def > 0) && (
                      <LegendLine color="#2563eb" label="Defender fraction" dashed />
                    )}
                  </div>
                </div>

                {sweepResults ? (
                  <SweepPlot
                    results={sweepResults}
                    axis={sweepCapture?.axis ?? 'rho'}
                    topologyKind={sweepCapture?.topologyKind ?? topologyKind}
                    numericalThreshold={sweepCapture?.numericalThreshold ?? null}
                    thresholdOverride={sweepThresholdOverride}
                    onThresholdOverride={setSweepThresholdOverride}
                    thresholdHidden={sweepThresholdHidden}
                    xMin={sweepCapture?.xMin ?? 0}
                    xMax={sweepCapture?.xMax ?? 1}
                    width={sweepWidth}
                    height={sweepHeight}
                    svgRef={sweepSvgRef}
                  />
                ) : (
                  <div
                    style={{ height: sweepHeight }}
                    className="flex items-center justify-center text-stone-400 text-sm font-mono"
                  >
                    {sweepRunning
                      ? `Computing sweep…  ${Math.round(sweepProgress * 100)}%`
                      : 'Run sweep to generate plot'}
                  </div>
                )}
              </div>

              <div className="text-[11px] text-stone-500 leading-relaxed mt-3">
                {(() => {
                  const axis = sweepCapture?.axis ?? sweepAxis;
                  const kind = sweepCapture?.topologyKind ?? topologyKind;
                  const capMode = sweepCapture?.capabilityMode ?? capabilityMode;
                  const subMode = sweepCapture?.subscriptionMode ?? subscriptionMode;
                  const rhoFixed = sweepCapture?.density ?? density;
                  const vFixed = sweepCapture?.vaccinationRate ?? vaccinationRate;
                  const numThr = sweepCapture?.numericalThreshold ?? null;
                  const overrideThr = sweepThresholdOverride;
                  const isOverridden = overrideThr !== null && overrideThr !== undefined;
                  const isHidden = sweepThresholdHidden;
                  const trials = sweepCapture?.sweepTrials ?? sweepTrials;
                  const t = sweepCapture?.targetTick ?? targetTick;
                  const kindLabel = kind === 'ba' ? 'Barabási–Albert (scale-free)' : 'Erdős–Rényi';
                  const capLabel =
                    capMode === 'hub'
                      ? 'hub-correlated'
                      : capMode === 'periphery'
                      ? 'periphery-correlated'
                      : 'uniform';
                  const subLabel =
                    subMode === 'hub'
                      ? 'hub-correlated'
                      : subMode === 'periphery'
                      ? 'periphery-correlated'
                      : 'uniform';
                  return (
                    <>
                      Each point is the mean fraction of compromised nodes across {trials} independent
                      realizations of the SI + reactive-V dynamics on a {kindLabel} topology with{' '}
                      {capLabel} capability assignment and {subLabel} subscription assignment, at
                      t = {t}. Shaded band is ±1 standard deviation.
                      {axis === 'rho' ? (
                        isHidden ? (
                          <>
                            {' '}The threshold marker has been hidden because the curve does not
                            exhibit a well-defined transition over this range — the LCC of the
                            active substrate either rises smoothly without a sharp inflection,
                            stays flat, or saturates immediately. Reporting a single ρ
                            <sub>c</sub> would be misleading; the algorithmic estimate (
                            {numThr !== null ? numThr.toFixed(3) : 'n/a'}) is recorded for
                            reference but not displayed.
                          </>
                        ) : (
                          <>
                            {' '}The dashed vertical marks the percolation threshold ρ<sub>c</sub>{' '}
                            {isOverridden
                              ? `= ${overrideThr.toFixed(3)} (manually placed; algorithmic estimate ${
                                  numThr !== null ? numThr.toFixed(3) : 'n/a'
                                } at v = ${vFixed.toFixed(2)})`
                              : numThr !== null
                              ? `≈ ${numThr.toFixed(3)} at v = ${vFixed.toFixed(2)} (algorithmic)`
                              : '(no transition detected within the sweep range)'}
                            {' '}— the inflection point of the largest connected component of the
                            active substrate (capable nodes that are not crowd-defense subscribers)
                            as a function of ρ. Computed numerically from the actual graph by
                            locating the ρ at which LCC(ρ) is rising fastest. Analytic mean-field
                            results such as ρ<sub>c</sub> = 1/⟨k⟩ are quantitatively wrong on
                            scale-free graphs and under non-uniform assignment modes. The marker
                            is draggable if the algorithmic estimate looks misplaced on a steep
                            curve, and can be hidden when no single threshold is meaningful.
                          </>
                        )
                      ) : isHidden ? (
                        <>
                          {' '}The threshold marker has been hidden because the curve does not
                          exhibit a well-defined transition over this range. The algorithmic
                          estimate ({numThr !== null ? numThr.toFixed(3) : 'n/a'}) is recorded
                          for reference but not displayed.
                        </>
                      ) : (
                        <>
                          {' '}The dashed vertical marks the critical subscription rate
                          v<sub>c</sub>{' '}
                          {isOverridden
                            ? `= ${overrideThr.toFixed(3)} (manually placed; algorithmic estimate ${
                                numThr !== null ? numThr.toFixed(3) : 'n/a'
                              } at ρ = ${rhoFixed.toFixed(2)})`
                            : numThr !== null
                            ? `≈ ${numThr.toFixed(3)} at ρ = ${rhoFixed.toFixed(2)} (algorithmic)`
                            : '(no transition detected; propagator substrate already subcritical at v = 0)'}
                          {' '}— the inflection point at which the active substrate's largest
                          connected component shrinks fastest as v rises. Computed numerically
                          from the topology and assignment modes. The marker is draggable, and
                          can be hidden when no single threshold is meaningful.
                        </>
                      )}
                      {' '}
                      {(sweepCapture?.sweepSeedStrategy ?? sweepSeedStrategy) === 'random'
                        ? 'Initial infection is placed at a uniformly-random capable node per trial.'
                        : 'Initial infection is placed at the lowest-priority capable node.'}
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>

        {/* Surface: compromise rate over the (ρ, v) grid */}
        <div className="mt-6 pt-6 border-t border-stone-300">
          <div className="flex items-end justify-between mb-6">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-stone-500 mb-1">
                Phase Diagram
              </div>
              <h2 className="text-lg font-semibold tracking-tight">
                Compromise rate over (ρ, v) at t = {surfaceCapture?.targetTick ?? targetTick}
              </h2>
            </div>
            <div className="text-xs text-stone-500 text-right font-mono">
              <div>
                {surfaceCapture?.gridSize ?? surfaceGridSize}×
                {surfaceCapture?.gridSize ?? surfaceGridSize} grid ·{' '}
                {surfaceCapture?.surfaceTrials ?? surfaceTrials} trials/cell
              </div>
              <div>Topology fixed · p = {(surfaceCapture?.transmission ?? transmission).toFixed(2)}</div>
            </div>
          </div>

          <div className="grid grid-cols-12 gap-6">
            {/* Surface controls */}
            <div className="col-span-12 lg:col-span-4">
              <div className="border border-stone-300 bg-white p-5 space-y-5">
                <h2 className="text-xs uppercase tracking-wider font-semibold border-b border-stone-900 pb-2">
                  Surface Parameters
                </h2>
                <Slider
                  label="Grid resolution (G×G)"
                  value={surfaceGridSize}
                  min={5}
                  max={25}
                  step={1}
                  onChange={setSurfaceGridSize}
                />
                <Slider
                  label="Trials per cell"
                  value={surfaceTrials}
                  min={1}
                  max={10}
                  step={1}
                  onChange={setSurfaceTrials}
                />

                <div className="pt-2 border-t border-stone-200 space-y-5">
                  <Slider
                    label="Azimuth (°)"
                    value={surfaceAzimuth}
                    min={0}
                    max={90}
                    step={1}
                    onChange={setSurfaceAzimuth}
                  />
                  <Slider
                    label="Elevation (°)"
                    value={surfaceElevation}
                    min={5}
                    max={75}
                    step={1}
                    onChange={setSurfaceElevation}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-stone-200">
                  <button
                    onClick={runSurface}
                    className={btnPrimary + ' col-span-2'}
                    disabled={surfaceRunning}
                  >
                    <FastForward size={13} />
                    {surfaceRunning
                      ? `Running ${Math.round(surfaceProgress * 100)}%`
                      : `Run surface (${surfaceGridSize * surfaceGridSize * surfaceTrials} runs)`}
                  </button>
                  <button
                    onClick={exportSurfacePNG}
                    className={btn + ' col-span-2'}
                    disabled={!surfaceResults}
                  >
                    <Download size={13} />
                    PNG (3×)
                  </button>
                </div>

                {surfaceRunning && (
                  <div className="h-1 bg-stone-200 overflow-hidden">
                    <div
                      className="h-1 bg-stone-900"
                      style={{
                        width: `${surfaceProgress * 100}%`,
                        transition: 'width 0.1s',
                      }}
                    />
                  </div>
                )}

                <div className="text-[11px] text-stone-500 leading-snug pt-1 border-t border-stone-200">
                  Uses current topology (N={N}, ⟨k⟩={meanDegree}), transmission (p=
                  {transmission.toFixed(2)}), initial infected ({initialInfected}), and target
                  tick ({targetTick}). Both ρ and v span [0, 1].
                  {surfaceGridSize * surfaceGridSize * surfaceTrials > 1000 && (
                    <span className="block mt-1 text-amber-700">
                      {surfaceGridSize * surfaceGridSize * surfaceTrials} runs — may take tens of
                      seconds.
                    </span>
                  )}
                  {surfaceStale && (
                    <span className="block mt-1 text-amber-700">
                      Parameters have changed since this surface — re-run to refresh.
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Surface plot */}
            <div className="col-span-12 lg:col-span-8">
              <div className="border border-stone-300 bg-white">
                <div className="flex items-stretch border-b border-stone-300">
                  <div className="px-4 py-2.5 border-r border-stone-300 flex items-baseline gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-stone-500">
                      Axes
                    </span>
                    <span className="font-mono text-xs tabular-nums">ρ × v → compromise</span>
                  </div>
                  <div className="flex-1 px-4 py-2.5 flex items-center justify-end gap-3 text-[11px] text-stone-600">
                    <LegendSwatch fill="#fef3c7" label="0%" />
                    <LegendSwatch fill="#f59e0b" label="50%" />
                    <LegendSwatch fill="#7f1d1d" label="100%" />
                  </div>
                </div>

                {surfaceResults ? (
                  <SurfacePlot
                    grid={surfaceResults}
                    contourPoints={surfaceCapture?.contourPoints ?? []}
                    azimuth={surfaceAzimuth}
                    elevation={surfaceElevation}
                    width={surfaceWidth}
                    height={surfaceHeight}
                    svgRef={surfaceSvgRef}
                  />
                ) : (
                  <div
                    style={{ height: surfaceHeight }}
                    className="flex items-center justify-center text-stone-400 text-sm font-mono"
                  >
                    {surfaceRunning
                      ? `Computing surface…  ${Math.round(surfaceProgress * 100)}%`
                      : 'Run surface to generate phase diagram'}
                  </div>
                )}
              </div>

              <div className="text-[11px] text-stone-500 leading-relaxed mt-3">
                {(() => {
                  const kind = surfaceCapture?.topologyKind ?? topologyKind;
                  const capMode = surfaceCapture?.capabilityMode ?? capabilityMode;
                  const subMode = surfaceCapture?.subscriptionMode ?? subscriptionMode;
                  const kindLabel = kind === 'ba' ? 'Barabási–Albert (scale-free)' : 'Erdős–Rényi';
                  const capLabel =
                    capMode === 'hub'
                      ? 'hub-correlated'
                      : capMode === 'periphery'
                      ? 'periphery-correlated'
                      : 'uniform';
                  const subLabel =
                    subMode === 'hub'
                      ? 'hub-correlated'
                      : subMode === 'periphery'
                      ? 'periphery-correlated'
                      : 'uniform';
                  return (
                    <>
                      Compromise rate as a joint function of inference density ρ and crowd-defense
                      subscription v on a {kindLabel} topology with {capLabel} capability and{' '}
                      {subLabel} subscription assignment. The dashed contour on the base plane is
                      the empirical percolation locus — the curve in (ρ, v) where the active
                      substrate's largest connected component is shrinking fastest with v at each
                      ρ (i.e. the inflection of LCC vs v). Computed directly from the topology
                      rather than from a mean-field approximation. Above and to the right of this
                      contour, the substrate is subcritical and compromise remains bounded
                      regardless of transmission rate; below and to the left, the substrate has a
                      giant component and compromise scales with topology. The surface is a Monte
                      Carlo sample averaged over{' '}
                      {surfaceCapture?.surfaceTrials ?? surfaceTrials} trials per grid cell,
                      rendered by SVG-projected mesh (azimuth / elevation controllable).
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LegendSwatch({ fill, label }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block w-3 h-3"
        style={{ background: fill, border: '1.2px solid #000' }}
      />
      <span>{label}</span>
    </div>
  );
}

function Cell({ label, value, top = false, border = 'right' }) {
  const cls = [
    'px-4 py-3',
    top ? 'border-t border-stone-300' : '',
    border === 'right' ? 'border-r border-stone-300' : '',
  ].join(' ');
  return (
    <div className={cls}>
      <div className="text-[10px] uppercase tracking-wider text-stone-500 mb-0.5">{label}</div>
      <div className="font-mono tabular-nums text-base">{value}</div>
    </div>
  );
}

function LegendLine({ color, label, dashed }) {
  return (
    <div className="flex items-center gap-1.5">
      <svg width="20" height="8" style={{ display: 'block' }}>
        <line
          x1={0}
          x2={20}
          y1={4}
          y2={4}
          stroke={color}
          strokeWidth={2}
          strokeDasharray={dashed ? '4 3' : undefined}
        />
      </svg>
      <span>{label}</span>
    </div>
  );
}

function SweepPlot({
  results,
  axis,
  topologyKind,
  numericalThreshold,
  thresholdOverride,
  onThresholdOverride,
  thresholdHidden,
  xMin,
  xMax,
  width,
  height,
  svgRef,
}) {
  const margin = { top: 18, right: 24, bottom: 46, left: 58 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const x = (v) => ((v - xMin) / (xMax - xMin)) * innerW;
  const y = (r) => innerH - r * innerH;
  // Inverse of x() — convert SVG-local x coord (relative to plotting area) back to data x.
  const xInv = (px) => xMin + (px / innerW) * (xMax - xMin);

  const makePath = (key) =>
    results
      .map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(d.x).toFixed(2)} ${y(d[key]).toFixed(2)}`)
      .join(' ');

  const makeBand = (key, stdKey) => {
    if (results.length < 2) return '';
    const upper = results.map(
      (d) => `${x(d.x).toFixed(2)},${y(Math.min(1, d[key] + d[stdKey])).toFixed(2)}`
    );
    const lower = results
      .slice()
      .reverse()
      .map((d) => `${x(d.x).toFixed(2)},${y(Math.max(0, d[key] - d[stdKey])).toFixed(2)}`);
    return `M ${upper.join(' L ')} L ${lower.join(' L ')} Z`;
  };

  const xTickCount = 6;
  const xTicks = Array.from(
    { length: xTickCount + 1 },
    (_, i) => xMin + (i / xTickCount) * (xMax - xMin)
  );
  const yTicks = [0, 0.2, 0.4, 0.6, 0.8, 1.0];

  // Effective threshold to display: manual override wins, otherwise the algorithmic estimate.
  const displayThreshold =
    thresholdOverride !== null && thresholdOverride !== undefined
      ? thresholdOverride
      : numericalThreshold;
  const isOverride = thresholdOverride !== null && thresholdOverride !== undefined;
  const showMarker =
    !thresholdHidden &&
    displayThreshold !== null &&
    displayThreshold !== undefined &&
    displayThreshold >= xMin &&
    displayThreshold <= xMax;

  // Drag handling. The handle is a wide invisible rect overlapping the line, which
  // captures pointer events even though the visible line is only 1px wide.
  // For viewBox-scaled SVGs, mapping client coords to SVG-local coords requires
  // getScreenCTM().inverse() so the marker doesn't drift if the SVG is rendered
  // at a different scale than its viewBox.
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef(null);

  const clientToDataX = (clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const local = pt.matrixTransform(ctm.inverse());
    // local.x is in SVG viewBox coords; subtract margin to get plotting-area-local px,
    // then convert to data coords.
    const px = local.x - margin.left;
    const dataX = xInv(Math.max(0, Math.min(innerW, px)));
    return dataX;
  };

  const handlePointerDown = (e) => {
    if (!onThresholdOverride) return;
    e.preventDefault();
    setIsDragging(true);
    const dataX = clientToDataX(e.clientX, e.clientY);
    if (dataX !== null) onThresholdOverride(dataX);
    // Capture pointer so we keep getting move events even if the cursor leaves the line.
    if (e.target && e.target.setPointerCapture) {
      try {
        e.target.setPointerCapture(e.pointerId);
        dragRef.current = e.target;
      } catch {
        /* old browser, no capture */
      }
    }
  };

  const handlePointerMove = (e) => {
    if (!isDragging || !onThresholdOverride) return;
    const dataX = clientToDataX(e.clientX, e.clientY);
    if (dataX !== null) onThresholdOverride(dataX);
  };

  const handlePointerUp = (e) => {
    if (!isDragging) return;
    setIsDragging(false);
    if (dragRef.current && dragRef.current.releasePointerCapture) {
      try {
        dragRef.current.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      dragRef.current = null;
    }
  };

  const xAxisLabel = axis === 'rho' ? 'Inference density  ρ' : 'Crowd defense  v';

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ background: '#fafaf9', display: 'block' }}
    >
      <g transform={`translate(${margin.left}, ${margin.top})`}>
        {/* Gridlines */}
        {yTicks.map((t, i) => (
          <line
            key={`gy${i}`}
            x1={0}
            x2={innerW}
            y1={y(t)}
            y2={y(t)}
            stroke="#e7e5e4"
            strokeWidth={1}
          />
        ))}
        {xTicks.map((t, i) => (
          <line
            key={`gx${i}`}
            x1={x(t)}
            x2={x(t)}
            y1={0}
            y2={innerH}
            stroke="#f5f5f4"
            strokeWidth={1}
          />
        ))}

        {/* Percolation threshold marker — draggable. Visible line is thin; an
            invisible wider rect overlays it to give the user a generous hit target. */}
        {showMarker && (
          <g>
            <line
              x1={x(displayThreshold)}
              x2={x(displayThreshold)}
              y1={0}
              y2={innerH}
              stroke={isOverride ? '#9333ea' : '#78716c'}
              strokeDasharray="4 3"
              strokeWidth={isDragging ? 1.6 : 1.2}
              pointerEvents="none"
            />
            {/* Wide hit target — invisible but interactive. */}
            <rect
              x={x(displayThreshold) - 8}
              y={-4}
              width={16}
              height={innerH + 8}
              fill="transparent"
              style={{ cursor: 'ew-resize', touchAction: 'none' }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />
            {/* Drag-handle indicator — small chevrons at top of the line. */}
            <g
              transform={`translate(${x(displayThreshold)}, -2)`}
              pointerEvents="none"
              fill={isOverride ? '#9333ea' : '#78716c'}
            >
              <polygon points="-3,0 0,4 3,0" />
            </g>
            <text
              x={x(displayThreshold) + 5}
              y={14}
              fontSize={10}
              textAnchor="start"
              fill={isOverride ? '#9333ea' : '#57534e'}
              fontFamily="ui-monospace, monospace"
              pointerEvents="none"
            >
              {axis === 'rho' ? (
                <>
                  ρ<tspan fontSize={7} dy={2}>c</tspan>
                  <tspan dy={-2}>{isOverride ? ' (manual)' : ' (empirical)'}</tspan>
                </>
              ) : (
                <>
                  v<tspan fontSize={7} dy={2}>c</tspan>
                  <tspan dy={-2}>{isOverride ? ' (manual)' : ' (empirical)'}</tspan>
                </>
              )}
              <tspan dx={4}>= {displayThreshold.toFixed(3)}</tspan>
            </text>
          </g>
        )}

        {/* Defender fraction — only when reversal produced any defenders */}
        {results.some((d) => d.def > 0) && (
          <g pointerEvents="none">
            <path d={makeBand('def', 'defStd')} fill="#2563eb" opacity={0.1} />
            <path
              d={makePath('def')}
              stroke="#2563eb"
              strokeWidth={1.6}
              strokeDasharray="5 3"
              fill="none"
            />
          </g>
        )}

        {/* ±σ band — behind the line */}
        <path d={makeBand('total', 'totalStd')} fill="#292524" opacity={0.14} pointerEvents="none" />

        {/* Curve */}
        <path d={makePath('total')} stroke="#292524" strokeWidth={2} fill="none" pointerEvents="none" />

        {/* Data markers */}
        {results.map((d, i) => (
          <circle
            key={i}
            cx={x(d.x)}
            cy={y(d.total)}
            r={2.5}
            fill="#292524"
            stroke="#fafaf9"
            strokeWidth={1}
          />
        ))}

        {/* Axes */}
        <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke="#000" strokeWidth={1.2} />
        <line x1={0} x2={0} y1={0} y2={innerH} stroke="#000" strokeWidth={1.2} />

        {/* X tick marks + labels */}
        {xTicks.map((t, i) => (
          <g key={`xt${i}`}>
            <line x1={x(t)} x2={x(t)} y1={innerH} y2={innerH + 4} stroke="#000" strokeWidth={1} />
            <text
              x={x(t)}
              y={innerH + 17}
              fontSize={10}
              textAnchor="middle"
              fill="#292524"
              fontFamily="ui-monospace, monospace"
            >
              {t.toFixed(2)}
            </text>
          </g>
        ))}

        {/* Y tick marks + labels */}
        {yTicks.map((t, i) => (
          <g key={`yt${i}`}>
            <line x1={-4} x2={0} y1={y(t)} y2={y(t)} stroke="#000" strokeWidth={1} />
            <text
              x={-8}
              y={y(t) + 3}
              fontSize={10}
              textAnchor="end"
              fill="#292524"
              fontFamily="ui-monospace, monospace"
            >
              {(t * 100).toFixed(0)}
            </text>
          </g>
        ))}

        {/* Axis labels */}
        <text
          x={innerW / 2}
          y={innerH + 38}
          fontSize={11}
          textAnchor="middle"
          fill="#292524"
          fontFamily="ui-sans-serif, system-ui"
        >
          {xAxisLabel}
        </text>
        <text
          transform={`translate(-42, ${innerH / 2}) rotate(-90)`}
          fontSize={11}
          textAnchor="middle"
          fill="#292524"
          fontFamily="ui-sans-serif, system-ui"
        >
          Compromise rate (%)
        </text>
      </g>
    </svg>
  );
}

// SurfacePlot — 3D(-ish) surface over (ρ, v) projected to 2D via a simple rotation.
// Uses painter's algorithm (back-to-front) for hidden-surface removal.
function SurfacePlot({ grid, contourPoints, azimuth, elevation, width, height, svgRef }) {
  const margin = { top: 30, right: 60, bottom: 30, left: 60 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const G = grid.length;
  if (G === 0) return null;

  // Convert angles to radians. Azimuth rotates around vertical axis (y), elevation tilts.
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;

  // Project a 3D point (x, y, z) to 2D screen coords.
  //   x ∈ [0, 1] — ρ
  //   y ∈ [0, 1] — v
  //   z ∈ [0, 1] — compromise rate (height)
  // Standard axonometric: rotate around y by az, then tilt by el.
  const project = (x, y, z) => {
    // Center the (x, y) plane around (0.5, 0.5) so rotation is around the middle.
    const cx = x - 0.5;
    const cy = y - 0.5;
    // Rotate around vertical z-axis (in xy plane) by az.
    const xr = cx * Math.cos(az) - cy * Math.sin(az);
    const yr = cx * Math.sin(az) + cy * Math.cos(az);
    // Tilt: y' = yr * cos(el) - z * sin(el); z is rendered upward.
    const screenY = yr * Math.cos(el) - z * Math.sin(el);
    const screenX = xr;
    return { sx: screenX, sy: screenY };
  };

  // Compute all projected points, then find bounds for scaling.
  const proj = [];
  for (let i = 0; i < G; i++) {
    const row = [];
    for (let j = 0; j < G; j++) {
      const cell = grid[i][j];
      row.push(project(cell.rho, cell.v, cell.total));
    }
    proj.push(row);
  }
  // Also project the base (floor) corners so the axis box stays tight.
  const baseCorners = [
    project(0, 0, 0),
    project(1, 0, 0),
    project(1, 1, 0),
    project(0, 1, 0),
    project(0, 0, 1), // for z-axis top
    project(1, 1, 1), // for top-back corner
  ];

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const row of proj) {
    for (const p of row) {
      if (p.sx < minX) minX = p.sx;
      if (p.sx > maxX) maxX = p.sx;
      if (p.sy < minY) minY = p.sy;
      if (p.sy > maxY) maxY = p.sy;
    }
  }
  for (const p of baseCorners) {
    if (p.sx < minX) minX = p.sx;
    if (p.sx > maxX) maxX = p.sx;
    if (p.sy < minY) minY = p.sy;
    if (p.sy > maxY) maxY = p.sy;
  }

  const scale = Math.min(innerW / (maxX - minX), innerH / (maxY - minY));
  // y is inverted on screen.
  const toScreen = (p) => ({
    x: margin.left + (p.sx - minX) * scale,
    y: margin.top + (maxY - p.sy) * scale,
  });

  // Color map: pale yellow → amber → dark red. Sequential, perceptually OK.
  const colorFor = (t) => {
    // Clamp.
    const v = Math.max(0, Math.min(1, t));
    // Three-stop gradient: 0 → #fef3c7 (pale yellow), 0.5 → #f59e0b (amber), 1 → #7f1d1d (dark red)
    const interp = (a, b, f) => Math.round(a + (b - a) * f);
    let r, g, bl;
    if (v < 0.5) {
      const f = v / 0.5;
      r = interp(0xfe, 0xf5, f);
      g = interp(0xf3, 0x9e, f);
      bl = interp(0xc7, 0x0b, f);
    } else {
      const f = (v - 0.5) / 0.5;
      r = interp(0xf5, 0x7f, f);
      g = interp(0x9e, 0x1d, f);
      bl = interp(0x0b, 0x1d, f);
    }
    return `rgb(${r}, ${g}, ${bl})`;
  };

  // Build quads (i, j) → (i+1, j) → (i+1, j+1) → (i, j+1), painter-ordered.
  // Depth key: project centroid and use the "further from viewer" coordinate, which
  // after our rotation+tilt corresponds to the original y-axis pre-rotation.
  // Simpler: use -(sy before flipping), since the screen-space furthest points are drawn first.
  const quads = [];
  for (let i = 0; i < G - 1; i++) {
    for (let j = 0; j < G - 1; j++) {
      const p00 = proj[i][j];
      const p10 = proj[i + 1][j];
      const p11 = proj[i + 1][j + 1];
      const p01 = proj[i][j + 1];
      const avgZ = (grid[i][j].total + grid[i + 1][j].total + grid[i + 1][j + 1].total + grid[i][j + 1].total) / 4;
      // Painter sort key: want further-from-camera drawn first.
      // In our projection, higher (sy before flip) = further back on screen. We flipped so smaller y = further back.
      // Depth key = average sy (pre-flip). Sort ascending = back-to-front when we flip y.
      const depth = (p00.sy + p10.sy + p11.sy + p01.sy) / 4;
      quads.push({ p00, p10, p11, p01, avgZ, depth });
    }
  }
  // Draw from smallest sy to largest sy (further back first in world, but closer to top after flip).
  // After flipping, smaller pre-flip sy → larger screen y (bottom). Painter's algorithm wants
  // far-back drawn first. Far-back in screen space = upper region = smaller y after flip.
  // To draw upper region first, sort quads by toScreen(p).y descending... wait:
  // Actually, simplest: we want quads closer to the "front" (lower-left in world coords after rotation)
  // to be drawn LAST so they paint over things behind them. After flipping, "front" corresponds
  // to larger screen y (bottom of the plot). Sort ascending by depth (pre-flip sy) — smaller depth
  // = further back pre-flip = bottom of screen after flip — no wait, that's also wrong.
  // Just test: pre-flip sy values: back of scene has larger sy (higher up in world).
  // After flip (y = maxY - sy) * scale, back of scene has smaller screen y (top of plot).
  // We want to paint back first, so draw quads with smaller screen y first.
  // That means sort by screen-y ASCENDING (top first).
  // Equivalently: sort by depth DESCENDING (pre-flip sy larger first).
  quads.sort((a, b) => b.depth - a.depth);

  // Numerical percolation contour on the base plane — passed in as {rho, v} points.
  // Computed from the actual topology + capability/subscription modes; on scale-free
  // graphs and under hub/periphery modes this differs sharply from the analytic
  // mean-field curve v = 1 − 1/(ρ⟨k⟩).
  const contourPts = (contourPoints || [])
    .filter((p) => p.v >= 0 && p.v <= 1)
    .map((p) => project(p.rho, p.v, 0));

  // Axis box edges drawn on floor and backwall.
  const axisEdges = [
    // Floor perimeter
    [project(0, 0, 0), project(1, 0, 0)],
    [project(1, 0, 0), project(1, 1, 0)],
    [project(1, 1, 0), project(0, 1, 0)],
    [project(0, 1, 0), project(0, 0, 0)],
    // Vertical z-axis (at origin)
    [project(0, 0, 0), project(0, 0, 1)],
  ];

  const axisTicks = [0, 0.25, 0.5, 0.75, 1.0];

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ background: '#fafaf9', display: 'block' }}
    >
      {/* Axis box */}
      {axisEdges.map((edge, i) => {
        const a = toScreen(edge[0]);
        const b = toScreen(edge[1]);
        return (
          <line
            key={`ae${i}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="#a8a29e"
            strokeWidth={1}
          />
        );
      })}

      {/* Mean-field percolation contour on the floor */}
      {contourPts.length > 1 && (
        <path
          d={contourPts
            .map((p, i) => {
              const s = toScreen(p);
              return `${i === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
            })
            .join(' ')}
          fill="none"
          stroke="#57534e"
          strokeWidth={1.25}
          strokeDasharray="4 3"
        />
      )}

      {/* Surface quads */}
      {quads.map((q, i) => {
        const a = toScreen(q.p00);
        const b = toScreen(q.p10);
        const c = toScreen(q.p11);
        const d = toScreen(q.p01);
        return (
          <polygon
            key={`q${i}`}
            points={`${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`}
            fill={colorFor(q.avgZ)}
            stroke="#44403c"
            strokeWidth={0.4}
            strokeLinejoin="round"
          />
        );
      })}

      {/* Axis tick labels on floor and z-axis */}
      {axisTicks.map((t, i) => {
        const pRho = toScreen(project(t, 0, 0));
        const pV = toScreen(project(0, t, 0));
        const pZ = toScreen(project(0, 0, t));
        return (
          <g key={`tick${i}`} fontSize={9} fontFamily="ui-monospace, monospace" fill="#57534e">
            {/* ρ ticks along front edge */}
            <text x={pRho.x} y={pRho.y + 12} textAnchor="middle">
              {t.toFixed(2)}
            </text>
            {/* v ticks along side edge */}
            <text x={pV.x - 6} y={pV.y + 3} textAnchor="end">
              {t.toFixed(2)}
            </text>
            {/* z ticks along vertical axis */}
            <text x={pZ.x - 6} y={pZ.y + 3} textAnchor="end">
              {(t * 100).toFixed(0)}
            </text>
          </g>
        );
      })}

      {/* Axis labels */}
      {(() => {
        const rhoMid = toScreen(project(0.5, 0, 0));
        const vMid = toScreen(project(0, 0.5, 0));
        const zTop = toScreen(project(0, 0, 1));
        return (
          <g fontSize={11} fontFamily="ui-sans-serif, system-ui" fill="#292524">
            <text x={rhoMid.x} y={rhoMid.y + 26} textAnchor="middle">
              Inference density  ρ
            </text>
            <text x={vMid.x - 28} y={vMid.y + 4} textAnchor="end">
              Crowd defense  v
            </text>
            <text x={zTop.x - 8} y={zTop.y - 8} textAnchor="end">
              Compromise rate (%)
            </text>
          </g>
        );
      })()}
    </svg>
  );
}

