// Client-side parser for the Rent Manager property+unit TSV paste.
//
// Expected header (tab-separated):
//   Property ID  Property  Property Street Address 1  Unit Name  Sqft  Bedrooms  Bathrooms
//
// Each row represents a UNIT. Multiple rows share the same Property ID
// when a building has more than one unit. This parser:
//
//   1. Splits on newlines + tabs.
//   2. Skips blank rows, the header row, and rows missing a Property ID.
//   3. Skips "Common" / "Confidential" portfolio placeholder rows.
//   4. Skips an explicit block list of property IDs the user flagged
//      as not real data (test entries, offices that shouldn't be in
//      the directory).
//   5. Parses city/state/zip from the "Property" column by stripping
//      the street address prefix and reading the trailing
//      "<city>, <state> [zip]" pattern.
//   6. Cleans common Excel artifacts: commas in sqft, doubled city
//      names, "<city> Ohio, OH" duplication.
//   7. Returns a structured { ok, rows, summary, warnings } object
//      ready to post at /api/admin/bulk-import.

// ── Configuration ────────────────────────────────────────────────

// Property IDs the user explicitly said to skip. Easier to gate on the
// numeric ID than on name matching since the IDs come straight from
// Rent Manager and won't change.
const BLOCKED_PROPERTY_IDS = new Set([
  703, // Slumlord Castle (Atlantis)
  753, // 101 S (Fort, FL — truncated address)
  754, // 101 SW 22nd Ave Fort Lauderdale, FL
  604, // Breeze Corporate Property - Confidential
  605, // Breezy Corporate Property - Confidential
  457, // 5322 Greenway Ave Philadelphia, PA
  437, // 7 Riverview Pl Davenport, IA
  453, // 1413 7th Ave Rock Island, IL
  455, // 1609-1613 Iowa St Davenport, IA
  // 438 (33 N. 51st St Philadelphia) is kept per user instruction.
]);

// If the row's Property column contains any of these tokens, treat it
// as a portfolio placeholder row and skip.
const COMMON_ROW_MARKERS = [
  /-\s*Common\b/i,
  /-\s*Confidential\b/i,
];

// Two-letter state codes we recognise. Parser won't trust anything
// that doesn't end with one of these.
const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI',
  'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT',
  'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

// Map of full state name → abbreviation. Used to strip things like
// "Toledo Ohio" → "Toledo" in the city field.
const STATE_NAME_TO_CODE = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

// ── Helpers ──────────────────────────────────────────────────────

function cleanCity(raw) {
  if (!raw) return '';
  let s = raw.trim();

  // Strip trailing full state name ("Toledo Ohio" → "Toledo").
  const lower = s.toLowerCase();
  for (const [name] of Object.entries(STATE_NAME_TO_CODE)) {
    if (lower.endsWith(' ' + name)) {
      s = s.slice(0, s.length - name.length).trim();
      break;
    }
  }

  // Dedupe immediately adjacent identical words
  // ("Toledo Toledo" → "Toledo", "New New York" stays).
  const parts = s.split(/\s+/);
  const deduped = [];
  for (const p of parts) {
    if (deduped.length === 0 || deduped[deduped.length - 1].toLowerCase() !== p.toLowerCase()) {
      deduped.push(p);
    }
  }
  return deduped.join(' ').trim();
}

// Parse city/state/zip out of the trailing portion of the Property column.
// Input examples:
//   " Toledo, OH 43606"
//   " Toledo Ohio, OH 43604"
//   " Fort Lauderdale, FL 33312"
//   " Atlantis"                (no comma → unparseable)
function parseTail(tail) {
  const trimmed = (tail || '').trim();
  if (!trimmed) return { error: 'Empty city/state/zip' };

  // Match "<city>, <STATE> [zip]" at the end.
  const re = /^(.+?),\s*([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?\s*$/;
  const m = trimmed.match(re);
  if (!m) return { error: `Could not parse city/state from "${trimmed}"` };

  const state = m[2];
  if (!US_STATES.has(state)) {
    return { error: `Unknown state code "${state}"` };
  }
  const city = cleanCity(m[1]);
  if (!city) return { error: 'Empty city after cleanup' };

  return {
    city,
    state,
    zip: m[3] || '',
  };
}

// Given col2 (Property) and col3 (Property Street Address 1), return
// { street, city, state, zip, warning? }. The street comes from col3
// verbatim; city/state/zip come from what remains of col2 after we
// strip col3 and any " - <street>" repetition.
function parseAddress(propertyColumn, streetColumn) {
  const street = (streetColumn || '').trim();
  if (!street) {
    return { error: 'Missing street address' };
  }

  let remainder = (propertyColumn || '').trim();

  // RM sometimes formats the Property column as "<name> - <street> <city>, <ST> <zip>".
  // If we see " - " early in the string, strip everything up to and
  // including it.
  const dashIdx = remainder.indexOf(' - ');
  if (dashIdx >= 0 && dashIdx < 80) {
    remainder = remainder.slice(dashIdx + 3).trim();
  }

  // Strip the street prefix if the remainder starts with it.
  if (remainder.toLowerCase().startsWith(street.toLowerCase())) {
    remainder = remainder.slice(street.length).trim();
  }

  const tail = parseTail(remainder);
  if (tail.error) {
    return { error: tail.error };
  }

  return {
    street,
    city: tail.city,
    state: tail.state,
    zip: tail.zip,
  };
}

function cleanNumber(s) {
  if (s === null || s === undefined) return null;
  const trimmed = String(s).trim().replace(/,/g, '');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function isCommonRow(propertyColumn) {
  if (!propertyColumn) return false;
  return COMMON_ROW_MARKERS.some((re) => re.test(propertyColumn));
}

// ── Main entry point ─────────────────────────────────────────────

export function parseTSV(text) {
  if (!text || !text.trim()) {
    return {
      ok: false,
      error: 'No data provided',
      summary: null,
      rows: [],
      warnings: [],
    };
  }

  const lines = text.split(/\r?\n/);
  const parsed = [];
  const warnings = [];

  let totalLines = 0;
  let blankLines = 0;
  let headerFound = false;
  let skippedCommon = 0;
  let skippedBlocked = 0;
  let skippedMissing = 0;
  let addressFailures = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      blankLines += 1;
      continue;
    }
    totalLines += 1;

    const cols = line.split('\t').map((c) => c.trim());

    // Header detection: the first non-blank row whose first column is
    // literally "Property ID" is the header; skip it.
    if (!headerFound && cols[0].toLowerCase() === 'property id') {
      headerFound = true;
      continue;
    }

    // Need at least Property ID + Property + Street + Unit Name columns.
    if (cols.length < 4) {
      warnings.push({ lineNumber: i + 1, error: `Row has only ${cols.length} columns` });
      continue;
    }

    const [
      rawPropertyId,
      propertyCol,
      streetCol,
      unitName,
      sqft,
      bedrooms,
      bathrooms,
    ] = cols;

    const sourcePropertyId = cleanNumber(rawPropertyId);
    if (!sourcePropertyId) {
      skippedMissing += 1;
      continue;
    }

    if (BLOCKED_PROPERTY_IDS.has(sourcePropertyId)) {
      skippedBlocked += 1;
      continue;
    }

    if (isCommonRow(propertyCol)) {
      skippedCommon += 1;
      continue;
    }

    const addr = parseAddress(propertyCol, streetCol);
    if (addr.error) {
      addressFailures += 1;
      warnings.push({
        lineNumber: i + 1,
        sourcePropertyId,
        error: addr.error,
        propertyColumn: propertyCol,
      });
      continue;
    }

    parsed.push({
      sourcePropertyId,
      displayName: streetCol || propertyCol,
      serviceAddressLine1: addr.street,
      serviceCity: addr.city,
      serviceState: addr.state,
      serviceZip: addr.zip,
      unit: {
        sourceUnitName: unitName || null,
        sqft: cleanNumber(sqft),
        bedrooms: cleanNumber(bedrooms),
        bathrooms: bathrooms || null,
      },
    });
  }

  // Group rows by sourcePropertyId so the preview can show property counts
  // rather than raw row counts.
  const propertyIdSet = new Set(parsed.map((r) => r.sourcePropertyId));

  return {
    ok: true,
    rows: parsed,
    summary: {
      totalLines,
      blankLines,
      headerRow: headerFound ? 1 : 0,
      parsedRows: parsed.length,
      uniqueProperties: propertyIdSet.size,
      skippedCommon,
      skippedBlocked,
      skippedMissing,
      addressFailures,
    },
    warnings,
  };
}
