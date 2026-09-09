import { describe, expect, test } from 'bun:test'
import { isNavItemActive, routePath } from '../src/App'
import { authGuardDecision } from '../src/lib/routes'

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

describe('auth route guard', () => {
	test('public routes always render, even before /auth/me resolves', () => {
		expect(authGuardDecision('/', false, false)).toBe('allow')
		expect(authGuardDecision('/sources', false, false)).toBe('allow')
		expect(authGuardDecision('/health', true, false)).toBe('allow')
	})

	test('protected route waits for /auth/me before deciding', () => {
		expect(authGuardDecision('/chat', false, false)).toBe('loading')
		expect(authGuardDecision('/chat?x=1', false, true)).toBe('loading')
	})

	test('protected route allows signed-in and redirects anonymous', () => {
		expect(authGuardDecision('/chat', true, true)).toBe('allow')
		expect(authGuardDecision('/chat/', true, false)).toBe('redirect')
	})
})
