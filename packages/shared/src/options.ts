/** Display helpers for option contract symbols. Keep this package-local so
 *  the web app never imports `@qtp/core`. */

const OPTION_SYMBOL =
  /^(.+)-([CP])-([0-9]+(?:_[0-9]+)?)(?:@.+)?$/;

/** Human label: `AERIUM-C-1050@<cycle>` → `C AERIUM 1050`. Spots pass through. */
export function formatInstrumentLabel(symbol: string): string {
  const m = OPTION_SYMBOL.exec(symbol);
  if (!m) return symbol;
  return `${m[2]} ${m[1]} ${m[3]!.replace(/_/g, ".")}`;
}
