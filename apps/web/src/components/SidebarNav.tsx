import { isNavItemActive } from '../lib/routes'
import { ICON_PATHS, NavIcon } from './icons'

/**
 * Role-aware navigation (single config — no scattered conditionals).
 * Each item declares the permission that reveals it; the sidebar only
 * renders what the current principal may open. The server remains the
 * authorization authority — this only shapes the menu.
 */
export interface NavItemDef {
	href: string
	label: string
	icon: string
	permission: string
	section: 'menu' | 'system'
}

export const NAV_ITEMS: NavItemDef[] = [
	{
		href: '#/chat',
		label: 'Chat',
		icon: ICON_PATHS.chat,
		permission: 'knowledge:read',
		section: 'menu',
	},
	{
		href: '#/sources',
		label: 'Sumber',
		icon: ICON_PATHS.book,
		permission: 'source:read',
		section: 'menu',
	},
	{
		href: '#/studio',
		label: 'Knowledge Studio',
		icon: ICON_PATHS.edit,
		permission: 'knowledge:draft',
		section: 'menu',
	},
	{
		href: '#/reviewer',
		label: 'Tinjauan Klaim',
		icon: ICON_PATHS.shield,
		permission: 'review:approve',
		section: 'menu',
	},
	{
		href: '#/studio-dashboard',
		label: 'Dashboard',
		icon: ICON_PATHS.grid,
		permission: 'ops:read',
		section: 'menu',
	},
	{
		href: '#/ops',
		label: 'Operations',
		icon: ICON_PATHS.activity,
		permission: 'ops:read',
		section: 'system',
	},
	{
		href: '#/health',
		label: 'Health',
		icon: ICON_PATHS.pulse,
		permission: 'ops:read',
		section: 'system',
	},
	{
		href: '#/admin-models',
		label: 'Pengaturan AI',
		icon: ICON_PATHS.gear,
		permission: 'config:manage',
		section: 'system',
	},
]

/** nav items visible to the given permission set, grouped per section */
export function navSectionsFor(permissions: string[]): Array<{
	label: string
	items: NavItemDef[]
}> {
	const allowed = NAV_ITEMS.filter((i) => permissions.includes(i.permission))
	const sections: Array<{ label: string; items: NavItemDef[] }> = []
	for (const section of ['menu', 'system'] as const) {
		const items = allowed.filter((i) => i.section === section)
		if (items.length > 0) {
			sections.push({ label: section === 'menu' ? 'Menu' : 'Sistem', items })
		}
	}
	return sections
}

export function SidebarNav({
	permissions,
	route,
	onNavigate,
	hideHref,
}: {
	permissions: string[]
	route: string
	/** fired after a link is clicked (closes mobile drawers) */
	onNavigate?: () => void
	/** one nav destination to omit (the chat sidebar lists Chat separately) */
	hideHref?: string
}) {
	return (
		<nav className="sidebar-nav" aria-label="Navigasi utama">
			{navSectionsFor(permissions)
				.map((section) => ({
					...section,
					items: section.items.filter((item) => item.href !== hideHref),
				}))
				.filter((section) => section.items.length > 0)
				.map((section) => (
					<div className="nav-section" key={section.label}>
						<div className="nav-section-label">{section.label}</div>
						{section.items.map((item) => {
							const active = isNavItemActive(route, item.href)
							return (
								<a
									key={item.href}
									href={item.href}
									className={active ? 'active-nav' : ''}
									aria-current={active ? 'page' : undefined}
									onClick={onNavigate}
								>
									<NavIcon d={item.icon} />
									{item.label}
								</a>
							)
						})}
					</div>
				))}
		</nav>
	)
}
