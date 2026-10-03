/**
 * Corpus passes stream archive rows instead of loading the whole table: a
 * cursor ordered by session id is cut into one session's rows at a time, so
 * peak memory follows the largest session, not the corpus.
 */
export function* bySession<T extends { sid: number }>(rows: Iterable<T>): Generator<[number, T[]]> {
  let sid = 0, group: T[] = [];
  for (const row of rows) {
    if (group.length > 0 && row.sid !== sid) { yield [sid, group]; group = []; }
    sid = row.sid;
    group.push(row);
  }
  if (group.length > 0) yield [sid, group];
}
