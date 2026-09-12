/**
 * Generation-mode badge (AI-003): makes visible whether an answer was
 * synthesized by the LLM over the corpus or composed deterministically —
 * silent fallback is the failure mode this exists to prevent. Pure logic,
 * so the mapping stays unit-testable.
 */

export interface GenerationMetadata {
	mode: 'llm_rag' | 'deterministic_rag'
	provider: string
	model: string
	/** why the LLM path did not run (null when it did / unknown for old rows) */
	fallbackReason: string | null
}

export interface GenerationBadge {
	label: string
	tone: 'ai' | 'sources'
	/** plain-language tooltip — no jargon, no model names */
	title: string
	/** operator-only detail line (provider/model + reason code) */
	detail: string | null
}

/** plain Indonesian phrase per fallback reason (stable API codes) */
const REASON_PHRASES: Record<string, string> = {
	model_not_configured: 'model AI belum dikonfigurasi',
	secret_unavailable: 'kunci API tidak tersedia',
	ambiguous_model_config: 'konfigurasi model ambigu',
	kill_switch: 'AI dimatikan pada lingkungan ini',
	provider_error: 'penyedia AI tidak dapat dihubungi',
	invalid_output: 'keluaran AI tidak valid',
	citation_validation_failed: 'kutipan AI gagal diverifikasi',
}

function reasonPhrase(reason: string | null): string {
	if (!reason) return ''
	return REASON_PHRASES[reason] ?? 'alasan teknis tidak diketahui'
}

/**
 * Badge config for an answer's generation metadata. Returns null when the
 * metadata is absent (answers created before AI-002) so old threads render
 * exactly as before.
 */
export function generationBadge(
	generation: GenerationMetadata | null | undefined,
	isOperator = false,
): GenerationBadge | null {
	if (!generation) return null
	if (generation.mode === 'llm_rag') {
		return {
			label: '✦ AI + Sumber',
			tone: 'ai',
			title:
				'Jawaban disintesis AI dari sumber terverifikasi — setiap klaim tetap dilengkapi kutipan.',
			detail: isOperator
				? [generation.provider, generation.model].filter(Boolean).join(' / ')
				: null,
		}
	}
	const phrase = reasonPhrase(generation.fallbackReason)
	return {
		label: 'Kutipan otomatis — bukan kesimpulan AI',
		tone: 'sources',
		title: phrase
			? `Hasil ini adalah kutipan sumber yang diambil otomatis, bukan kesimpulan AI — ${phrase}.`
			: 'Hasil ini adalah kutipan sumber yang diambil otomatis, bukan kesimpulan AI.',
		detail: isOperator
			? [
					[generation.provider, generation.model].filter(Boolean).join(' / '),
					generation.fallbackReason,
				]
					.filter(Boolean)
					.join(' · ')
			: null,
	}
}
