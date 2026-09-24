import { EventEmitter } from "node:events";
import type { CaseEvent, GuardianCase } from "@guardian/shared";

export type BusMessage =
  | { kind: "event"; event: CaseEvent }
  | { kind: "case"; case: GuardianCase }
  | { kind: "reset" };

/** In-process pub/sub feeding the SSE timeline. `*` receives every case. */
export class EventBus {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(200);
  }

  publish(caseId: string, msg: BusMessage): void {
    this.ee.emit(caseId, msg);
    this.ee.emit("*", msg);
  }

  subscribe(caseId: string, fn: (msg: BusMessage) => void): () => void {
    this.ee.on(caseId, fn);
    return () => this.ee.off(caseId, fn);
  }
}
