/** Small text helpers shared by the pages and by anything that builds prose. */

/**
 * `3 bindings`, `1 binding`. Naive on purpose — every noun unikeys counts is
 * regular, and a real pluralisation table would be more machinery than the half
 * dozen call sites justify.
 */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
