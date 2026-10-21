/**
 * hopcroft.js
 * Hopcroft-Karp maximum bipartite matching.
 *
 * Used to compute true one-to-one match ratios between input peaks (set A)
 * and database peaks for a given accession (set B).  Each input peak may
 * only be matched to one DB peak and vice-versa, preventing a single
 * experimental peak from inflating the hit count by matching multiple
 * nearby DB peaks.
 *
 * This is a clean JS port of the bash hopcroft_karp_match() function.
 * The integer-scaling trick from the bash version is unnecessary here
 * because JS Number arithmetic is exact enough for ppm comparisons at
 * the precisions used (2 d.p. for 1H, 1 d.p. for X nuclei).
 *
 * Public API:
 *   hopcroftKarp(peaksA, peaksB, tolerance) → number
 *
 *   peaksA   – Array<number>  experimental peaks (input)
 *   peaksB   – Array<number>  database peaks for one accession
 *   tolerance – number        matching tolerance in ppm
 *   returns   – integer       size of maximum matching
 */

const INF = Infinity;

  /**
   * Build an adjacency list: adj[i] = array of j indices where
   * |peaksA[i] - peaksB[j]| <= tolerance.
   */
  function buildAdj(peaksA, peaksB, tolerance) {
    const adj = peaksA.map(() => []);
    for (let i = 0; i < peaksA.length; i++) {
      for (let j = 0; j < peaksB.length; j++) {
        if (Math.abs(peaksA[i] - peaksB[j]) <= tolerance) {
          adj[i].push(j);
        }
      }
    }
    return adj;
  }

  /**
   * BFS phase: build layered graph from all free A-nodes.
   * Returns true if any augmenting path exists.
   */
  function bfs(adj, pairA, pairB, dist) {
    const nA = pairA.length;
    const queue = [];

    for (let i = 0; i < nA; i++) {
      if (pairA[i] === -1) {
        dist[i] = 0;
        queue.push(i);
      } else {
        dist[i] = INF;
      }
    }

    let found = false;
    let head = 0;

    while (head < queue.length) {
      const u = queue[head++];
      for (const v of adj[u]) {
        const w = pairB[v];          // A-node currently matched to B-node v
        if (w === -1) {
          found = true;              // free B-node reachable → path exists
        } else if (dist[w] === INF) {
          dist[w] = dist[u] + 1;
          queue.push(w);
        }
      }
    }

    return found;
  }

  /**
   * DFS phase: try to find an augmenting path from A-node u.
   * Returns true if successful.
   */
  function dfs(u, adj, pairA, pairB, dist) {
    for (const v of adj[u]) {
      const w = pairB[v];
      if (w === -1 || (dist[w] === dist[u] + 1 && dfs(w, adj, pairA, pairB, dist))) {
        pairA[u] = v;
        pairB[v] = u;
        return true;
      }
    }
    dist[u] = INF;   // remove u from layered graph so it isn't revisited
    return false;
  }

  /**
   * Compute the maximum one-to-one matching between two peak lists.
   *
   * @param {number[]} peaksA     - experimental peaks
   * @param {number[]} peaksB     - database peaks for one accession
   * @param {number}   tolerance  - ppm tolerance
   * @returns {number}            - size of maximum matching
   */
  function hopcroftKarp(peaksA, peaksB, tolerance) {
    if (!peaksA.length || !peaksB.length) return 0;

    const nA = peaksA.length;
    const nB = peaksB.length;

    const adj   = buildAdj(peaksA, peaksB, tolerance);
    const pairA = new Array(nA).fill(-1);  // pairA[i] = j matched to A-node i, or -1
    const pairB = new Array(nB).fill(-1);  // pairB[j] = i matched to B-node j, or -1
    const dist  = new Array(nA).fill(INF);

    let matching = 0;

    while (bfs(adj, pairA, pairB, dist)) {
      for (let i = 0; i < nA; i++) {
        if (pairA[i] === -1) {
          if (dfs(i, adj, pairA, pairB, dist)) {
            matching++;
          }
        }
      }
    }

    return matching;
  }

  /**
   * Compute the Hopcroft-Karp match ratio for a candidate accession.
   * This is the value displayed as "HK match ratio" in the results.
   *
   * @param {number[]} inputPeaks    - parsed experimental peaks (1D or f1 only for 2D)
   * @param {number[]} dbPeaks       - all peaks for this accession in the DB
   * @param {number}   totalDbPeaks  - denominator (total peaks in DB for this nucleus)
   * @param {number}   tolerance     - ppm tolerance
   * @returns {{ matched: number, total: number, ratio: number }}
   */
  function matchRatio(inputPeaks, dbPeaks, totalDbPeaks, tolerance) {
    const matched = hopcroftKarp(inputPeaks, dbPeaks, tolerance);
    const total   = totalDbPeaks || 0;
    const ratio   = total > 0 ? matched / total : 0;
    return { matched, total, ratio };
  }

export { hopcroftKarp, matchRatio };
