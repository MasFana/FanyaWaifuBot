import type { AppConfig } from "../config.js";
import type { MemoryService } from "../memory/service.js";
import type { Agent } from "./agent.js";
import type { Clock } from "./clock.js";
import type { WakeupEvent } from "./types.js";
import { OwnerQueue } from "./owner-queue.js";

const hourMs = 60 * 60_000;

export class HeartbeatEngine {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(private readonly memory: MemoryService, private readonly agent: Pick<Agent, "runWakeup">, private readonly clock: Clock, private readonly config: AppConfig, private readonly queue: OwnerQueue = new OwnerQueue()) {}

  async tick(): Promise<void> {
    if (this.activeTick) return this.activeTick;
    this.activeTick = this.runTick();
    try { await this.activeTick; } finally { this.activeTick = undefined; }
  }

  private async runTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const owner = this.resolveOwner();
      if (!owner) return;
      for (const commitment of this.memory.claimDueCommitments(this.clock.now(), owner.id)) {
        const triggerType = commitment.kind === "reminder" ? "agenda_reminder" : "agenda_followup";
        try {
           const outcome = await this.queue.enqueue(commitment.userId, () => this.agent.runWakeup({ userId: commitment.userId, triggerType, commitmentId: commitment.id }));
          if (outcome.delivered === true) this.memory.recordProactiveSend(commitment.userId);
          else this.memory.revertCommitmentClaim(commitment.id, commitment.kind);
        } catch {
          this.memory.revertCommitmentClaim(commitment.id, commitment.kind);
        }
      }
      await this.runSocial(owner.id, owner.timezone);
    } finally { this.running = false; }
  }

  private resolveOwner() {
    const configuredId = this.config.telegram.ownerId;
    return configuredId === undefined
      ? this.memory.resolveClaimedOwner("telegram")?.owner
      : this.memory.resolveOwner("telegram", configuredId);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.config.heartbeat.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  private async runSocial(userId: string, timeZone: string): Promise<void> {
    const state = this.memory.getProactiveState(userId);
    const local = localTime(this.clock.now(), timeZone);
    if (inQuietHours(local.time, state.quietHours.start, state.quietHours.end)) return;
    if (state.unansweredCount >= this.config.heartbeat.maxUnansweredProactive) return;
    const greeting = local.hour < 12 ? "morning" : local.hour >= 18 ? "night" : undefined;
    if (greeting && this.memory.claimProactiveEvent(userId, greeting, local.date)) {
      await this.wake(userId, { userId, triggerType: "greeting" }, () => this.memory.revertProactiveEvent(userId, greeting, local.date));
      return;
    }
    const idleMs = this.config.heartbeat.spontaneousIdleHours * hourMs;
    if (state.lastUserMessageAt === null || this.clock.now() - state.lastUserMessageAt < idleMs || (state.lastProactiveAt !== null && this.clock.now() - state.lastProactiveAt < idleMs)) return;
    await this.wake(userId, { userId, triggerType: "spontaneous" });
  }

  private async wake(userId: string, wakeup: WakeupEvent, revert?: () => void): Promise<void> {
    try {
      const outcome = await this.queue.enqueue(userId, () => this.agent.runWakeup(wakeup));
      if (outcome.status === "skipped" || outcome.delivered !== true) revert?.();
      if (outcome.delivered === true) this.memory.recordProactiveSend(userId);
    } catch {
      revert?.();
    }
  }
}

function localTime(now: number, timeZone: string): { date: string; time: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}`, hour: Number(get("hour")) };
}

function inQuietHours(time: string, start: string, end: string): boolean {
  return start <= end ? time >= start && time < end : time >= start || time < end;
}
