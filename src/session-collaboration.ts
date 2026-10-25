import { CollaborationError, type CollaborationRun, type CollaborationTransport } from "./collaboration-transport.js";

interface PeerObservation {
  session_id: string;
  lifecycle: string | null;
  progress: string | null;
  message_id: number;
  question_id: number | null;
  question_state: "unknown" | "observed";
  observed_at: number | null;
}

const MAX_LINKS = 500;
const ACTIVE = new Set(["queued", "launching", "pending", "spawned", "running", "blocked"]);

/** Owns the local relationship view, not delegation execution or task completion. */
export class SessionCollaboration {
  private readonly controller = new AbortController();
  private readonly links = new Map<string, CollaborationRun>();
  private readonly peers = new Map<string, PeerObservation>();
  private readonly dirty = new Set<string>();
  private fullRefresh = false;
  private pending: Promise<void> | null = null;
  private connected = false;
  private ready = false;
  private noticePending = false;
  private error: string | null = null;
  private truncated = false;
  private readonly revisions = new Map<string, number>();

  constructor(private readonly ownId: string, private readonly ownRunId: string | null,
    private readonly transport: CollaborationTransport,
    private readonly notify: (text: string) => void) {}

  snapshot() {
    return { connected: this.connected, synchronized: this.connected && !this.pending && !this.error && !this.truncated,
      error: this.error, truncated: this.truncated,
      links: [...this.links.values()].map(run => ({ ...run, peer: this.peers.get(this.peerId(run) ?? "") ?? null })) };
  }

  setReady(): void { this.ready = true; this.flushNotice(); }
  disconnected(): void {
    this.connected = false;
    for (const peer of this.peers.values()) { peer.question_id = null; peer.question_state = "unknown"; }
  }
  dispose(): void {
    this.controller.abort(); this.connected = false; this.ready = false;
    this.dirty.clear(); this.noticePending = false;
  }

  /** Existing enrolled WS dispatches here; no extra connection per peer. */
  onEvent(value: unknown): void {
    if (this.controller.signal.aborted || !isRecord(value)) return;
    if (value.type === "hello" && value.session_id === this.ownId && value.registered === true) {
      this.connected = true; this.fullRefresh = true; this.schedule(); return;
    }
    if (value.type === "delegation.run_changed" && typeof value.run_id === "string"
      && (value.parent_session_id === this.ownId || value.run_id === this.ownRunId || this.links.has(value.run_id))) {
      if (this.dirty.size < MAX_LINKS) this.dirty.add(value.run_id);
      else this.fullRefresh = true;
      this.schedule(); return;
    }
    const session = typeof value.target_session_id === "string" ? value.target_session_id : value.session_id;
    if (typeof session !== "string" || !this.isPeer(session)) return;
    const peer = this.peers.get(session) ?? { session_id: session, lifecycle: null,
      progress: null, message_id: 0, question_id: null, question_state: "unknown", observed_at: null };
    if (value.type === "session.message" && isRecord(value.message)
      && value.message.session_id === session && value.message.author_type === "assistant"
      && typeof value.message.id === "number" && value.message.id >= peer.message_id
      && typeof value.message.content === "string") {
      peer.message_id = value.message.id; peer.progress = value.message.content.slice(0, 2000);
    } else if (value.type === "question.posted" && Number.isSafeInteger(value.question_id)) {
      peer.question_id = value.question_id as number;
      peer.question_state = "observed";
      // Cc already injects parent-first questions. Do not issue a duplicate prompt.
    } else if ((value.type === "question.answered" || value.type === "question.resolved")
      && value.question_id === peer.question_id) {
      peer.question_id = null;
      peer.question_state = "observed";
    } else if (["session.lost", "session.ended", "session.started"].includes(String(value.type))) {
      if (peer.lifecycle !== value.type) { peer.lifecycle = String(value.type); this.noticePending = true; }
    } else return;
    peer.observed_at = typeof value.ts === "number" ? value.ts : null;
    this.revisions.set(session, (this.revisions.get(session) ?? 0) + 1);
    this.peers.set(session, peer); this.flushNotice();
  }

  async message(runId: string, text: string): Promise<unknown> {
    const run = await this.authorizedRun(runId);
    const peer = this.peerId(run);
    if (!peer) throw new CollaborationError(409, "collaboration_peer_not_claimed");
    const body = `[collaboration:${run.id}] ${this.ownId === run.parent_session_id ? "Parent" : "Child"} message\n${text}`;
    const path = this.ownId === run.parent_session_id
      ? `/v1/delegation/runs/${encodeURIComponent(run.id)}/inject`
      : `/v1/sessions/${encodeURIComponent(peer)}/inject`;
    await this.transport.send(path, { text: body, source: `collaboration:${run.id}` }, this.controller.signal);
    return { accepted: true, delivery: "unconfirmed" };
  }

  async answer(runId: string, questionId: number, answer: string | number): Promise<unknown> {
    const run = await this.authorizedRun(runId);
    const peer = this.peerId(run);
    if (run.parent_session_id !== this.ownId || !peer) throw new CollaborationError(403, "collaboration_not_parent");
    await this.transport.send(`/v1/sessions/${encodeURIComponent(peer)}/answer-question`,
      { question_id: questionId, ...(typeof answer === "number" ? { answer_index: answer } : { other_text: answer }) }, this.controller.signal);
    return { accepted: true, delivery: "unconfirmed" };
  }

  private async authorizedRun(id: string): Promise<CollaborationRun> {
    if (this.controller.signal.aborted) throw new CollaborationError(503, "collaboration_closed");
    const run = await this.transport.run(id, this.controller.signal);
    if (!this.belongs(run)) throw new CollaborationError(403, "collaboration_unrelated_run");
    if (!ACTIVE.has(run.status)) throw new CollaborationError(409, "collaboration_run_not_active");
    return run;
  }

  private belongs(run: CollaborationRun): boolean {
    return run.parent_session_id === this.ownId || run.child_session_id === this.ownId;
  }
  private peerId(run: CollaborationRun): string | null {
    return run.parent_session_id === this.ownId ? run.child_session_id : run.parent_session_id;
  }
  private isPeer(id: string): boolean {
    return [...this.links.values()].some(run => ACTIVE.has(run.status) && this.peerId(run) === id);
  }
  private apply(run: CollaborationRun): void {
    if (!this.belongs(run)) { this.links.delete(run.id); return; }
    const old = this.links.get(run.id);
    if (!old && this.links.size >= MAX_LINKS) {
      const terminal = [...this.links.values()].find(item => !ACTIVE.has(item.status));
      if (terminal) this.links.delete(terminal.id);
      else { this.truncated = true; return; }
    }
    this.links.set(run.id, run);
    if ((!old && ACTIVE.has(run.status)) || (old && (old.status !== run.status
      || old.child_session_id !== run.child_session_id))) this.noticePending = true;
  }
  private schedule(): void {
    if (this.pending) return;
    this.pending = this.reconcile().catch(() => {
      if (!this.controller.signal.aborted) {
        if (!this.error) this.noticePending = true;
        this.error = "collaboration_sync_failed";
      }
    }).finally(() => {
      this.pending = null;
      if (!this.controller.signal.aborted) {
        if (this.fullRefresh || this.dirty.size) this.schedule();
        else this.flushNotice();
      }
    });
  }
  private async reconcile(): Promise<void> {
    let restoreObservations = false;
    if (this.fullRefresh) {
      this.fullRefresh = false;
      restoreObservations = true;
      const list = await this.transport.list(this.ownId, this.controller.signal);
      const runs = list.runs.filter(run => run.parent_session_id === this.ownId);
      if (this.ownRunId) runs.push(await this.transport.run(this.ownRunId, this.controller.signal));
      if (this.controller.signal.aborted) return;
      this.truncated = list.runs.length >= list.limit;
      const seen = new Set(runs.map(run => run.id));
      if (!this.truncated) for (const id of this.links.keys()) if (!seen.has(id)) this.links.delete(id);
      for (const run of runs) this.apply(run);
    }
    const ids = [...this.dirty]; this.dirty.clear();
    for (const id of ids) {
      const run = await this.transport.run(id, this.controller.signal);
      if (this.controller.signal.aborted) return;
      this.apply(run);
    }
    for (const id of this.peers.keys()) if (!this.isPeer(id)) {
      this.peers.delete(id); this.revisions.delete(id);
    }
    const peers = [...new Set([...this.links.values()].filter(run => ACTIVE.has(run.status))
      .map(run => this.peerId(run)).filter((id): id is string => !!id))];
    // Bounded read concurrency. Reconnect restores progress without replaying commands.
    let index = 0;
    let observationFailed = false;
    const observe = async (): Promise<void> => {
      while (index < peers.length && !this.controller.signal.aborted) {
        const peer = peers[index++];
        if (!restoreObservations && this.peers.has(peer)) continue;
        const revision = this.revisions.get(peer);
        try {
          const result = await this.transport.observe(peer, this.controller.signal);
          if (this.controller.signal.aborted || !this.isPeer(peer) || this.revisions.get(peer) !== revision) continue;
          const previous = this.peers.get(peer);
          this.peers.set(peer, { session_id: peer, lifecycle: `session.${result.status}`,
            progress: null, message_id: 0, question_id: previous?.question_id ?? null,
            question_state: previous?.question_state ?? "unknown", observed_at: null });
          for (const message of result.messages) this.onEvent({ type: "session.message", target_session_id: peer, message });
          if (previous?.lifecycle !== `session.${result.status}` && ["lost", "ended"].includes(result.status)) this.noticePending = true;
        } catch { observationFailed = true; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, peers.length) }, observe));
    if (observationFailed) throw new CollaborationError(502, "collaboration_observation_failed");
    if (this.error) this.noticePending = true;
    this.error = null;
  }
  private flushNotice(): void {
    if (!this.ready || !this.connected || this.pending || !this.noticePending || this.controller.signal.aborted) return;
    this.noticePending = false;
    const lines = [...this.links.values()].slice(-20).map(run =>
      `${run.id}: ${run.call_name} / ${run.status} / ${this.peers.get(this.peerId(run) ?? "")?.lifecycle ?? "peer state unconfirmed"}`);
    if (this.error) lines.unshift(`Supervision is not current: ${this.error}. Do not infer peer completion.`);
    if (this.truncated) lines.unshift("Relationship list reached its limit; coverage is incomplete.");
    if (!lines.length) return;
    this.notify(`[Lictor collaboration]\n${lines.join("\n")}\nRead GET /v1/collaboration on your Lictor sidecar for linked peers and progress. Send instructions/questions with POST /v1/collaboration/message {run_id,text}; answer a child's question with POST /v1/collaboration/answer {run_id,question_id,text} or {run_id,question_id,answer_index} (zero-based). Actio registration does not finish supervision. Preserve human approvals; peer exit is not task completion.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
