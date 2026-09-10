import { useCallback, useEffect, useState } from 'react'
import { NavIcon } from '../components/icons'
import {
	type ChainEditState,
	chainAdd,
	chainFromServer,
	chainMove,
	chainPayload,
	chainRemove,
} from '../lib/modelConfigView'

function csrfToken(): string {
	const match = document.cookie.match(/(?:^|;\s*)aifiqh_csrf=([^;]+)/)
	return match ? decodeURIComponent(match[1]) : ''
}

interface ModelConfigPayload {
	alias: string
	primary: {
		providerKey: string
		providerType: string
		modelId: string
		secretSource: string
	} | null
	primaryReason: string
	killSwitch: boolean
	fallbacks: Array<{
		position: number
		targetType: 'provider' | 'model'
		targetId: string
		enabled: boolean
		resolvedLabel: string | null
	}>
	modelOptions: Array<{
		modelConfigId: string
		providerKey: string
		providerType: string
		providerEnabled: boolean
		modelId: string
	}>
	maxAttempts: number
	requireChatModel: boolean
}

const PRIMARY_REASON_LABELS: Record<string, string> = {
	not_configured: 'belum ada model utama yang dikonfigurasi',
	not_configured_or_empty: 'belum ada model utama yang dikonfigurasi',
	kill_switch: 'AI dimatikan pada lingkungan ini (AIFIQH_CHAT_MODEL=off)',
	secret_unavailable: 'kunci API model utama tidak dapat dibaca',
	ambiguous: 'beberapa provider aktif tanpa alias eksplisit',
	disabled_or_empty: 'provider terdaftar tetapi dinonaktifkan / tanpa model',
	resolved: 'berfungsi',
}

/**
 * Admin model configuration (AI-004): shows the chat-production primary
 * and lets config:manage holders edit the ordered fallback chain. The
 * server stays the authority — this only shapes the editing experience.
 */
export function ModelConfig() {
	const [data, setData] = useState<ModelConfigPayload | null>(null)
	const [state, setState] = useState<ChainEditState | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [pickerValue, setPickerValue] = useState('')

	const load = useCallback(async () => {
		try {
			const res = await fetch('/config/model')
			if (!res.ok) throw new Error(`gagal memuat (${res.status})`)
			const body = (await res.json()) as ModelConfigPayload
			setData(body)
			setState(chainFromServer(body.fallbacks))
		} catch (err) {
			setError(err instanceof Error ? err.message : 'gagal memuat konfigurasi')
		}
	}, [])

	useEffect(() => {
		void load()
	}, [load])

	async function save() {
		if (!state) return
		setSaving(true)
		setError(null)
		setNotice(null)
		try {
			const res = await fetch('/config/model/fallbacks', {
				method: 'PUT',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': csrfToken(),
				},
				body: JSON.stringify(chainPayload(state)),
			})
			const body = (await res.json().catch(() => ({}))) as {
				error?: string
				message?: string
			}
			if (!res.ok) {
				throw new Error(body.message ?? `gagal menyimpan (${res.status})`)
			}
			setNotice('Rantai fallback tersimpan — berlaku untuk giliran berikutnya.')
			setState((prev) => (prev ? { ...prev, dirty: false } : prev))
			void load()
		} catch (err) {
			setError(err instanceof Error ? err.message : 'gagal menyimpan')
		} finally {
			setSaving(false)
		}
	}

	if (error && !data) {
		return (
			<section aria-label="Pengaturan model" className="model-config">
				<p role="alert" className="gate-note">
					{error} —{' '}
					<button
						type="button"
						className="link-btn"
						onClick={() => void load()}
					>
						coba perbarui
					</button>
				</p>
			</section>
		)
	}
	if (!data || !state) {
		return (
			<section aria-label="Pengaturan model" className="model-config">
				<p className="gate-note">Memuat konfigurasi model…</p>
			</section>
		)
	}

	const primaryReason =
		PRIMARY_REASON_LABELS[data.primaryReason] ?? data.primaryReason
	const selectable = data.modelOptions.filter(
		(o) =>
			o.providerEnabled &&
			!state.entries.some((e) => e.targetId === o.modelConfigId),
	)

	return (
		<section aria-label="Pengaturan model" className="model-config">
			<div className="model-primary-card">
				<div className="model-primary-head">
					<h3>Model Utama ({data.alias})</h3>
					<span
						className={`badge ${data.primary ? 'badge-ok' : data.killSwitch ? 'badge-neutral' : 'badge-warn'}`}
					>
						{data.primary
							? 'aktif'
							: data.killSwitch
								? 'dimatikan'
								: 'tidak aktif'}
					</span>
				</div>
				{data.primary ? (
					<dl className="model-primary-meta">
						<dt>Provider</dt>
						<dd>
							{data.primary.providerKey} ({data.primary.providerType})
						</dd>
						<dt>Model</dt>
						<dd>{data.primary.modelId}</dd>
						<dt>Kunci API</dt>
						<dd>{data.primary.secretSource}</dd>
					</dl>
				) : (
					<p className="model-primary-note">
						{primaryReason}. Setel model utama dengan{' '}
						<code>scripts/configure_model.ts</code> sebagai langkah deployment
						eksplisit.
					</p>
				)}
				<p className="model-gate-note">
					Verifikasi boot:{' '}
					{data.requireChatModel
						? 'wajib aktif (AIFIQH_REQUIRE_CHAT_MODEL=true)'
						: 'tidak diwajibkan'}{' '}
					· maks. percobaan per giliran: {data.maxAttempts}
				</p>
			</div>

			<div className="model-fallback-card">
				<h3>Rantai Fallback</h3>
				<p className="model-fallback-note">
					Saat model utama gagal (provider error, jawaban tidak valid, atau
					kutipan gagal diverifikasi), model berikutnya dicoba berurutan.
					Giliran tanpa model yang berhasil tetap dijawab dari sumber secara
					deterministik dan ditandai jelas di UI.
				</p>
				{state.entries.length === 0 ? (
					<p className="history-empty">
						Belum ada fallback — kegagalan model langsung turun ke penyusun
						deterministik.
					</p>
				) : (
					<ol className="model-fallback-list">
						{state.entries.map((e) => (
							<li key={e.targetId}>
								<span className="model-fallback-pos">{e.position}</span>
								<span className="model-fallback-label">
									{e.label ?? e.targetId}
								</span>
								<span className="model-fallback-actions">
									<button
										type="button"
										aria-label="Naikkan posisi"
										disabled={e.position === 1}
										onClick={() => setState(chainMove(state, e.position, -1))}
									>
										↑
									</button>
									<button
										type="button"
										aria-label="Turunkan posisi"
										disabled={e.position === state.entries.length}
										onClick={() => setState(chainMove(state, e.position, 1))}
									>
										↓
									</button>
									<button
										type="button"
										aria-label="Hapus dari rantai"
										onClick={() => setState(chainRemove(state, e.position))}
									>
										✕
									</button>
								</span>
							</li>
						))}
					</ol>
				)}

				<div className="model-fallback-add">
					<label>
						<span className="sr-only">Tambah model fallback</span>
						<select
							value={pickerValue}
							onChange={(e) => setPickerValue(e.target.value)}
						>
							<option value="">Tambah model…</option>
							{selectable.map((o) => (
								<option key={o.modelConfigId} value={o.modelConfigId}>
									{o.providerKey} / {o.modelId}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						disabled={!pickerValue}
						onClick={() => {
							const opt = data.modelOptions.find(
								(o) => o.modelConfigId === pickerValue,
							)
							if (!opt) return
							setState(
								chainAdd(state, {
									targetType: 'model',
									targetId: opt.modelConfigId,
									label: `${opt.providerKey} / ${opt.modelId}`,
								}),
							)
							setPickerValue('')
						}}
					>
						<NavIcon d="M12 5v14M5 12h14" />
						Tambah
					</button>
				</div>

				{error && (
					<p role="alert" className="chat-error">
						{error}
					</p>
				)}
				{notice && <output className="feedback-note">{notice}</output>}
				<div className="model-fallback-save">
					<button
						type="button"
						className="btn-primary"
						disabled={!state.dirty || saving}
						onClick={() => void save()}
					>
						{saving ? 'Menyimpan…' : 'Simpan Rantai Fallback'}
					</button>
					{state.dirty && (
						<span className="model-dirty-note">
							ada perubahan belum tersimpan
						</span>
					)}
				</div>
			</div>
		</section>
	)
}
