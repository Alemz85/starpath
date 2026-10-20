/**
 * parallel.mjs — run async task thunks with a concurrency cap.
 * Results come back in COMPLETION order (callers that need positions return
 * them from the task); a task that throws rejects the whole run, so tasks that
 * must be fail-open catch their own errors.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
export async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}
