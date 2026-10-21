/**
 * results.js
 * Renders SearchResults into the page DOM and handles post-search filtering.
 *
 * Depends on: search.js output shape, dbLoader.classifyAccession
 * Optional:   rdkit (window.RDKit) for structure thumbnails
 *
 * Public API:
 *   results.render(searchResults, containerEl, options)
 *   results.filter(searchResults, filterOptions) → filtered candidates array
 */

// ── Formatting helpers ───────────────────────────────────────────────────────

  function fmtRatio(candidate) {
    const pct = (candidate.ratio * 100).toFixed(1);
    return `${pct}% (${candidate.matched}/${candidate.totalDbPeaks})`;
  }

  function fmtName(candidate) {
    return candidate.name || '—';
  }

  function sourceLabel(db) {
    return { NP: 'NP-MRD', IMPUR: 'Impurities', NMRBank: 'NMRBank', NMRexp: 'NMRexp' }[db] ?? db;
  }

  function sourceBadgeClass(db) {
    return { NP: 'badge-np', IMPUR: 'badge-impur', NMRBank: 'badge-nmrbank', NMRexp: 'badge-nmrexp' }[db] ?? '';
  }

  // ── Post-search filtering ────────────────────────────────────────────────────

  /**
   * Filter a candidates array by source database.
   *
   * @param {Candidate[]} candidates
   * @param {object} opts
   *   opts.includeDbs  – Set<string> of source DB names to keep
   *                      e.g. new Set(['NP', 'NMRBank'])
   *                      If null/empty, all are kept.
   * @returns {Candidate[]}
   */
  function filter(candidates, opts = {}) {
    const { includeDbs } = opts;
    if (!includeDbs || includeDbs.size === 0) return candidates;
    return candidates.filter(c => includeDbs.has(c.sourceDb));
  }

  // ── Structure thumbnail ──────────────────────────────────────────────────────

  /**
   * Draw a SMILES structure into a <canvas> or <img> element using RDKit.js.
   * Returns null if RDKit is not available or SMILES is empty.
   */
  function drawStructure(smiles, size = 200) {
    if (!smiles || typeof window.RDKit === 'undefined') return null;
    try {
      const mol = window.RDKit.get_mol(smiles);
      if (!mol) return null;
      const svg = mol.get_svg_with_highlights(
        JSON.stringify({ width: size, height: size, addStereoAnnotation: true })
      );
      mol.delete();
      const img = document.createElement('img');
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      img.width  = size;
      img.height = size;
      img.alt    = smiles;
      return img;
    } catch {
      return null;
    }
  }

  // ── Table rendering ──────────────────────────────────────────────────────────

  /**
   * Build and insert the results table into containerEl.
   *
   * @param {SearchResults} searchResults  - output of search.run()
   * @param {HTMLElement}   containerEl    - where to render
   * @param {object}        opts
   *   opts.includeDbs   – Set<string>|null  post-filter by source DB
   *   opts.showStructures – boolean         show structure thumbnails (needs RDKit)
   *   opts.structureSize  – number          px size for thumbnails (default 150)
   */
  function render(searchResults, containerEl, opts = {}) {
    const {
      includeDbs     = null,
      showStructures = true,
      structureSize  = 150,
    } = opts;

    containerEl.innerHTML = '';

    const { candidates, inputPeaks, params } = searchResults;

    if (!candidates.length) {
      containerEl.innerHTML = '<p class="no-results">No matches found.</p>';
      return;
    }

    const displayed = filter(candidates, { includeDbs });

    if (!displayed.length) {
      containerEl.innerHTML = '<p class="no-results">No matches after filtering.</p>';
      return;
    }

    // ── Summary line ──────────────────────────────────────────────────────────
    const summary = document.createElement('p');
    summary.className = 'results-summary';
    summary.textContent =
      `${displayed.length} result${displayed.length !== 1 ? 's' : ''} · ` +
      `${params.nuc1}${params.nuc2 ? '/' + params.nuc2 : ''} · ` +
      `${params.solvent} · ` +
      `tol ${params.tol1} ppm${params.tol2 ? ' / ' + params.tol2 + ' ppm' : ''}`;
    containerEl.appendChild(summary);

    // ── Table ─────────────────────────────────────────────────────────────────
    const table = document.createElement('table');
    table.className = 'results-table';

    // Header
    const thead = table.createTHead();
    const hrow  = thead.insertRow();
    const headers = ['Rank', 'HK Ratio', 'Unique', 'Accession', 'Name', 'MW', 'DB'];
    if (showStructures) headers.push('Structure');
    for (const h of headers) {
      const th = document.createElement('th');
      th.textContent = h;
      hrow.appendChild(th);
    }

    // Body
    const tbody = table.createTBody();
    displayed.forEach((c, idx) => {
      const row = tbody.insertRow();
      row.className = idx % 2 === 0 ? 'row-even' : 'row-odd';
      if (c.uniquePeaks > 0) row.classList.add('row-has-unique');

      const cells = [
        idx + 1,
        fmtRatio(c),
        c.uniquePeaks || '—',
        _accessionCell(c),
        fmtName(c),
        c.molWeight != null ? c.molWeight.toFixed(3) : '—',
        _badgeCell(c),
      ];

      for (const cell of cells) {
        const td = row.insertCell();
        if (cell instanceof HTMLElement) {
          td.appendChild(cell);
        } else {
          td.textContent = String(cell);
        }
      }

      if (showStructures) {
        const td = row.insertCell();
        const img = drawStructure(c.smiles, structureSize);
        if (img) {
          td.appendChild(img);
        } else {
          td.textContent = c.smiles ? '(no renderer)' : '—';
          td.className = 'no-structure';
        }
      }
    });

    containerEl.appendChild(table);

    // ── Download buttons ──────────────────────────────────────────────────────
    const btnRow = document.createElement('div');
    btnRow.className = 'download-row';

    const csvBtn = document.createElement('button');
    csvBtn.textContent = 'Download CSV';
    csvBtn.onclick = () => _downloadCsv(displayed, params);
    btnRow.appendChild(csvBtn);

    containerEl.appendChild(btnRow);
  }

  // ── Cell builders ────────────────────────────────────────────────────────────

  function _accessionCell(c) {
    const a = document.createElement('a');
    a.textContent = c.accession;
    a.href        = _accessionUrl(c);
    a.target      = '_blank';
    a.rel         = 'noopener noreferrer';
    return a;
  }

  function _accessionUrl(c) {
    switch (c.sourceDb) {
      case 'NP':      return `https://np-mrd.org/natural_products/${c.accession}`;
      case 'NMRBank': return `https://www.ncbi.nlm.nih.gov/pmc/articles/${c.accession}/`;
      case 'NMRexp':  return `https://doi.org/${c.accession.replace(/_/g, '/')}`;
      case 'IMPUR':   return '#';   // no external URL for impurity table entries
      default:        return '#';
    }
  }

  function _badgeCell(c) {
    const span = document.createElement('span');
    span.className = `badge ${sourceBadgeClass(c.sourceDb)}`;
    span.textContent = sourceLabel(c.sourceDb);
    return span;
  }

  // ── CSV export ───────────────────────────────────────────────────────────────

  function _downloadCsv(candidates, params) {
    const header = [
      'Rank', 'Accession', 'Name', 'HK_ratio', 'Matched', 'Total_DB_peaks',
      'Unique_peaks', 'Mol_weight', 'Source_DB', 'SMILES'
    ].join(',');

    const rows = candidates.map((c, i) => [
      i + 1,
      `"${c.accession}"`,
      `"${(c.name || '').replace(/"/g, '""')}"`,
      c.ratio.toFixed(4),
      c.matched,
      c.totalDbPeaks,
      c.uniquePeaks,
      c.molWeight != null ? c.molWeight.toFixed(3) : '',
      c.sourceDb,
      `"${(c.smiles || '').replace(/"/g, '""')}"`,
    ].join(','));

    const csv  = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `nmrdbsearch_${params.nuc1}_${params.solvent}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Progress bar helper ──────────────────────────────────────────────────────

  /**
   * Update a <progress> element and an optional label.
   * Designed to be passed as the onProgress callback to search.run().
   *
   * @param {HTMLProgressElement} progressEl
   * @param {HTMLElement|null}    labelEl
   * @returns {function(fraction, message)}
   */
  function makeProgressCallback(progressEl, labelEl = null) {
    return (fraction, message) => {
      progressEl.value = Math.min(1, Math.max(0, fraction));
      if (labelEl) labelEl.textContent = message ?? '';
    };
  }

// ── Exports ──────────────────────────────────────────────────────────────────

export { render, filter, drawStructure, makeProgressCallback };
