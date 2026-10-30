# nmrshiftsearch

A browser-based NMR database search tool. Enter a peak list, select a nucleus and solvent, and search a combined database of ~1.9M unique compounds for structural matches. No installation required — runs entirely in your browser.

**[Launch nmrshiftsearch](https://greenwoodad.github.io/nmrshiftsearch/)**

---

## Databases

nmrshiftsearch searches four databases simultaneously:

| Database | Description |
|---|---|
| [NP-MRD](https://np-mrd.org/) | Natural products magnetic resonance database |
| [NMRBank](https://doi.org/10.1039/D4SC08802F) | Open NMR data repository produced with NMRExtractor |
| [NMRexp](https://doi.org/10.1038/s41597-025-06245-5) | Experimental NMR data repository including 19F/31P/11B/29Si shifts |
| [Fulmer et al.](https://doi.org/10.1021/om100106e) | Common trace impurity shifts |

Combined coverage: ~24M (¹³C), ~16M (¹H), ~265k (¹⁹F), ~35k (³¹P), ~17k (¹¹B), ~3k (²⁹Si) peaks across ~1.9M unique compounds.

---

## Supported Data Types

- **1D:** ¹H, ¹³C, ³¹P, ¹⁹F, ¹¹B, ²⁹Si
- **2D:** ¹H/X (HMBC/HSQC type spectra)

---

## Usage

### 1. Enter your peak list

Paste peaks directly into the input box, or upload a file. Accepted formats:

- **Plain list** — one shift per line (1D) or two comma- or space-separated shifts per line (2D, direct dimension first)
- **Topspin** — `peaklist.xml` (1D or 2D) or `peak.txt`
- **MNova** — paste the full peak table including header (use *Copy Table* in the peaks panel)

Peaks should be referenced to TMS. For ¹³C spectra in D₂O, it may be worth trying both direct (TSP/DSS) and indirect (²H lock → TMS) referencing, as database entries are not fully consistent.

For **1D ¹H** data, pick peaks at the center of each multiplet. For other decoupled 1D spectra, automated peak picking is usually sufficient but should be checked. For nuclei split by ³¹P or ¹⁹F, pick multiplet centers.

For **2D** data, pick peaks with both the ¹H and X spectra visible to achieve ~0.1 ppm resolution in the X dimension. MNova's peak-by-peak picking (Shift+click) works well for this.

### 2. Select nucleus and solvent

Choose the direct nucleus (and indirect nucleus for 2D data) and the solvent your spectrum was collected in. The databases are approximately 89% CDCl₃, 8% DMSO, and 3% other solvents, so the best results are expected for CDCl₃ data.

### 3. Set tolerances (optional)

Default tolerances are ±0.03 ppm (¹H), ±0.3 ppm (¹³C), and ±1.0 ppm (³¹P, ¹⁹F, ¹¹B, ²⁹Si). These can be overridden in the settings panel.

### 4. Search

Click **Search**. Results appear ranked by Hopcroft–Karp (HK) match ratio — the number of one-to-one peak matches divided by the total number of peaks for that compound in the database.

---

## Understanding Results

### Match ratio

The HK match ratio is the primary ranking metric. It is computed by Hopcroft–Karp bipartite matching, which enforces one-to-one correspondence: a queried peak cannot match multiple database peaks and vice versa. The ratio is defined as:

$$\text{HK ratio} = \frac{\text{one-to-one matched peaks}}{\text{total peaks for compound in database}}$$

- **1.00** — all database peaks for this compound matched; strong evidence of identity (especially for compounds with many signals)
- **≥ 0.80** — likely strong structural similarity
- **< 0.50** — partial match; may indicate a related compound or substructure

Note that compounds with very few database peaks can achieve high ratios with limited evidence. The unique hits column (peaks matched by this compound and no other) provides additional confidence, especially for unusual nuclei like ¹¹B and ²⁹Si.

### Results table columns

| Column | Description |
|---|---|
| HK ratio | Hopcroft–Karp match ratio (matched/total) |
| Unique | Peaks matched only by this compound |
| Accession | Database identifier (links to source) |
| Name | Compound name if available |
| Source | Database of origin |
| Structure | 2D structure thumbnail (requires RDKit.js) |

### 2D searches

A database entry matches a 2D peak if it contains both a ¹H shift and an X shift within their respective tolerances. The search does not distinguish between HSQC and HMBC correlations — HMBC-only entries will appear as false positives in an HSQC search and vice versa. This is a deliberate tradeoff that allows searching the full database rather than the small fraction with HSQC data. It also enables searching with "virtual" 2D datasets constructed from two 1D spectra (e.g. ¹H + ¹⁹F) for pure compounds.

Match ratios for 2D data are calculated based on ¹H shifts filtered by the X nucleus.

### Filtering hits

For speed, hits from NMRBank and NMRexp are first filtered by hit count before HK scorking. Hits from the NP-MRD and the Fulmer impurity tables are not treated this way since these databases are small enough to acommomodate scoring each hit.

---

## Spectrum Viewer

Check the **Plot** checkbox on any result row to overlay its database shifts on a simulated spectrum of your input peaks. Multiple results can be overlaid simultaneously in different colors.

- **1D** — vertical lines at each database shift; matched shifts (within tolerance) are highlighted
- **2D** — horizontal lines (X nucleus) and vertical lines (¹H) for each database shift; matched intersections are highlighted
- **Scroll** — zoom in/out
- **Drag** — pan (in pan mode) or zoom to selection (in zoom mode)
- **Double-click** — reset view

---

## Notes on Database Processing

Peak lists have been adapted from their source databases. Only experimental shifts are included from NP-MRD. Shifts identified as likely errors (wrong nucleus, IR stretches, J-couplings, non-shift text) have been excluded across all databases, though some errors undoubtedly remain. No attempt has been made to correct typos — erroneous values are simply omitted. Genuinely anomalous shifts (e.g. from paramagnetic effects) have been preserved after manual verification. Peak ranges (reported as shift₁–shift₂) are represented as the average of the two values.

---

## Contributing

Pull requests are welcome at [github.com/greenwoodad/nmrshiftsearch](https://github.com/greenwoodad/nmrshiftsearch).

## Authors

Alex Greenwood — author and maintainer — [github.com/greenwoodad](https://github.com/greenwoodad)

## License

MIT
