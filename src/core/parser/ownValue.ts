/**
 * `table[key]`, but only for a key the table itself defines. A key read from
 * the XML can name a member every object inherits (`constructor`, `toString`),
 * and reading that would put a function into the model, which the parse
 * worker then can't send (DataCloneError) — so the whole load fails.
 */
export function ownValue<V>(table: Readonly<Record<string, V>>, key: string | undefined): V | undefined {
  return key != null && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
