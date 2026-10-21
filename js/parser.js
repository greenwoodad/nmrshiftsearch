/**
 * parser.js
 * Parses NMR peak list input into a normalized array of peaks.
 *
 * Supported formats (mirrors bash script logic):
 *   - Topspin peaklist.xml  (1D Peak1D or 2D Peak2D)
 *   - Topspin peak.txt      (1D or 2D table with F2[ppm] header)
 *   - MNova copy-table text (1D with 'ppm' header, 2D with 'f2' header)
 *   - Plain list            (one number per line for 1D, two comma/space-
 *                            separated numbers per line for 2D)
 *
 * All public functions return:
 *   {
 *     dimension: '1D' | '2D',
 *     peaks: Array<number>          // 1D: [ppm, ...]
 *         or Array<[ppm1, ppm2]>    // 2D: [[f1, f2], ...]  f1=1H, f2=X
 *   }
 *
 * Peaks are sorted low-to-high on f1 (the direct / 1H dimension).
 * TMS peaks (both dimensions within their respective tolerances of 0) are removed.
 */

// ── Formatting helpers ───────────────────────────────────────────────────

  const PREC_1H  = 2;   // decimal places for 1H  (matches bash %0.2f)
  const PREC_X   = 1;   // decimal places for 13C / X nucleus (%0.1f)

  function round(val, decimals) {
    const f = 10 ** decimals;
    return Math.round(val * f) / f;
  }

  // ── TMS filter ───────────────────────────────────────────────────────────

  function isTMS(peak, tol1 = 0.03, tol2 = 0.3) {
    if (Array.isArray(peak)) {
      return Math.abs(peak[0]) <= tol1 && Math.abs(peak[1]) <= tol2;
    }
    return Math.abs(peak) <= tol1;
  }

  // ── Deduplication ────────────────────────────────────────────────────────

  function dedup1D(peaks) {
    const seen = new Set();
    return peaks.filter(p => {
      const k = p.toFixed(PREC_1H);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function dedup2D(peaks) {
    const seen = new Set();
    return peaks.filter(([f1, f2]) => {
      const k = `${f1.toFixed(PREC_1H)},${f2.toFixed(PREC_X)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ── Format and sort ──────────────────────────────────────────────────────

  function finalise1D(raw) {
    let peaks = raw
      .map(v => round(v, PREC_1H))
      .filter(v => !isTMS(v));
    peaks = dedup1D(peaks);
    peaks.sort((a, b) => a - b);
    return { dimension: '1D', peaks };
  }

  function finalise2D(raw) {
    let peaks = raw
      .map(([f1, f2]) => [round(f1, PREC_1H), round(f2, PREC_X)])
      .filter(p => !isTMS(p));
    peaks = dedup2D(peaks);
    peaks.sort((a, b) => a[0] - b[0]);
    return { dimension: '2D', peaks };
  }

  // ── Topspin XML parser ───────────────────────────────────────────────────

  function parseXml(xmlString) {
    const doc = new DOMParser().parseFromString(xmlString, 'application/xml');

    // 1D: <Peak1D F1="..." intensity="...">
    const peaks1D = doc.querySelectorAll('Peak1D');
    if (peaks1D.length) {
      const raw = [];
      for (const el of peaks1D) {
        const v = parseFloat(el.getAttribute('F1'));
        if (!isNaN(v)) raw.push(v);
      }
      return finalise1D(raw);
    }

    // 2D: <Peak2D F1="..." F2="...">  — Topspin stores F1=indirect(X), F2=direct(1H)
    const peaks2D = doc.querySelectorAll('Peak2D');
    if (peaks2D.length) {
      const raw = [];
      for (const el of peaks2D) {
        const f1 = parseFloat(el.getAttribute('F2')); // 1H (direct)
        const f2 = parseFloat(el.getAttribute('F1')); // X  (indirect)
        if (!isNaN(f1) && !isNaN(f2)) raw.push([f1, f2]);
      }
      return finalise2D(raw);
    }

    throw new Error('XML file does not contain Peak1D or Peak2D elements.');
  }

  // ── Text / plain-list parser ─────────────────────────────────────────────

  function parseTxt(text) {
    const lines = text.split(/\r?\n/);

    // ── Topspin 2D peak.txt: header contains "F2[ppm]"
    {
      const hi = lines.findIndex(l => /F2\[ppm\]/i.test(l));
      if (hi !== -1) {
        const raw = [];
        for (const line of lines.slice(hi + 1)) {
          const cols = line.trim().split(/[\t ,]+/);
          // Topspin 2D peak.txt: col4=F2(1H ppm), col5=F1(X ppm)
          const f1 = parseFloat(cols[4]);
          const f2 = parseFloat(cols[5]);
          if (!isNaN(f1) && !isNaN(f2)) raw.push([f1, f2]);
        }
        if (raw.length) return finalise2D(raw);
      }
    }

    // ── MNova 2D: header contains "f2" (lowercase)
    {
      const hi = lines.findIndex(l => /\bf2\b/i.test(l) && /\bf1\b/i.test(l));
      if (hi !== -1) {
        const raw = [];
        for (const line of lines.slice(hi + 1)) {
          const cols = line.trim().split(/[\t ,]+/);
          // MNova 2D copy-table: col1=f2(1H), col2=f1(X)
          const f1 = parseFloat(cols[1]);
          const f2 = parseFloat(cols[2]);
          if (!isNaN(f1) && !isNaN(f2)) raw.push([f1, f2]);
        }
        if (raw.length) return finalise2D(raw);
      }
    }

    // ── MNova 1D: header contains "ppm"
    {
      const hi = lines.findIndex(l => /\bppm\b/i.test(l));
      if (hi !== -1) {
        const raw = [];
        for (const line of lines.slice(hi + 1)) {
          const cols = line.trim().split(/[\t ,]+/);
          const v = parseFloat(cols[1]);   // MNova 1D: col1 = ppm
          if (!isNaN(v)) raw.push(v);
        }
        if (raw.length) return finalise1D(raw);
      }
    }

    // ── Plain list fallback
    // Each non-empty line is either one number (1D) or two numbers (2D).
    const raw1D = [], raw2D = [];
    for (const line of lines) {
      const clean = line.trim().replace(/,/g, ' ');
      if (!clean) continue;
      const cols = clean.split(/\s+/);
      const a = parseFloat(cols[0]);
      const b = parseFloat(cols[1]);
      if (isNaN(a)) continue;
      if (!isNaN(b)) {
        raw2D.push([a, b]);
      } else {
        raw1D.push(a);
      }
    }

    if (raw2D.length && raw1D.length === 0) return finalise2D(raw2D);
    if (raw1D.length && raw2D.length === 0) return finalise1D(raw1D);
    if (raw2D.length > raw1D.length)        return finalise2D(raw2D);
    if (raw1D.length)                       return finalise1D(raw1D);

    throw new Error('Could not parse any peaks from the input text.');
  }

  // ── Public entry point ───────────────────────────────────────────────────

  /**
   * Parse a peak list from a string.
   *
   * @param {string} text     - raw file contents (XML or text)
   * @param {string} [hint]   - optional filename hint for format detection
   * @returns {{ dimension: string, peaks: Array }}
   */
  function parse(text, hint = '') {
    const trimmed = text.trim();
    if (trimmed.startsWith('<') || hint.endsWith('.xml')) {
      return parseXml(trimmed);
    }
    return parseTxt(trimmed);
  }

  /**
   * Parse a File object (from <input type="file">).
   * Returns a Promise resolving to the same structure as parse().
   */
  function parseFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => {
        try { resolve(parse(e.target.result, file.name)); }
        catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.readAsText(file);
    });
  }

export { parse, parseFile };
