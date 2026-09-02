import type { AnswerViewModel } from '../lib/answerView'
import { sectionEvidence, sectionLabel } from '../lib/answerView'

/**
 * Structured answer rendering (CHAT-003).
 *
 * Each schema section renders as its own block with a fixed label — the
 * UI never parses prose to find structure. Claims under a section link
 * their evidence explicitly (direct quotes shown verbatim, synthesis
 * labeled as such). Optional sections absent from the payload simply do
 * not render — no empty frames. Unsafe HTML was already stripped in the
 * view model; everything renders as plain text nodes. An invalid payload
 * shows the typed fallback banner instead of a partial guess.
 */

const DIRECT_LABEL = 'kutipan langsung'
const SYNTHESIS_LABEL = 'sintesis'

export function AnswerView({ model }: { model: AnswerViewModel }) {
	if (model.fallbackReason) {
		return (
			<div className="answer-fallback" role="alert">
				{model.fallbackReason}
			</div>
		)
	}
	return (
		<article className="answer-view">
			{model.sections.map((section) => {
				const evidence = sectionEvidence(model, section)
				return (
					<section
						key={`${section.kind}-${sectionClaimKey(section.claimIds)}`}
						data-kind={section.kind}
					>
						<h3>{sectionLabel(section.kind)}</h3>
						<p>{section.text}</p>
						{evidence.length > 0 ? (
							<ul className="answer-evidence">
								{evidence.map(({ claim, link }) => (
									<li key={`${claim.id}-${link.evidenceId}`}>
										<a
											href={`#evidence/${link.evidenceId}`}
											data-evidence-id={link.evidenceId}
										>
											Bukti {link.evidenceId.slice(0, 8)}
										</a>
										<span data-relation={link.relation}>
											{link.relation === 'direct'
												? DIRECT_LABEL
												: SYNTHESIS_LABEL}
										</span>
										{link.quote ? <q>{link.quote}</q> : null}
										{claim.madhhab ? (
											<span className="answer-madhhab">— {claim.madhhab}</span>
										) : null}
									</li>
								))}
							</ul>
						) : null}
					</section>
				)
			})}
		</article>
	)
}

function sectionClaimKey(claimIds: string[]): string {
	return claimIds.join(',')
}
