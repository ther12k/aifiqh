import {
	type AiMetricsReportLike,
	fallbackReasonLabel,
	formatCost,
	formatCount,
	formatRate,
	formatSloTarget,
	formatSloValue,
	formatTokens,
	reasonEntries,
	sloStatusLabel,
} from '../lib/aiMetrics'
import { formatTimestampId } from '../lib/format'

/**
 * AI/RAG telemetry panel (OPS-AI-001): generation quality, deterministic
 * fallback reasons, citation/claim-support failure rates, offline
 * retrieval recall, provider latency and tokens-per-turn cost — next to
 * the component health panel on the ops dashboard.
 */
export function AiMetricsPanel(props: { report: AiMetricsReportLike }) {
	const { report } = props
	const g = report.generation

	return (
		<section className="ai-metrics" aria-label="Telemetri AI / RAG">
			<h3>
				Telemetri AI / RAG — {report.windowHours} jam terakhir ·{' '}
				{report.turns.total} giliran ({report.turns.answered} terjawab,{' '}
				{report.turns.abstained} abstain, {report.turns.escalated} eskalasi,{' '}
				{report.turns.failed} gagal)
			</h3>

			{report.slos && report.slos.length > 0 ? (
				<section
					className="ai-slos"
					aria-label="SLO produksi"
					data-testid="ai-slos"
				>
					<h4>
						SLO Produksi —{' '}
						{report.slos.filter((s) => s.status === 'met').length}/
						{report.slos.length} terpenuhi ·{' '}
						{report.slos.filter((s) => s.status === 'breached').length} melewati
						batas · {report.slos.filter((s) => s.status === 'no_data').length}{' '}
						belum ada data
					</h4>
					<table className="ai-provider-table" data-testid="ai-slo-table">
						<thead>
							<tr>
								<th scope="col">SLO</th>
								<th scope="col">Target</th>
								<th scope="col">Aktual</th>
								<th scope="col">Status</th>
							</tr>
						</thead>
						<tbody>
							{report.slos.map((s) => (
								<tr key={s.key} data-slo={s.key} data-slo-status={s.status}>
									<td>{s.label}</td>
									<td>{formatSloTarget(s.target, s.comparator, s.unit)}</td>
									<td>{formatSloValue(s.actual, s.unit)}</td>
									<td>
										<span
											className={`ops-state ${
												s.status === 'no_data' ? 'ai-slo-nodata' : ''
											}`}
											data-testid="ai-slo-status"
										>
											{sloStatusLabel(s.status)}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : null}

			<ul className="ai-metrics-cards" data-testid="ai-metric-cards">
				<li className="ai-metric" data-metric="generation-success">
					<span className="ai-metric-label">Keberhasilan generasi (upaya)</span>
					<span className="ai-metric-value">
						{formatRate(g.attemptSuccessRate)}
					</span>
					<span className="ai-metric-meta">
						{g.successfulAttempts}/{g.attempts} upaya model
					</span>
				</li>
				<li className="ai-metric" data-metric="fallback-rate">
					<span className="ai-metric-label">Fallback deterministik</span>
					<span className="ai-metric-value">
						{formatRate(g.turnFallbackRate)}
					</span>
					<span className="ai-metric-meta">
						{g.fallbackTurns}/{report.turns.generationStage} giliran generasi
					</span>
				</li>
				<li className="ai-metric" data-metric="citation-failure">
					<span className="ai-metric-label">Kegagalan validasi sitasi</span>
					<span className="ai-metric-value">
						{formatRate(report.citationValidation.failureRate)}
					</span>
					<span className="ai-metric-meta">
						{report.citationValidation.failedAttempts}/
						{report.citationValidation.attempts} upaya
					</span>
				</li>
				<li className="ai-metric" data-metric="claim-support-failure">
					<span className="ai-metric-label">Klaim tanpa dukungan bukti</span>
					<span className="ai-metric-value">
						{formatRate(report.claimSupport.failureRate)}
					</span>
					<span className="ai-metric-meta">
						{report.claimSupport.failedAnswers}/{report.claimSupport.evaluated}{' '}
						jawaban
					</span>
				</li>
				<li className="ai-metric" data-metric="tokens-per-turn">
					<span className="ai-metric-label">Token per giliran</span>
					<span className="ai-metric-value">
						{formatCount(report.tokens.avgPromptTokens)} +{' '}
						{formatCount(report.tokens.avgCompletionTokens)}
					</span>
					<span className="ai-metric-meta">
						prompt + completion · biaya{' '}
						{formatCost(report.tokens.totalCost, report.tokens.currency)}
						{report.tokens.unpricedCalls > 0
							? ` · ${report.tokens.unpricedCalls} panggilan tanpa harga`
							: ''}
					</span>
				</li>
				<li className="ai-metric" data-metric="offline-recall">
					<span className="ai-metric-label">Recall retrieval (offline)</span>
					<span className="ai-metric-value">
						{formatRate(report.retrievalOffline?.avgRecallAtK ?? null)}
					</span>
					<span className="ai-metric-meta">
						{report.retrievalOffline
							? `${report.retrievalOffline.setKey} · ${report.retrievalOffline.caseCount} kasus`
							: 'belum ada run evaluasi'}
					</span>
				</li>
			</ul>

			<div className="ai-metrics-detail">
				<div className="ai-metrics-col" data-testid="ai-fallback-reasons">
					<h4>
						Alasan fallback deterministik ({g.fallbackTurns} giliran) ·
						perbaikan {g.repair.succeeded}/{g.repair.attempted}
					</h4>
					<ul className="ai-reasons">
						{reasonEntries(g.fallbackByReason).map((e) => (
							<li key={e.reason} data-reason={e.reason}>
								{fallbackReasonLabel(e.reason)}: {e.count}
							</li>
						))}
						{Object.keys(g.fallbackByReason).length === 0 ? (
							<li className="ai-reasons-empty">Tidak ada fallback.</li>
						) : null}
					</ul>
				</div>
				<div className="ai-metrics-col" data-testid="ai-understanding">
					<h4>
						Tahap pemahaman — degradasi rewriter{' '}
						{report.understanding.rewriteDegradations} · planner{' '}
						{report.understanding.plannerDegradations}
					</h4>
					<ul className="ai-reasons">
						{reasonEntries(report.understanding.rewriteFallbackByReason).map(
							(e) => (
								<li key={`rw-${e.reason}`} data-reason={e.reason}>
									rewriter: {fallbackReasonLabel(e.reason)} — {e.count}
								</li>
							),
						)}
						{reasonEntries(report.understanding.plannerFallbackByReason).map(
							(e) => (
								<li key={`pl-${e.reason}`} data-reason={e.reason}>
									planner: {fallbackReasonLabel(e.reason)} — {e.count}
								</li>
							),
						)}
						{report.understanding.rewriteDegradations === 0 &&
						report.understanding.plannerDegradations === 0 ? (
							<li className="ai-reasons-empty">Tidak ada degradasi.</li>
						) : null}
					</ul>
				</div>
			</div>

			<section className="ai-providers" aria-label="Latensi dan biaya provider">
				<h4>Provider</h4>
				<table className="ai-provider-table" data-testid="ai-provider-table">
					<thead>
						<tr>
							<th scope="col">Provider / model</th>
							<th scope="col">Panggilan</th>
							<th scope="col">Latensi rata-rata</th>
							<th scope="col">p95</th>
							<th scope="col">Token</th>
							<th scope="col">Biaya</th>
						</tr>
					</thead>
					<tbody>
						{report.providers.map((p) => (
							<tr key={`${p.provider}/${p.model}`} data-provider={p.provider}>
								<td>
									{p.provider} / {p.model}
								</td>
								<td>{p.calls}</td>
								<td>
									{p.avgLatencyMs === null ? '—' : `${p.avgLatencyMs} ms`}
								</td>
								<td>
									{p.p95LatencyMs === null ? '—' : `${p.p95LatencyMs} ms`}
								</td>
								<td>
									{formatTokens(p.promptTokens)} +{' '}
									{formatTokens(p.completionTokens)}
								</td>
								<td>{formatCost(p.costUsd, null)}</td>
							</tr>
						))}
						{report.providers.length === 0 ? (
							<tr className="ai-providers-empty">
								<td colSpan={6}>Belum ada panggilan model pada jendela ini.</td>
							</tr>
						) : null}
					</tbody>
				</table>
			</section>

			<p className="ai-generated">
				Diperbarui {formatTimestampId(report.generatedAt)}
			</p>
		</section>
	)
}
