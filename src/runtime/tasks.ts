/**
 * Owns asynchronous work whose lifetime must not outlive a view or DB handle.
 * Cancellation advances a generation before aborting, so even a provider that
 * resolves late cannot pass an `isCurrent()` write guard.
 */
export interface TaskContext {
  signal: AbortSignal;
  generation: number;
  isCurrent(): boolean;
}

export class TaskSupervisor {
  private generation = 0;
  private closed = false;
  private readonly active = new Set<{ controller: AbortController; promise: Promise<unknown> }>();

  run<T>(work: (ctx: TaskContext) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(abortError("task supervisor is closed"));

    const generation = this.generation;
    return this.start(generation, work);
  }

  /**
   * Atomically replace all work in this scope. Replacement advances the
   * generation and aborts prior work synchronously, then awaits that work
   * before starting the replacement. If another replacement arrives while
   * waiting, this request never starts: only the newest generation can run or
   * pass its `isCurrent()` delivery/commit guard.
   */
  replace<T>(
    work: (ctx: TaskContext) => Promise<T>,
    reason = "task replaced",
  ): Promise<T> {
    if (this.closed) return Promise.reject(abortError("task supervisor is closed"));

    const generation = ++this.generation;
    const prior = [...this.active];
    for (const entry of prior) entry.controller.abort(reason);

    return Promise.allSettled(prior.map((entry) => entry.promise)).then(() => {
      if (this.closed || generation !== this.generation) {
        throw abortError("task replacement was superseded");
      }
      return this.start(generation, work);
    });
  }

  private start<T>(generation: number, work: (ctx: TaskContext) => Promise<T>): Promise<T> {
    if (this.closed || generation !== this.generation) {
      return Promise.reject(abortError("task generation is obsolete"));
    }
    const controller = new AbortController();
    const entry: { controller: AbortController; promise: Promise<unknown> } = {
      controller,
      promise: Promise.resolve(),
    };
    const promise = Promise.resolve().then(() =>
      work({
        signal: controller.signal,
        generation,
        isCurrent: () =>
          !this.closed && !controller.signal.aborted && generation === this.generation,
      }),
    );
    entry.promise = promise;
    this.active.add(entry);
    void promise.finally(() => this.active.delete(entry)).catch(() => undefined);
    return promise;
  }

  /** Cancel the current generation and wait until every owned task settles. */
  async cancelAndWait(reason = "task scope closed"): Promise<void> {
    this.generation++;
    const entries = [...this.active];
    for (const entry of entries) entry.controller.abort(reason);
    await Promise.allSettled(entries.map((entry) => entry.promise));
  }

  /** Permanently close the supervisor (normally immediately before DB close). */
  async close(reason = "application exiting"): Promise<void> {
    this.closed = true;
    await this.cancelAndWait(reason);
  }

  get activeCount(): number {
    return this.active.size;
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
