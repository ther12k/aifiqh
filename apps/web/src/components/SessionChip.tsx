import { ICON_PATHS, NavIcon } from './icons'

/** the identity fields the shells need from /auth/me */
export interface SessionUser {
	userId: string
	tenantId?: string
	permissions: string[]
}

/** the strongest role the permission set implies — for the identity chip */
export function roleLabel(permissions: string[]): string {
	if (permissions.includes('config:manage')) return 'Admin'
	if (permissions.includes('review:approve')) return 'Peninjau'
	if (permissions.includes('knowledge:draft')) return 'Editor'
	if (permissions.includes('knowledge:read')) return 'Pembaca'
	return 'Pengguna'
}

export function roleAccent(permissions: string[]): string {
	if (permissions.includes('config:manage')) return 'accent-admin'
	if (permissions.includes('review:approve')) return 'accent-reviewer'
	if (permissions.includes('knowledge:draft')) return 'accent-editor'
	return 'accent-reader'
}

/** avatar + role + tenant + logout, pinned to the bottom of a sidebar */
export function SessionChip({
	me,
	onLogout,
	loginLinks,
}: {
	me: SessionUser | null
	onLogout: () => void
	/** rendered instead of the chip when nobody is signed in */
	loginLinks?: React.ReactNode
}) {
	if (!me) {
		return (
			<div className="login-links">
				{loginLinks}
				<a href="/auth/login">
					<NavIcon d={ICON_PATHS.logout} />
					Masuk (OIDC)
				</a>
			</div>
		)
	}
	return (
		<div className="session-chip">
			<span
				className={`avatar ${roleAccent(me.permissions)}`}
				aria-hidden="true"
			>
				{me.userId.slice(0, 2).toUpperCase()}
			</span>
			<span className="who">
				<b>{roleLabel(me.permissions)}</b>
				<span>
					{me.tenantId ? `tenant ${me.tenantId.slice(0, 8)}` : 'no tenant'}
				</span>
			</span>
			<button type="button" onClick={onLogout}>
				Keluar
			</button>
		</div>
	)
}
