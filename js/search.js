/**
 * search.js
 * Main search orchestration — replaces the bash main loop.
 *
 * Depends on: dbLoader.js, hopcroft.js
 *
 * Public API:
 *   search.run(params)  →  Promise<SearchResults>
 *
 * params = {
 *   peaks:      Array<number> | Array<[number,number]>  // from parser.js
 *   dimension:  '1D' | '2D'
 *   nuc1:       '1H' | '13C' | '31P' | '19F' | '11B' | '29Si'
 *   nuc2:       string | null   // indirect dimension nucleus for 2D
 *   solvent:    string          // canonical solvent string e.g. 'CDCl3'
 *   tolerance1: number          // ppm tolerance for nuc1 (default: see DEFAULTS)
 *   tolerance2: number          // ppm tolerance for nuc2 (2D only)
 *   maxResults: number          // how many candidates to return (default 20)
 *   onProgress: function|null   // callback(fraction 0–1, message)
 * }
 *
 * SearchResults = {
 *   candidates: Array<Candidate>   // sorted by HK ratio descending
 *   inputPeaks: Array              // normalised input peaks (for display)
 *   params:     object             // echo of params used
 * }
 *
 * Candidate = {
 *   accessionId:   number
 *   accession:     string
 *   sourceDb:      string          // 'NP' | 'IMPUR' | 'NMRBank' | 'NMRexp'
 *   hitCount:      number          // raw peak hits before HK
 *   matched:       number          // HK matched peaks
 *   totalDbPeaks:  number          // denominator from summary
 *   ratio:         number          // matched / totalDbPeaks
 *   uniquePeaks:   number          // input peaks for which this is the ONLY match
 *   molWeight:     number
 *   smiles:        string
 *   name:          string
 * }
 */

import * as db       from './dbLoader.js';
import { matchRatio } from './hopcroft.js';

// ── Defaults ────────────────────────────────────────────────────────────────

  const DEFAULTS = {
    tolerance1: { '1H': 0.03, '13C': 0.3,  '31P': 1.0, '19F': 1.0, '11B': 1.0, '29Si': 1.0 },
    tolerance2: { '13C': 0.3, '31P': 1.0,  '19F': 1.0, '11B': 1.0, '29Si': 1.0 },
    maxResults:    20,
    hkCandidates: 60,   // run HK on top N by raw hit count (matches bash's cutoff = maxresults+40)
  };

  // SQLite IN() clause limit — chunk large ID arrays to stay under this
  const SQLITE_PARAM_LIMIT = 900;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function noop() {}

  function toleranceFor(nuc, overrides, key) {
    return overrides?.[key] ?? DEFAULTS[key][nuc] ?? 1.0;
  }

  /** Split an array into chunks of at most `size`. */
  function chunks(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /**
   * Batch-query summary DB in chunks to stay under SQLite param limit.
   * Returns a merged Map<id, summaryRow>.
   */
  async function batchQuerySummary(solvent, idSet, isHetnuc) {
    const idArr = [...idSet];
    const result = new Map();
    for (const chunk of chunks(idArr, SQLITE_PARAM_LIMIT)) {
      const partial = isHetnuc
        ? await db.queryHetnucSummary(solvent, chunk)
        : await db.querySummary(solvent, chunk);
      for (const [k, v] of partial) result.set(k, v);
    }
    return result;
  }

  /**
   * Get the peak count denominator for a given nucleus from a summary row.
   */
  function peakCount(summaryRow, nuc) {
    switch (nuc) {
      case '1H':   return summaryRow.count_1H  ?? 0;
      case '13C':  return summaryRow.count_13C ?? 0;
      case '31P':  return summaryRow.count_31P ?? 0;
      case '19F':  return summaryRow.count_19F ?? 0;
      case '11B':  return summaryRow.count_11B ?? 0;
      case '29Si': return summaryRow.count_29Si ?? 0;
      default:     return 0;
    }
  }

  // ── Main search function ────────────────────────────────────────────────────

  /**
   * Run a full database search.
   *
   * @param {object} params  - see module header
   * @returns {Promise<SearchResults>}
   */
  async function run(params) {
    const {
      peaks,
      dimension,
      nuc1,
      nuc2       = null,
      solvent,
      maxResults = DEFAULTS.maxResults,
      onProgress = noop,
    } = params;

    const tol1 = toleranceFor(nuc1, params, 'tolerance1');
    const tol2 = nuc2 ? toleranceFor(nuc2, params, 'tolerance2') : null;

    // Hetnuc nuclei use the hetnuc summary table
    const isHetnuc = ['31P', '19F', '11B', '29Si'].includes(nuc1);

    // ── Phase 1: Per-peak database search ─────────────────────────────────────
    // hitCounts:   Map<accessionId, number>   raw hit count
    // uniqueCounts: Map<accessionId, number>  peaks for which this is only match
    // dbShiftMap:  Map<accessionId, Set<number>>  DB shifts that matched (for HK)
    // inputMatchMap: Map<accessionId, Set<number>> input peaks that matched (for HK)

    const hitCounts      = new Map();
    const uniqueCounts   = new Map();
    const dbShiftMap     = new Map();   // accId → Set of DB shift values
    const inputMatchMap  = new Map();   // accId → Set of input peak values (f1)

    const totalPeaks = peaks.length;
    onProgress(0, 'Searching database…');

    for (let pi = 0; pi < peaks.length; pi++) {
      const peak = peaks[pi];

      // Compute query windows
      const f1 = Array.isArray(peak) ? peak[0] : peak;
      const f2 = Array.isArray(peak) ? peak[1] : null;

      const f1Min = f1 - tol1;
      const f1Max = f1 + tol1;

      // Query nuc1 peak shard
      const f1Hits = await db.queryPeaksWithShifts(nuc1, solvent, f1Min, f1Max);

      let peakHitIds;   // Set<number> of accession IDs matching this peak/pair

      if (dimension === '2D' && f2 !== null && nuc2) {
        // 2D: intersect f1 hits with f2 hits
        const f2Min = f2 - tol2;
        const f2Max = f2 + tol2;
        const f2HitIds = await db.queryPeaks(nuc2, solvent, f2Min, f2Max);

        peakHitIds = new Set();
        for (const { shift, id } of f1Hits) {
          if (f2HitIds.has(id)) {
            peakHitIds.add(id);
            // Record DB shift for HK (f1 dimension only, matching bash behaviour)
            if (!dbShiftMap.has(id)) dbShiftMap.set(id, new Set());
            dbShiftMap.get(id).add(shift);
          }
        }
      } else {
        // 1D
        peakHitIds = new Set();
        for (const { shift, id } of f1Hits) {
          peakHitIds.add(id);
          if (!dbShiftMap.has(id)) dbShiftMap.set(id, new Set());
          dbShiftMap.get(id).add(shift);
        }
      }

      // Accumulate hit counts (each accession counted once per peak, not per DB shift)
      for (const id of peakHitIds) {
        hitCounts.set(id, (hitCounts.get(id) ?? 0) + 1);
        if (!inputMatchMap.has(id)) inputMatchMap.set(id, new Set());
        inputMatchMap.get(id).add(f1);
      }

      // Track unique hits (this peak matches exactly one accession)
      if (peakHitIds.size === 1) {
        const [onlyId] = peakHitIds;
        uniqueCounts.set(onlyId, (uniqueCounts.get(onlyId) ?? 0) + 1);
      }

      onProgress((pi + 1) / totalPeaks * 0.5, `Searched peak ${pi + 1} of ${totalPeaks}`);
    }

    if (hitCounts.size === 0) {
      return { candidates: [], inputPeaks: peaks, params };
    }

    // ── Phase 2: Rank by raw hit count, take top candidates for HK ────────────

    const hkCandidateCount = maxResults + DEFAULTS.hkCandidates;
    const sortedByHits = [...hitCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, hkCandidateCount);

    const topIds = new Set(sortedByHits.map(([id]) => id));

    // ── Phase 3: Batch-fetch summary data ─────────────────────────────────────

    onProgress(0.55, 'Loading compound data…');
    const summaryMap = await batchQuerySummary(solvent, topIds, isHetnuc);

    // ── Phase 4: Decode accession IDs → strings ───────────────────────────────

    onProgress(0.65, 'Decoding accessions…');

    // ── Phase 5: Hopcroft-Karp one-to-one matching for top candidates ─────────

    onProgress(0.7, 'Computing match ratios…');

    const inputF1Peaks = peaks.map(p => Array.isArray(p) ? p[0] : p);

    const candidates = [];

    for (let ci = 0; ci < sortedByHits.length; ci++) {
      const [accId, rawHits] = sortedByHits[ci];
      const summary = summaryMap.get(accId);
      if (!summary) continue;   // accession not in summary DB — skip

      const accession    = db.idToName(accId) ?? String(accId);
      const sourceDb     = db.classifyAccession(accession);
      const totalDbPeaks = peakCount(summary, nuc1);

      // DB peaks that matched any input peak for this accession
      const dbPeaksForAcc = [...(dbShiftMap.get(accId) ?? [])];

      // Input peaks that matched this accession
      const inputPeaksForAcc = [...(inputMatchMap.get(accId) ?? [])];

      const { matched, ratio } = matchRatio(
        inputPeaksForAcc,
        dbPeaksForAcc,
        totalDbPeaks,
        tol1
      );

      candidates.push({
        accessionId:  accId,
        accession,
        sourceDb,
        hitCount:     rawHits,
        matched,
        totalDbPeaks,
        ratio,
        uniquePeaks:  uniqueCounts.get(accId) ?? 0,
        molWeight:    summary.mol_weight ?? null,
        smiles:       summary.smiles     ?? '',
        name:         summary.name       ?? '',
      });

      onProgress(0.7 + (ci / sortedByHits.length) * 0.25,
                 `Matching ${ci + 1} of ${sortedByHits.length}…`);
    }

    // ── Phase 6: Final sort by HK ratio, trim to maxResults ───────────────────

    candidates.sort((a, b) => b.ratio - a.ratio || b.matched - a.matched);
    const finalCandidates = candidates.slice(0, maxResults);

    onProgress(1.0, 'Done');

    return {
      candidates: finalCandidates,
      inputPeaks: peaks,
      params: { nuc1, nuc2, solvent, tol1, tol2, dimension, maxResults },
    };
  }

// ── Exports ──────────────────────────────────────────────────────────────────

export { run };
