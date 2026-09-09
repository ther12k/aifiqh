/**
 * Canonical product branding — the single source of truth.
 * Every user-facing name, tagline, and description renders from here;
 * do not hardcode the brand string inside components.
 */
export const BRAND = {
	/** full product name used in titles and formal copy */
	name: 'Taffaqquh AI',
	/** compact wordmark for tight layouts */
	shortName: 'Taffaqquh',
	/** descriptor under the wordmark */
	tagline: 'Asisten Fiqih Berbasis Dalil',
	description:
		'Asisten AI untuk membantu memahami fiqih melalui sumber yang dapat ditelusuri.',
	/** landing eyebrow / campaign line */
	landingTag: 'Ilmu Fiqih, Lebih Mudah, Lebih Terpercaya',
} as const
