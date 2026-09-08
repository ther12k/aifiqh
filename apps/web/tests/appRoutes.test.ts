import { describe, expect, test } from 'bun:test'
import { isNavItemActive, routePath } from '../src/App'

describe('navigation route matching', () => {
	test('normalizes query strings and trailing slashes', () => {
		expect(routePath('/sources?revision=rev-1')).toBe('/sources')
		expect(routePath('/sources/')).toBe('/sources')
		expect(routePath('')).toBe('/')
	})

	test('keeps parent navigation active for nested source routes', () => {
		expect(isNavItemActive('/sources/rev-1?span=s1', '#/sources')).toBeTrue()
		expect(isNavItemActive('/studio-dashboard', '#/studio')).toBeFalse()
		expect(isNavItemActive('/', '#/')).toBeTrue()
		expect(isNavItemActive('/ops/details', '#/')).toBeFalse()
	})
})
