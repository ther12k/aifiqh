import { useCallback, useEffect, useState } from 'react'
import {
	type PinCandidate,
	type PinSelectionState,
	addCandidates,
	cycleChoice,
	emptyPinSelection,
	originCounts,
	pinPayload,
	selectedCount,
	setChoice,
} from '../lib/pinReviewView'

function csrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

interface WorklistCase {
	caseId: string
	caseKey: string
	queryText: string
	category: string
	versionStatus: string
	pinCount: number
	confirmedCount: number
}

interface SuggestionPayload {
	caseKey: string
	queryText: string
	suggestions: Array<{
		unitId: string
		text: string
		sourceTitle: string | null
		lane: string
	}>
	notice: string
}

interface SearchCandidate {
	unitId: string
	originalText: string
}

/**
 * Benchmark pin review workspace (CAL-008): reviewers confirm expected
 * evidence per benchmark case. Suggestions accelerate; the corpus search is
 * the anti-circularity path — passages the retriever never surfaced can
 * still be pinned as the ground truth.
 */
export function PinReview() {
	const [setVersionId, setSetVersionId] = useState('')
	const [cases, setCases] = useState<WorklistCase[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [activeCase, setActiveCase] = useState<WorklistCase | null>(null)
	const [selection, setSelection] = useState<PinSelectionState>(
		emptyPinSelection(),
	)
	const [suggestNotice, setSuggestNotice] = useState<string | null>(null)
	const [searchQuery, setSearchQuery] = useState('')
	const [searching, setSearching] = useState(false)
	const [saving, setSaving] = useState(false)

	const loadWorklist = useCallback(async (versionId: string) => {
		setError(null)
		try {
			const res = await fetch(
				`/eval/pins/worklist?setVersionId=${encodeURIComponent(versionId)}`,
			)
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					message?: string
				}
				throw new Error(body.message ?? `gagal memuat (${res.status})`)
			}
			const body = (await res.json()) as { cases: WorklistCase[] }
			setCases(body.cases)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'gagal memuat worklist')
		}
	}, [])

	useEffect(() => {
		const stored = localStorage.getItem('pinReview.setVersionId')
		if (stored) {
			setSetVersionId(stored)
			void loadWorklist(stored)
		}
	}, [loadWorklist])

	async function openCase(c: WorklistCase) {
		setActiveCase(c)
		setSelection(emptyPinSelection())
		setSuggestNotice(null)
		setNotice(null)
		try {
			const res = await fetch('/eval/pins/suggest', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': csrfToken(),
				},
				body: JSON.stringify({ caseId: c.caseId, limit: 8 }),
			})
			if (!res.ok) throw new Error(`saran gagal (${res.status})`)
			const body = (await res.json()) as SuggestionPayload
			setSuggestNotice(body.notice)
			setSelection((prev) =>
				addCandidates(
					prev,
					body.suggestions.map<PinCandidate>((s) => ({
						unitId: s.unitId,
						text: s.text,
						sourceTitle: s.sourceTitle,
						lane: s.lane,
						origin: 'suggested',
					})),
				),
			)
		} catch (err) {
			setSuggestNotice(
				err instanceof Error ? err.message : 'saran tidak tersedia',
			)
		}
	}

	async function manualSearch() {
		if (!searchQuery.trim()) return
		setSearching(true)
		setError(null)
		try {
			const res = await fetch('/retrieval/search', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': csrfToken(),
				},
				body: JSON.stringify({ query: searchQuery }),
			})
			if (!res.ok) throw new Error(`pencarian gagal (${res.status})`)
			const body = (await res.json()) as {
				fused: { candidates: SearchCandidate[] }
			}
			const found = body.fused.candidates.slice(0, 10)
			setSelection((prev) =>
				addCandidates(
					prev,
					found.map<PinCandidate>((c) => ({
						unitId: c.unitId,
						text: c.originalText,
						sourceTitle: null,
						lane: 'manual-search',
						origin: 'manual',
					})),
				),
			)
			if (found.length === 0) setNotice('Pencarian tidak menemukan kandidat.')
		} catch (err) {
			setError(err instanceof Error ? err.message : 'pencarian gagal')
		} finally {
			setSearching(false)
		}
	}

	async function savePins() {
		if (!activeCase) return
		const payload = pinPayload(selection)
		if (payload.pins.length === 0) {
			setError('Pilih minimal satu bukti (wajib atau boleh).')
			return
		}
		setSaving(true)
		setError(null)
		try {
			const res = await fetch(`/eval/pins/${activeCase.caseId}`, {
				method: 'PUT',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': csrfToken(),
				},
				body: JSON.stringify(payload),
			})
			const body = (await res.json().catch(() => ({}))) as {
				message?: string
				saved?: number
			}
			if (!res.ok) {
				throw new Error(body.message ?? `gagal menyimpan (${res.status})`)
			}
			const origins = originCounts(selection)
			setNotice(
				`Tersimpan: ${body.saved ?? payload.pins.length} pin (${origins.manual} manual, ${origins.suggested} dari saran).`,
			)
			if (setVersionId) void loadWorklist(setVersionId)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'gagal menyimpan')
		} finally {
			setSaving(false)
		}
	}

	return (
		<section className="pin-review" aria-label="Tinjau pin benchmark">
			<div className="pin-review-controls">
				<label htmlFor="pin-version">
					ID versi set benchmark
					<input
						id="pin-version"
						value={setVersionId}
						onChange={(e) => setSetVersionId(e.target.value)}
						placeholder="evaluation_set_versions.id"
					/>
				</label>
				<button
					type="button"
					className="btn-primary"
					onClick={() => {
						localStorage.setItem('pinReview.setVersionId', setVersionId)
						void loadWorklist(setVersionId)
					}}
				>
					Muat worklist
				</button>
			</div>

			{error ? (
				<p role="alert" className="gate-note">
					{error}
				</p>
			) : null}
			{notice ? <p className="pin-review-notice">{notice}</p> : null}

			{cases ? (
				<table className="pin-worklist" data-testid="pin-worklist">
					<thead>
						<tr>
							<th scope="col">Kasus</th>
							<th scope="col">Pertanyaan</th>
							<th scope="col">Pin</th>
							<th scope="col">Dikonfirmasi</th>
							<th scope="col">Status versi</th>
						</tr>
					</thead>
					<tbody>
						{cases.map((c) => (
							<tr
								key={c.caseId}
								data-case={c.caseKey}
								data-active={activeCase?.caseId === c.caseId}
							>
								<td>
									<button type="button" onClick={() => void openCase(c)}>
										{c.caseKey}
									</button>
								</td>
								<td>{c.queryText.slice(0, 80)}</td>
								<td>{c.pinCount}</td>
								<td>{c.confirmedCount}</td>
								<td>{c.versionStatus}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}

			{activeCase ? (
				<div className="pin-case" data-testid="pin-case">
					<h3>
						{activeCase.caseKey} — {activeCase.queryText}
					</h3>
					{suggestNotice ? (
						<p className="pin-review-notice">{suggestNotice}</p>
					) : null}

					<div className="pin-review-controls">
						<label htmlFor="pin-search">
							Pencarian korpus manual (jalur anti-sirkular)
							<input
								id="pin-search"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								placeholder="cari passage di luar saran…"
							/>
						</label>
						<button
							type="button"
							onClick={() => void manualSearch()}
							disabled={searching}
						>
							{searching ? 'mencari…' : 'Cari'}
						</button>
					</div>

					<ul className="pin-candidates" data-testid="pin-candidates">
						{selection.candidates.map((c) => {
							const choice = selection.choices[c.unitId] ?? null
							return (
								<li
									key={c.unitId}
									data-unit={c.unitId}
									data-choice={choice ?? 'none'}
								>
									<span className="pin-candidate-text">
										{c.text.slice(0, 160)}
										{c.sourceTitle ? ` — ${c.sourceTitle}` : ''}
										<em> [{c.origin === 'manual' ? 'manual' : c.lane}]</em>
									</span>
									<span className="pin-candidate-actions">
										<button
											type="button"
											aria-pressed={choice === 'must'}
											onClick={() =>
												setSelection((prev) =>
													setChoice(prev, c.unitId, 'must'),
												)
											}
										>
											Wajib
										</button>
										<button
											type="button"
											aria-pressed={choice === 'may'}
											onClick={() =>
												setSelection((prev) => setChoice(prev, c.unitId, 'may'))
											}
										>
											Boleh
										</button>
										<button
											type="button"
											aria-pressed={choice === null}
											onClick={() =>
												setSelection((prev) => setChoice(prev, c.unitId, null))
											}
										>
											Tolak
										</button>
									</span>
								</li>
							)
						})}
					</ul>

					<div className="pin-save-row">
						<span data-testid="pin-selected-count">
							Terpilih: {selectedCount(selection)}
						</span>
						<button
							type="button"
							className="btn-primary"
							onClick={() => void savePins()}
							disabled={saving}
						>
							{saving ? 'menyimpan…' : 'Simpan pin'}
						</button>
					</div>
				</div>
			) : null}
		</section>
	)
}
