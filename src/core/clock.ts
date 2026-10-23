export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FrozenClock implements Clock {
  constructor(private epochMilliseconds: number) {}

  now(): number {
    return this.epochMilliseconds;
  }

  set(epochMilliseconds: number): void {
    this.epochMilliseconds = epochMilliseconds;
  }
}
