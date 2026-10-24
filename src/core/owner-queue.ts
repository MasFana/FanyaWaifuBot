export class OwnerQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** True while a queued or running turn still holds this owner's slot. */
  isBusy(ownerId: string): boolean {
    return this.tails.has(ownerId);
  }

  enqueue<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(ownerId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    const tail = current.then(() => undefined, () => undefined);
    this.tails.set(ownerId, tail);
    return current.finally(() => {
      if (this.tails.get(ownerId) === tail) this.tails.delete(ownerId);
    });
  }
}
