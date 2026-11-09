// Distinguish the *resident quote provider* instrument from the caller's
// requested ticker. A requested NASDAQ:NVDA may resolve to BATS:NVDA.
// Neither name nor the chart's reactive Observable is evidence by itself.
const EXACT_LISTED_SYMBOL = /^[A-Za-z0-9_]+:[A-Za-z0-9_.!]+$/;

const fields = [
  ['series_symbol', 'series.symbol'],
  ['info_full_name', 'series.symbolInfo.full_name'],
  ['info_pro_name', 'series.symbolInfo.pro_name'],
];

export function resolveQuoteSourceIdentity(candidates) {
  if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates)) {
    return { symbol: null, source_symbol_verified: false, source_symbol_origin: null };
  }
  for (const [key, source] of fields) {
    const value = candidates[key];
    if (typeof value === 'string' && EXACT_LISTED_SYMBOL.test(value)) {
      return {
        symbol: value,
        source_symbol_verified: true,
        source_symbol_origin: source,
      };
    }
  }
  return { symbol: null, source_symbol_verified: false, source_symbol_origin: null };
}


// Compare the visible chart request to the actual resident main-series source.
// TradingView may lawfully resolve a US equity from NASDAQ/NYSE/AMEX/ARCA to
// BATS. Do not apply that alias to ECONOMICS/FRED, other exchanges or tickers.
export function matchesChartSeriesIdentity(chartSymbol, seriesSymbol) {
  const clean = value => typeof value === 'string' && value.trim() &&
    !/[\s;{}]/.test(value) ? value.trim().toUpperCase() : null;
  const chart = clean(chartSymbol);
  const source = clean(seriesSymbol);
  if (!chart || !source) return false;
  if (chart === source) return true;
  const normalizeUsEquity = value => value.replace(
    /\b(?:NASDAQ|NYSE|AMEX|ARCA|BATS):([A-Z0-9_.!]+)/g, 'US_EQUITY:$1'
  );
  return normalizeUsEquity(chart) === normalizeUsEquity(source);
}
