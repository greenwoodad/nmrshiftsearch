/**
 * dbLoader.js
 * Fetches, caches, and queries the SQLite shard databases.
 * All public functions are async and return plain JS objects/arrays.
 *
 * Depends on sql.js being loaded globally as window.SQL (initSqlJs).
 * Call dbLoader.init() once before anything else.
 */

// ── Constants ────────────────────────────────────────────────────────────

  const DB_PATH = 'https://cdn.jsdelivr.net/gh/greenwoodad/nmrshiftsearch@main/DBs/';

  // Shard split rules for peak files.
  // Each entry: { shards: [ {suffix, min, max}, ... ] }
  // min/max are the VALUE ranges stored in that shard (null = no bound).
  // A query window [qMin, qMax] hits a shard if qMax >= shard.min && qMin <= shard.max.
  const SHARD_RULES = {
    '1H_CDCl3':  twoWay(5.0),
    '1H_all':    twoWay(5.0),
    '13C_CDCl3': threeWay(100.0, 135.0),
    '13C_all':   threeWay(100.0, 135.0),
  };

  function twoWay(split) {
    return [
      { suffix: '_part1', min: -Infinity, max: split },
      { suffix: '_part2', min: split,     max: Infinity },
    ];
  }

  function threeWay(s1, s2) {
    return [
      { suffix: '_part1', min: -Infinity, max: s1 },
      { suffix: '_part2', min: s1,        max: s2 },
      { suffix: '_part3', min: s2,        max: Infinity },
    ];
  }

  // ── State ────────────────────────────────────────────────────────────────

  let SQL = null;                        // sql.js module instance
  const dbCache = new Map();             // filename → sql.js Database object
  let idToAccession = null;              // Map<number, string>  (loaded once)
  let accessionToId = null;              // Map<string, number>  (loaded once)

  // ── Initialisation ───────────────────────────────────────────────────────

  /**
   * Must be called once before any other function.
   * Initialises sql.js and pre-loads the two dict shards into memory.
   */
  async function init(sqlJsConfig = {}) {
    SQL = await initSqlJs(sqlJsConfig);
    await _loadDictShards();
  }

  async function _loadDictShards() {
    idToAccession = new Map();
    accessionToId = new Map();
    for (const fname of ['dict_part1.db', 'dict_part2.db']) {
      const db = await _openDb(fname);
      const rows = db.exec('SELECT id, name FROM accessions');
      if (rows.length && rows[0].values) {
        for (const [id, name] of rows[0].values) {
          idToAccession.set(id, name);
          accessionToId.set(name, id);
        }
      }
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  async function _openDb(filename) {
    if (dbCache.has(filename)) return dbCache.get(filename);
    const url = DB_PATH + filename;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const db  = new SQL.Database(new Uint8Array(buf));
    dbCache.set(filename, db);
    return db;
  }

  /**
   * Returns the list of shard filenames to query for a given nucleus+solvent
   * combination and a [qMin, qMax] tolerance window.
   * Handles the case where the window straddles a shard boundary.
   */
  function _shardsForQuery(nuc, solvent, qMin, qMax) {
    const key = `${nuc}_${solvent}`;
    const rules = SHARD_RULES[key];

    if (!rules) {
      // Single unsplit file
      return [`peaks_${nuc}_${solvent}.db`];
    }

    return rules
      .filter(s => qMax >= s.min && qMin <= s.max)
      .map(s => `peaks_${nuc}_${solvent}${s.suffix}.db`);
  }

  /**
   * Decodes a comma-joined id_list string into an array of integers.
   * e.g. "42,187,3901" → [42, 187, 3901]
   */
  function _decodeIdList(idListStr) {
    if (!idListStr) return [];
    return idListStr.split(',').map(Number);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Query peak shards for a single nucleus within a tolerance window.
   *
   * @param {string} nuc     - e.g. '1H', '13C', '31P'
   * @param {string} solvent - e.g. 'CDCl3', 'all'
   * @param {number} qMin    - lower bound of tolerance window (ppm)
   * @param {number} qMax    - upper bound of tolerance window (ppm)
   * @returns {Promise<Set<number>>} - Set of matching accession integer IDs
   */
  async function queryPeaks(nuc, solvent, qMin, qMax) {
    const shardFiles = _shardsForQuery(nuc, solvent, qMin, qMax);
    const resultIds  = new Set();

    for (const fname of shardFiles) {
      let db;
      try {
        db = await _openDb(fname);
      } catch (e) {
        console.warn(`Skipping missing shard: ${fname}`);
        continue;
      }

      const rows = db.exec(
        'SELECT id_list FROM main_lookup WHERE number_id BETWEEN ? AND ?',
        [qMin, qMax]
      );

      if (rows.length && rows[0].values) {
        for (const [idListStr] of rows[0].values) {
          for (const id of _decodeIdList(idListStr)) {
            resultIds.add(id);
          }
        }
      }
    }

    return resultIds;
  }

  /**
   * Query peak shards and also return the matching DB shift values
   * alongside their accession IDs. Needed for Hopcroft-Karp matching.
   *
   * @returns {Promise<Array<{shift: number, id: number}>>}
   */
  async function queryPeaksWithShifts(nuc, solvent, qMin, qMax) {
    const shardFiles = _shardsForQuery(nuc, solvent, qMin, qMax);
    const results    = [];   // [{shift, id}, ...]
    const seen       = new Set();  // deduplicate shift+id pairs

    for (const fname of shardFiles) {
      let db;
      try {
        db = await _openDb(fname);
      } catch (e) {
        console.warn(`Skipping missing shard: ${fname}`);
        continue;
      }

      const rows = db.exec(
        'SELECT number_id, id_list FROM main_lookup WHERE number_id BETWEEN ? AND ?',
        [qMin, qMax]
      );

      if (rows.length && rows[0].values) {
        for (const [shift, idListStr] of rows[0].values) {
          for (const id of _decodeIdList(idListStr)) {
            const key = `${shift}:${id}`;
            if (!seen.has(key)) {
              seen.add(key);
              results.push({ shift, id });
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Look up summary data for a set of accession integer IDs.
   * Queries the standard summary DB (1H + 13C counts).
   *
   * @param {string}       solvent     - e.g. 'CDCl3'
   * @param {Iterable<number>} ids     - accession integer IDs to look up
   * @returns {Promise<Map<number, object>>} - id → {count_1H, count_13C, mol_weight, smiles, name}
   */
  async function querySummary(solvent, ids) {
    const idArr = [...ids];
    if (!idArr.length) return new Map();

    const result = new Map();
    // Summary may be split into _part1 / _part2 if very large
    const candidates = [
      `database_summary_${solvent}.db`,
      `database_summary_${solvent}_part1.db`,
      `database_summary_${solvent}_part2.db`,
    ];

    for (const fname of candidates) {
      let db;
      try { db = await _openDb(fname); }
      catch { continue; }  // file doesn't exist for this solvent — skip

      const placeholders = idArr.map(() => '?').join(',');
      const rows = db.exec(
        `SELECT accession_id, count_1H, count_13C, mol_weight, smiles, name
         FROM summary WHERE accession_id IN (${placeholders})`,
        idArr
      );

      if (rows.length && rows[0].values) {
        for (const [accId, c1H, c13C, mw, smiles, name] of rows[0].values) {
          result.set(accId, { count_1H: c1H, count_13C: c13C,
                              mol_weight: mw, smiles, name });
        }
      }
    }

    return result;
  }

  /**
   * Look up hetnuc summary data for a set of accession integer IDs.
   * Used when nuc1 is 31P, 19F, 11B, or 29Si.
   *
   * @returns {Promise<Map<number, object>>}
   *   id → {count_1H, count_13C, count_31P, count_19F, count_11B, count_29Si, mol_weight, smiles, name}
   */
  async function queryHetnucSummary(solvent, ids) {
    const idArr = [...ids];
    if (!idArr.length) return new Map();

    const result = new Map();
    const fname  = `database_summary_${solvent}_hetnuc.db`;

    let db;
    try { db = await _openDb(fname); }
    catch { return result; }

    const placeholders = idArr.map(() => '?').join(',');
    const rows = db.exec(
      `SELECT accession_id, count_1H, count_13C, count_31P, count_19F,
              count_11B, count_29Si, mol_weight, smiles, name
       FROM hetnuc_summary WHERE accession_id IN (${placeholders})`,
      idArr
    );

    if (rows.length && rows[0].values) {
      for (const [accId, c1H, c13C, c31P, c19F, c11B, c29Si, mw, smiles, name]
           of rows[0].values) {
        result.set(accId, {
          count_1H: c1H, count_13C: c13C,
          count_31P: c31P, count_19F: c19F,
          count_11B: c11B, count_29Si: c29Si,
          mol_weight: mw, smiles, name
        });
      }
    }

    return result;
  }

  /**
   * Convert an integer accession ID → accession string.
   * Uses the in-memory dict cache loaded at init().
   */
  function idToName(id) {
    return idToAccession.get(id) ?? null;
  }

  /**
   * Convert an accession string → integer ID.
   */
  function nameToId(name) {
    return accessionToId.get(name) ?? null;
  }

  /**
   * Identify which source database an accession string belongs to.
   * Returns 'NP', 'IMPUR', 'NMRBank', 'NMRexp', or 'unknown'.
   */
  function classifyAccession(accession) {
    if (accession.startsWith('NP-'))   return 'NP';
    if (accession.startsWith('IMPUR')) return 'IMPUR';
    if (accession.startsWith('PMC'))   return 'NMRBank';
    if (/^\d/.test(accession))         return 'NMRexp';
    return 'unknown';
  }

// ── Exports ──────────────────────────────────────────────────────────────

export {
  init,
  queryPeaks,
  queryPeaksWithShifts,
  querySummary,
  queryHetnucSummary,
  idToName,
  nameToId,
  classifyAccession,
};
