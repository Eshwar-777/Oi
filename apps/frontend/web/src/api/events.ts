import type { AutomationStreamEvent } from "@/domain/automation";

export interface EventStreamClient {
  connect: (sessionId: string, onEvent: (event: AutomationStreamEvent) => void) => () => void;
}

export const eventStreamClient: EventStreamClient = {
  connect() {
    // The backend stream contract is defined, but the transport is not yet wired in this worktree.
    // Return a no-op unsubscribe so the UI can already be built around typed events.
    return () => undefined;
  },
};
