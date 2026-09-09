/**
 * Shared inline icon set (no external icon dependency).
 * The brand mark follows the Taffaqquh AI identity: a mihrab arch
 * (Islamic context) framing a speech bubble (AI dialogue) above an
 * open book (sources/knowledge), with a gold base line.
 */

export const ICON_PATHS: Record<string, string> = {
	chat: 'M4 5h16v11H8l-4 4V5z',
	book: 'M5 4h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H5V4zm18 0h-6a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h6V4z',
	edit: 'M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3zM14 7l3 3',
	grid: 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z',
	activity: 'M3 12h4l3-8 4 16 3-8h4',
	pulse: 'M3 12h4l2-5 4 10 2-5h6',
	logout: 'M9 4H5v16h4M14 8l4 4-4 4M8 12h10',
	home: 'M4 11l8-7 8 7v9h-5v-6h-6v6H4v-9z',
	moon: 'M20 13.5A8 8 0 1 1 10.5 4 6.5 6.5 0 0 0 20 13.5z',
	star: 'M12 3l2.5 5.5L20 9.3l-4 4 .9 5.7L12 16.8 7.1 19l.9-5.7-4-4 5.5-.8L12 3z',
	plus: 'M12 5v14M5 12h14',
	check: 'M4 12l5 5L20 6',
	shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z',
	heart:
		'M12 20s-7-4.5-9-9c-1.5-3.5 1-7 4.5-7 2 0 3.5 1 4.5 2.7C13.5 5 15 4 17 4c3.5 0 6 3.5 4.5 7-2 4.5-9 9-9 9z',
	gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z',
	close: 'M18 6L6 18M6 6l12 12',
}

export function NavIcon({ d }: { d: string }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={d} />
		</svg>
	)
}

export function SearchIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<circle cx="11" cy="11" r="7" />
			<path d="M20 20l-3.5-3.5" />
		</svg>
	)
}

export function BrandMark({ small }: { small?: boolean }) {
	const size = small ? 26 : 40
	return (
		<svg
			className="brand-mark"
			width={size}
			height={size}
			viewBox="0 0 48 48"
			fill="none"
			aria-hidden="true"
		>
			{/* mihrab arch */}
			<path
				d="M24 3.2C15.2 9.8 9.8 15.4 9.8 24.8V39h28.4V24.8c0-9.4-5.4-15-14.2-21.6z"
				stroke="#0d6b4f"
				strokeWidth="2.6"
				strokeLinejoin="round"
				fill="#fff"
			/>
			{/* speech bubble */}
			<path
				d="M24 11.6c5.1 0 9.2 3.2 9.2 7.4s-4.1 7.4-9.2 7.4c-.9 0-1.75-.1-2.55-.28l-4.05 2.08 1.05-3.5c-2.2-1.32-3.65-3.4-3.65-5.7 0-4.2 4.1-7.4 9.2-7.4z"
				fill="#0d6b4f"
			/>
			<circle cx="20.4" cy="19" r="1.25" fill="#fff" />
			<circle cx="24" cy="19" r="1.25" fill="#fff" />
			<circle cx="27.6" cy="19" r="1.25" fill="#fff" />
			{/* open book */}
			<path
				d="M24 30.4c-2.4-1.9-5.3-2.7-8.6-2.7-1.2 0-2.35.12-3.4.34v9c1.05-.22 2.2-.34 3.4-.34 3.3 0 6.2.82 8.6 2.7 2.4-1.88 5.3-2.7 8.6-2.7 1.2 0 2.35.12 3.4.34v-9c-1.05-.22-2.2-.34-3.4-.34-3.3 0-6.2.8-8.6 2.7z"
				stroke="#0d6b4f"
				strokeWidth="2"
				strokeLinejoin="round"
				fill="#fff"
			/>
			<path
				d="M24 30.6v8.8"
				stroke="#0d6b4f"
				strokeWidth="2"
				strokeLinecap="round"
			/>
			{/* gold base line */}
			<path
				d="M13 42.4h22"
				stroke="#c99a4b"
				strokeWidth="2.4"
				strokeLinecap="round"
			/>
		</svg>
	)
}
