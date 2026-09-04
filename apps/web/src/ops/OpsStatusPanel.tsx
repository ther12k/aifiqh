import { formatTimestampId } from '../lib/format'
import {
	type ComponentView,
	type OpsFailureLike,
	type OpsStatusPayloadLike,
	buildComponentViews,
	categoryLabel,
	deriveOverallBanner,
	filterFailures,
	linkLabel,
	severityLabel,
} from '../lib/opsStatus'
import type { FailureFilter } from '../lib/opsStatus'

/**
 * Operations status panel (OPS-001): one surface where an operator
 * distinguishes outage from data failure, sees stale health marked,
 * filters the failure ledger by subsystem/severity, and follows
 * drill-down + runbook links to the related record.
 */
export function OpsStatusPanel(props: {
	status: OpsStatusPayloadLike
	failures: OpsFailureLike[]
	filter?: FailureFilter
}) {
	const { status, failures, filter = {} } = props
	const banner = deriveOverallBanner(status.overall)
	const components: ComponentView[] = buildComponentViews(status.components)
	const visible = filterFailures(failures, filter)

	return (
		<div className="ops-status" aria-label="Status operasional">
			<output
				className={`ops-banner ops-banner-${banner.tone}`}
				data-testid="ops-banner"
			>
				{banner.title} — {banner.detail}
			</output>
			<p className="ops-generated">
				Diperbarui {formatTimestampId(status.generatedAt)}
			</p>

			<ul className="ops-components" data-testid="ops-components">
				{components.map((c) => {
					// line = "<health> · <category>[ · <failure counts>]": the
					// health segment becomes the badge, the rest stays as meta
					const segments = c.line.split(' · ')
					const badgeText = segments[0]
					const metaText = segments.slice(1).join(' · ')
					return (
						<li
							key={c.key}
							className="ops-component"
							data-component={c.key}
							data-category={c.category}
						>
							<span className="ops-component-top">
								<span className="ops-component-name">{c.name}</span>
								<span className="ops-state">{badgeText}</span>
							</span>
							<span className="ops-component-meta">
								{metaText} ·{' '}
								{c.lastEventAt
									? `peristiwa ${formatTimestampId(c.lastEventAt)}`
									: 'tidak ada peristiwa'}
							</span>
							{c.primaryFailure ? (
								<span className="ops-component-primary">
									{severityLabel(c.primaryFailure.severity)} ·{' '}
									{c.primaryFailure.subsystem}/{c.primaryFailure.code}:{' '}
									{c.primaryFailure.message}{' '}
									<a href={c.primaryFailure.runbook}>runbook</a>
								</span>
							) : null}
						</li>
					)
				})}
			</ul>

			<section className="ops-drilldown" aria-label="Rincian kegagalan">
				<h4>
					Kegagalan ({visible.length}) — subsistem:{' '}
					{Object.entries(status.failuresBySubsystem)
						.map(([subsystem, n]) => `${subsystem} ${n}`)
						.join(', ') || '—'}
					{filter.subsystem ? ` · filter=${filter.subsystem}` : ''}
					{filter.severity ? ` · severitas=${filter.severity}` : ''}
				</h4>
				<ul className="ops-failures" data-testid="ops-failures">
					{visible.map((f) => (
						<li
							key={f.id}
							className="ops-failure"
							data-subsystem={f.subsystem}
							data-severity={f.severity}
						>
							<span className="ops-failure-head">
								<span
									className={`ops-sev ops-sev-${f.severity}`}
									data-testid="ops-severity"
								>
									{severityLabel(f.severity)}
								</span>
								<span className="ops-failure-where">
									{f.subsystem}/{f.code} @ {f.componentKey}
								</span>
								<time
									className="ops-failure-time"
									dateTime={f.occurredAt}
									title={f.occurredAt}
								>
									{formatTimestampId(f.occurredAt)}
								</time>
							</span>
							<span className="ops-failure-message">{f.message}</span>
							<span className="ops-failure-links">
								{f.links.map((l) => (
									<a key={l.href} href={l.href}>
										{linkLabel(l.kind)}
									</a>
								))}
								<a href={f.runbook}>runbook</a>
							</span>
						</li>
					))}
					{visible.length === 0 ? (
						<li className="ops-failure-empty" data-testid="ops-failures-empty">
							Tidak ada kegagalan pada filter ini.
						</li>
					) : null}
				</ul>
			</section>
		</div>
	)
}
