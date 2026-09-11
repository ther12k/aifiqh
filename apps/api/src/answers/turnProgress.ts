/**
 * Pipeline progress events (UX-AI-001 / #133).
 *
 * The client sees PIPELINE STATUS, never model tokens: the final answer is
 * rendered only after the full validation stack passes (it arrives through
 * the normal POST response, exactly as before). This bus carries the stage
 * transitions ("mencari sumber → memeriksa dalil → menyusun jawaban →
 * memverifikasi rujukan → selesai") from the running turn to subscribed
 * SSE clients.
 *
 * In-memory and per-process by design: the API runs as a single app
 * container. Events replay from a small ring buffer (SSE `since` cursor)
 * so a subscriber that connects slightly after the POST still sees every
 * stage; buffers expire after idle inactivity.
 */

export type TurnStage =
	| 'searching_sources'
	| 'checking_evidence'
	| 'composing_answer'
	| 'verifying_citations'
	| 'done'

export interface TurnProgressEvent {
	/** monotonic per conversation — SSE `since` cursor */
	seq: number
	conversationId: string
	stage: TurnStage
	/** server clock (ISO) — clients drop events older than their own send */
	at: string
}

const RING_CAPACITY = 32
const IDLE_TTL_MS = 10 * 60_000
const MAX_CONVERSATIONS = 1_000

export class TurnProgressBus {
	private readonly buffers = new Map<string, TurnProgressEvent[]>()
	private readonly seqs = new Map<string, number>()
	private readonly lastActivity = new Map<string, number>()
	private readonly subscribers = new Map<
		string,
		Set<(event: TurnProgressEvent) => void>
	>()

	/** publish one stage transition for the conversation's current turn */
	publish(conversationId: string, stage: TurnStage): TurnProgressEvent {
		this.prune()
		const seq = (this.seqs.get(conversationId) ?? 0) + 1
		this.seqs.set(conversationId, seq)
		const event: TurnProgressEvent = {
			seq,
			conversationId,
			stage,
			at: new Date().toISOString(),
		}
		const ring = this.buffers.get(conversationId) ?? []
		ring.push(event)
		if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY)
		this.buffers.set(conversationId, ring)
		this.lastActivity.set(conversationId, Date.now())

		const subs = this.subscribers.get(conversationId)
		if (subs) {
			for (const sub of subs) {
				try {
					sub(event)
				} catch {
					// a broken subscriber never breaks the running turn
				}
			}
		}
		return event
	}

	/** events with seq > since, oldest first (SSE replay on connect) */
	replay(conversationId: string, since = 0): TurnProgressEvent[] {
		const ring = this.buffers.get(conversationId) ?? []
		return ring.filter((e) => e.seq > since)
	}

	/**
	 * Subscribe to live events; returns the unsubscribe function. The
	 * listener receives ONLY events published after subscribing — combine
	 * with replay(since) for at-least-once delivery across the connect gap.
	 */
	subscribe(
		conversationId: string,
		listener: (event: TurnProgressEvent) => void,
	): () => void {
		let subs = this.subscribers.get(conversationId)
		if (!subs) {
			subs = new Set()
			this.subscribers.set(conversationId, subs)
		}
		subs.add(listener)
		return () => {
			const current = this.subscribers.get(conversationId)
			if (!current) return
			current.delete(listener)
			if (current.size === 0) this.subscribers.delete(conversationId)
		}
	}

	/** drop buffers idle beyond the TTL (and cap total conversations) */
	prune(): void {
		const now = Date.now()
		for (const [id, last] of this.lastActivity) {
			if (now - last > IDLE_TTL_MS) {
				this.buffers.delete(id)
				this.seqs.delete(id)
				this.lastActivity.delete(id)
			}
		}
		if (this.lastActivity.size <= MAX_CONVERSATIONS) return
		const oldest = [...this.lastActivity.entries()]
			.sort((a, b) => a[1] - b[1])
			.slice(0, this.lastActivity.size - MAX_CONVERSATIONS)
		for (const [id] of oldest) {
			this.buffers.delete(id)
			this.seqs.delete(id)
			this.lastActivity.delete(id)
		}
	}
}

/** process-wide bus (single app container — see module note) */
export const turnProgress = new TurnProgressBus()
