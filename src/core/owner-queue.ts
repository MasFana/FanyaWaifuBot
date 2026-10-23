export class OwnerQueue {
  private readonly tails = new Map<string, Promise<void>>();

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
