export class SystemClock {
    now() {
        return Date.now();
    }
}
export class FrozenClock {
    epochMilliseconds;
    constructor(epochMilliseconds) {
        this.epochMilliseconds = epochMilliseconds;
    }
    now() {
        return this.epochMilliseconds;
    }
}
//# sourceMappingURL=clock.js.map