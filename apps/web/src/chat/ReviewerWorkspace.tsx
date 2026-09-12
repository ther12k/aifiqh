import { useCallback, useEffect, useState } from 'react'

export interface ClaimEvidence {
	evidenceId: string
	unitId: string | null
	spanId: string | null
	spanKey: string | null
	originalText: string | null
	authorityType: string | null
	madhhab: string[]
	stance: string | null
	grading: string | null
	gradingBy: string | null
	sourceTitle: string | null
	sourceAuthor: string | null
}

export interface StandingVerdict {
	claimId: string
	verdict: 'approve' | 'reject' | 'correct'
	correctedText: string | null
	note: string | null
	actorId: string | null
	createdAt: string
}

export interface AnswerClaimDetail {
	id: string
	text: string
	kind: string
	ordinal: number
	standingVerdict: StandingVerdict | null
	evidence: ClaimEvidence[]
}

export interface AnswerClaimsResponse {
	answerId: string
	conversationId: string
	createdAt: string
	question: string
	answerText: string | null
	scholarlyReview: 'not_reviewed' | 'scholar_reviewed' | 'scholar_contested'
	/** ANS-DUMP-001: result-kind provenance — quote-composed results are
	 * labeled as quotes so a reviewer never mistakes them for AI synthesis */
	generation?: {
		provider: string
		generationSource: string | null
		fallbackReason: string | null
	}
	claims: AnswerClaimDetail[]
}

export interface QueueItem {
	answer_id: string
	conversation_id: string
	created_at: string
	question: string | null
	claim_count: number
	reviewed_claim_count: number
}

function csrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

export function ReviewerWorkspace({ permissions }: { permissions: string[] }) {
	const canReview = permissions.includes('review:approve')
	const [queue, setQueue] = useState<QueueItem[]>([])
	const [selectedAnswerId, setSelectedAnswerId] = useState<string | null>(null)
	const [detail, setDetail] = useState<AnswerClaimsResponse | null>(null)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [actionNotice, setActionNotice] = useState<string | null>(null)
	/** inline reject/correct form for one claim at a time */
	const [verdictForm, setVerdictForm] = useState<{
		claimId: string
		verdict: 'reject' | 'correct'
		text: string
		note: string
	} | null>(null)

	const loadQueue = useCallback(async () => {
		try {
			const res = await fetch('/reviewer/queue')
			if (!res.ok) return
			const data = (await res.json()) as { queue: QueueItem[] }
			setQueue(data.queue ?? [])
			if (!selectedAnswerId && data.queue.length > 0) {
				setSelectedAnswerId(data.queue[0].answer_id)
			}
		} catch {
			// ignore
		}
	}, [selectedAnswerId])

	const loadDetail = useCallback(async (answerId: string) => {
		setLoading(true)
		setError(null)
		try {
			const res = await fetch(`/answers/${answerId}/claims`)
			if (!res.ok) {
				throw new Error(`Gagal memuat detail klaim (${res.status})`)
			}
			const data = (await res.json()) as AnswerClaimsResponse
			setDetail(data)
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : 'Gagal memuat jawaban')
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		if (canReview) {
			void loadQueue()
		}
	}, [canReview, loadQueue])

	useEffect(() => {
		if (selectedAnswerId) {
			void loadDetail(selectedAnswerId)
		}
	}, [selectedAnswerId, loadDetail])

	async function submitVerdict(
		claimId: string,
		verdict: 'approve' | 'reject' | 'correct',
		note = '',
		correctedText = '',
	) {
		if (!detail || !canReview) return

		try {
			const res = await fetch(
				`/answers/${detail.answerId}/claims/${claimId}/review`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-csrf-token': csrfToken(),
					},
					body: JSON.stringify({
						verdict,
						note: note || undefined,
						correctedText: correctedText || undefined,
					}),
				},
			)

			if (!res.ok) {
				throw new Error(`Gagal menyimpan tinjauan (${res.status})`)
			}

			const data = (await res.json()) as {
				reviewId: string
				evalCaseId: string | null
			}
			setActionNotice(
				verdict === 'approve'
					? 'Klaim berhasil disetujui.'
					: `Tinjauan tersimpan. Kasus regresi otomatis dicatat di set evaluasi (ID: ${data.evalCaseId?.slice(0, 8) ?? '—'}).`,
			)
			setTimeout(() => setActionNotice(null), 5000)
			setVerdictForm(null)

			// Reload current answer and queue
			await loadDetail(detail.answerId)
			await loadQueue()
		} catch (err: unknown) {
			alert(err instanceof Error ? err.message : 'Gagal mengirim tinjauan')
		}
	}

	if (!canReview) {
		return (
			<div className="gate-note">
				Anda memerlukan izin <code>review:approve</code> untuk mengakses ruang
				kerja peninjau ulama.
			</div>
		)
	}

	return (
		<div className="reviewer-workspace" data-testid="reviewer-workspace">
			<div className="reviewer-layout">
				{/* Queue sidebar */}
				<aside className="reviewer-queue">
					<h3>Antrean Jawaban ({queue.length})</h3>
					{queue.length > 0 && (
						<div className="queue-progress" aria-hidden="true">
							{(() => {
								const total = queue.reduce((n, q) => n + q.claim_count, 0)
								const done = queue.reduce(
									(n, q) => n + q.reviewed_claim_count,
									0,
								)
								const pct = total === 0 ? 0 : Math.round((done / total) * 100)
								return (
									<>
										<div className="queue-progress-track">
											<span style={{ width: `${pct}%` }} />
										</div>
										<small>
											{done}/{total} klaim ditinjau · {pct}%
										</small>
									</>
								)
							})()}
						</div>
					)}
					{queue.length === 0 ? (
						<p className="empty-hint">Tidak ada jawaban dalam antrean.</p>
					) : (
						<ul className="queue-list">
							{queue.map((q) => (
								<li
									key={q.answer_id}
									className={`queue-item ${selectedAnswerId === q.answer_id ? 'active' : ''}`}
								>
									<button
										type="button"
										onClick={() => setSelectedAnswerId(q.answer_id)}
									>
										<div className="queue-item-question">
											{q.question || 'Tanya jawab fiqih'}
										</div>
										<div className="queue-item-meta">
											<span>
												Klaim: {q.reviewed_claim_count}/{q.claim_count} ditinjau
											</span>
											<span>{new Date(q.created_at).toLocaleDateString()}</span>
										</div>
									</button>
								</li>
							))}
						</ul>
					)}
				</aside>

				{/* Review detail area */}
				<section className="reviewer-main">
					{loading && <p className="loading-hint">Memuat detail jawaban...</p>}
					{error && <div className="alert alert-danger">{error}</div>}
					{actionNotice && (
						<div
							className="alert alert-success"
							data-testid="review-action-notice"
						>
							{actionNotice}
						</div>
					)}

					{detail && !loading && (
						<div className="review-detail" data-testid="review-detail">
							<header className="review-header">
								<div>
									<span className="eyebrow">Pertanyaan Pengguna</span>
									<h3>{detail.question}</h3>
								</div>
								<div className="status-badge-wrap">
									<span
										className={`badge ${
											detail.scholarlyReview === 'scholar_reviewed'
												? 'badge-ok'
												: detail.scholarlyReview === 'scholar_contested'
													? 'badge-warn'
													: 'badge-neutral'
										}`}
										data-testid="scholarly-status-badge"
									>
										{detail.scholarlyReview === 'scholar_reviewed'
											? 'DITINJAU ULAMA (LULUS)'
											: detail.scholarlyReview === 'scholar_contested'
												? 'DIPERSENGKETAKAN'
												: 'BELUM DITINJAU'}
									</span>
								</div>
							</header>

							{detail.generation?.generationSource ===
								'deterministic_composer' && (
								<div
									className="alert alert-warn"
									data-testid="composer-result-banner"
								>
									<strong>Kutipan otomatis — bukan kesimpulan AI.</strong> Hasil
									ini disusun mekanis dari passage yang ditemukan (fallback
									generasi
									{detail.generation.fallbackReason
										? `: ${detail.generation.fallbackReason}`
										: ''}
									). Setiap klaim di bawah adalah salinan teks sumber, bukan
									sintesis model — tinjau relevansi passage terhadap pertanyaan,
									bukan hanya kecocokan kutipan.
								</div>
							)}

							<h4>Klaim & Bukti Dalil Berdampingan ({detail.claims.length})</h4>
							<div className="claims-list">
								{detail.claims.map((claim) => (
									<div
										key={claim.id}
										className="claim-review-card"
										data-testid={`claim-card-${claim.id}`}
									>
										<div className="claim-card-columns">
											{/* Left: Claim statement & status */}
											<div className="claim-col-statement">
												<div className="claim-col-head">
													<span className="claim-tag">
														Klaim #{claim.ordinal}
													</span>
													<span className="badge badge-neutral">
														{claim.kind}
													</span>
												</div>
												<p className="claim-text">{claim.text}</p>

												<div className="claim-standing-status">
													<strong>Status tinjauan:</strong>{' '}
													{claim.standingVerdict ? (
														<span
															className={`verdict-tag verdict-${claim.standingVerdict.verdict}`}
															data-testid={`verdict-${claim.id}`}
														>
															{claim.standingVerdict.verdict === 'approve'
																? 'Disetujui'
																: claim.standingVerdict.verdict === 'reject'
																	? 'Ditolak'
																	: 'Dikoreksi'}
														</span>
													) : (
														<span className="verdict-tag verdict-none">
															Belum ditinjau
														</span>
													)}
												</div>

												{claim.standingVerdict && (
													<div className="claim-standing-meta">
														{claim.standingVerdict.note && (
															<div className="verdict-note">
																<em>Catatan:</em> {claim.standingVerdict.note}
															</div>
														)}
														{claim.standingVerdict.correctedText && (
															<div className="verdict-correction">
																<em>Rumusan benar:</em>{' '}
																{claim.standingVerdict.correctedText}
															</div>
														)}
														<small className="verdict-time">
															Ditinjau{' '}
															{new Date(
																claim.standingVerdict.createdAt,
															).toLocaleString()}
														</small>
													</div>
												)}

												{/* Action buttons */}
												<div className="claim-actions">
													<button
														type="button"
														className="btn-verdict btn-approve"
														onClick={() =>
															void submitVerdict(claim.id, 'approve')
														}
														data-testid={`btn-approve-${claim.id}`}
													>
														Setujui
													</button>
													<button
														type="button"
														className={`btn-verdict btn-reject ${verdictForm?.claimId === claim.id && verdictForm.verdict === 'reject' ? 'btn-active' : ''}`}
														onClick={() =>
															setVerdictForm(
																verdictForm?.claimId === claim.id &&
																	verdictForm.verdict === 'reject'
																	? null
																	: {
																			claimId: claim.id,
																			verdict: 'reject',
																			text: '',
																			note: '',
																		},
															)
														}
														data-testid={`btn-reject-${claim.id}`}
													>
														Tolak
													</button>
													<button
														type="button"
														className={`btn-verdict btn-correct ${verdictForm?.claimId === claim.id && verdictForm.verdict === 'correct' ? 'btn-active' : ''}`}
														onClick={() =>
															setVerdictForm(
																verdictForm?.claimId === claim.id &&
																	verdictForm.verdict === 'correct'
																	? null
																	: {
																			claimId: claim.id,
																			verdict: 'correct',
																			text: '',
																			note: '',
																		},
															)
														}
														data-testid={`btn-correct-${claim.id}`}
													>
														Koreksi
													</button>
												</div>

												{/* inline reject/correct form — replaces window.prompt */}
												{verdictForm?.claimId === claim.id && (
													<form
														className="verdict-form"
														data-testid={`verdict-form-${claim.id}`}
														onSubmit={(e) => {
															e.preventDefault()
															if (verdictForm.verdict === 'reject') {
																if (!verdictForm.note.trim()) return
																void submitVerdict(
																	claim.id,
																	'reject',
																	verdictForm.note.trim(),
																)
															} else {
																if (!verdictForm.text.trim()) return
																void submitVerdict(
																	claim.id,
																	'correct',
																	verdictForm.note.trim(),
																	verdictForm.text.trim(),
																)
															}
														}}
													>
														{verdictForm.verdict === 'correct' && (
															<label>
																Rumusan klaim yang benar
																<textarea
																	rows={3}
																	required
																	value={verdictForm.text}
																	onChange={(e) =>
																		setVerdictForm({
																			...verdictForm,
																			text: e.target.value,
																		})
																	}
																	placeholder="Tuliskan rumusan klaim yang sesuai dengan dalil…"
																/>
															</label>
														)}
														<label>
															{verdictForm.verdict === 'reject'
																? 'Alasan penolakan (wajib)'
																: 'Catatan koreksi (opsional)'}
															<textarea
																rows={2}
																required={verdictForm.verdict === 'reject'}
																value={verdictForm.note}
																onChange={(e) =>
																	setVerdictForm({
																		...verdictForm,
																		note: e.target.value,
																	})
																}
																placeholder={
																	verdictForm.verdict === 'reject'
																		? 'Apa yang keliru dari klaim ini?'
																		: 'Opsional — konteks koreksi…'
																}
															/>
														</label>
														<div className="verdict-form-actions">
															<button
																type="submit"
																className="btn-verdict btn-approve"
															>
																Simpan Tinjauan
															</button>
															<button
																type="button"
																className="btn-verdict btn-correct"
																onClick={() => setVerdictForm(null)}
															>
																Batal
															</button>
														</div>
													</form>
												)}
											</div>

											{/* Right: Cited evidence passages */}
											<div className="claim-col-evidence">
												<div className="evidence-col-head">
													<span>
														Bukti yang Dikutip ({claim.evidence.length})
													</span>
												</div>
												{claim.evidence.length === 0 ? (
													<p className="empty-hint">
														Tidak ada rujukan dalil tertaut.
													</p>
												) : (
													claim.evidence.map((ev) => (
														<div
															key={ev.evidenceId}
															className="evidence-passage-box"
														>
															<div className="evidence-meta">
																<strong>
																	{ev.sourceTitle ?? 'Sumber Tanpa Judul'}
																</strong>
																{ev.spanKey && (
																	<span className="span-pill">
																		{ev.spanKey}
																	</span>
																)}
																{ev.authorityType && (
																	<span className="badge badge-neutral">
																		{ev.authorityType}
																	</span>
																)}
																{ev.madhhab?.length > 0 && (
																	<span className="badge badge-neutral">
																		{ev.madhhab.join(', ')}
																	</span>
																)}
																{ev.grading && (
																	<span className="badge badge-ok">
																		{ev.grading}
																	</span>
																)}
															</div>
															<blockquote className="evidence-quote">
																{ev.originalText ?? 'Teks tidak tersedia'}
															</blockquote>
														</div>
													))
												)}
											</div>
										</div>
									</div>
								))}
							</div>
						</div>
					)}
				</section>
			</div>
		</div>
	)
}
