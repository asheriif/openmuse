import type { BaseEvent, Message } from "@ag-ui/core";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  InMemoryAgentRunner,
  type LocalThreadEndpointRecord,
  type LocalThreadEndpointRunner,
  ɵGLOBAL_STORE,
} from "@copilotkit/runtime/v2";
import type { Store } from "./db.ts";
import { backgroundFailure } from "./log.ts";

// The workspace has one user, so threads live beside sessions in the system namespace.
const OWNER = "system";

interface SavedRun {
  id: string;
  threadId: string;
  runId: string;
  agentId: string;
  parentRunId: string | null;
  events: BaseEvent[];
  createdAt: number;
}
interface SavedThread {
  id: string;
  name: string | null;
  archived: boolean;
  messages: Message[];
}

/**
 * Keeps chat threads in the OpenMuse database instead of a hosted thread service.
 * The runtime's in-memory runner still executes runs and serves replay and the local
 * /threads endpoints; this saves every finished run and reloads them on startup.
 */
export class ThreadRunner extends AgentRunner implements LocalThreadEndpointRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  // Durable history must never be evicted from the in-memory copy.
  private readonly memory = new InMemoryAgentRunner({
    maxThreads: Infinity,
    maxRunsPerThread: 0,
    maxBytes: Infinity,
  });
  private readonly threads = new Map<string, SavedThread>();
  private writes: Promise<unknown> = Promise.resolve();
  private constructor(private readonly db: Store) {
    super();
  }

  static async open(db: Store) {
    const runner = new ThreadRunner(db);
    for (const { value } of await db.scan<SavedThread>("threads"))
      runner.threads.set(value.id, value);
    const runs = (await db.scan<SavedRun>("thread-runs"))
      .map(({ value }) => value)
      .sort((a, b) => a.createdAt - b.createdAt);
    const latest = new Map(runs.map((run) => [run.threadId, run.runId]));
    for (const { id: _, ...run } of runs) {
      const thread = ɵGLOBAL_STORE.getOrCreate(run.threadId);
      // The in-memory store is per process; reopening the same database must not duplicate history.
      if (thread.historicRuns.some((loaded) => loaded.runId === run.runId)) continue;
      const messages =
        latest.get(run.threadId) === run.runId
          ? (runner.threads.get(run.threadId)?.messages ?? [])
          : [];
      ɵGLOBAL_STORE.appendRun(run.threadId, { ...run, messages });
    }
    return runner;
  }

  run(request: AgentRunnerRunRequest) {
    const events = this.memory.run(request);
    // A run outlives a disconnected client, so save on completion rather than per subscriber.
    events.subscribe({
      complete: () =>
        void this.save(request.threadId, request.input.runId).catch((error) =>
          backgroundFailure("thread save", error),
        ),
    });
    return events;
  }
  connect(request: AgentRunnerConnectRequest) {
    return this.memory.connect(request);
  }
  isRunning(request: AgentRunnerIsRunningRequest) {
    return this.memory.isRunning(request);
  }
  stop(request: AgentRunnerStopRequest) {
    return this.memory.stop(request);
  }

  listThreads(): LocalThreadEndpointRecord[] {
    return this.memory.listThreads().map((thread) => ({
      ...thread,
      name: this.threads.get(thread.id)?.name ?? null,
      archived: this.threads.get(thread.id)?.archived ?? false,
    }));
  }
  getThreadMessages(threadId: string) {
    return this.memory.getThreadMessages(threadId);
  }
  getThreadEvents(threadId: string) {
    return this.memory.getThreadEvents(threadId);
  }
  getThreadState(threadId: string) {
    return this.memory.getThreadState(threadId);
  }
  /** The runtime's dev-only clear route must not wipe saved conversations. */
  clearThreads() {}

  has(threadId: string) {
    return Boolean(ɵGLOBAL_STORE.peek(threadId)?.historicRuns.length);
  }
  update(threadId: string, patch: Partial<Pick<SavedThread, "name" | "archived" | "messages">>) {
    this.threads.set(threadId, {
      id: threadId,
      name: null,
      archived: false,
      messages: [],
      ...this.threads.get(threadId),
      ...patch,
    });
    // Writes are serialized and each saves the latest copy, so concurrent updates never regress.
    const write = this.writes.then(() => {
      const thread = this.threads.get(threadId);
      return thread && this.db.put(OWNER, "threads", thread);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private async save(threadId: string, runId: string) {
    const thread = ɵGLOBAL_STORE.peek(threadId);
    const run = thread?.historicRuns.find((saved) => saved.runId === runId);
    if (!thread || !run) return;
    await this.db.put<SavedRun>(OWNER, "thread-runs", {
      id: `${threadId}:${runId}`,
      threadId,
      runId,
      agentId: run.agentId,
      parentRunId: run.parentRunId,
      events: run.events,
      createdAt: run.createdAt,
    });
    await this.update(threadId, { messages: thread.messagesSnapshot });
  }
}
