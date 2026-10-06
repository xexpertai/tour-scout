/** Numbered record of every Qloo call in one run. Reports cite these ids (Q1, Q2, …) as evidence. */
import type { QlooCall } from "./qloo.ts";

export type Source = { id: string; label: string; call: QlooCall };

export class EvidenceLedger {
  readonly sources: Source[] = [];
  private readonly startAt: number;

  /** `startAt` continues an existing plan's numbering, so follow-up evidence never reuses an id. */
  constructor(startAt = 0) {
    this.startAt = startAt;
  }

  record(label: string, call: QlooCall): Source {
    const source = { id: `Q${this.startAt + this.sources.length + 1}`, label, call };
    this.sources.push(source);
    return source;
  }

  ids(): Set<string> {
    return new Set(this.sources.map((s) => s.id));
  }
}

/**
 * A minimal async queue: producers push events from concurrent tasks, one consumer iterates them in
 * arrival order. Used to stream partial results as soon as each independent Qloo call lands.
 */
export class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
