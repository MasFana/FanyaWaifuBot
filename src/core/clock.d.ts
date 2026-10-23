export interface Clock {
    now(): number;
}
export declare class SystemClock implements Clock {
    now(): number;
}
export declare class FrozenClock implements Clock {
    private readonly epochMilliseconds;
    constructor(epochMilliseconds: number);
    now(): number;
}
