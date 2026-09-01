import type {
	CanonicalFootnote,
	CanonicalPage,
	CanonicalSection,
	CanonicalSpan,
	ProcessingWarning,
	ProcessorCapabilities,
	ProcessorInput,
	ProcessorOutput,
	ProcessorPlugin,
} from '@aifiqh/shared'
import { generateStableSpanKey } from '../../../api/src/sources/spanResolver'

/**
 * TXT Processor: converts plain text files into canonical sections and spans.
 */
export class TxtProcessor implements ProcessorPlugin {
	readonly name = 'txt-processor'
	readonly version = '1.0.0'
	readonly capabilities: ProcessorCapabilities = {
		supportedMimeTypes: ['text/plain'],
		supportsPageNumbers: false,
		supportsBoundingBoxes: false,
		supportsFootnotes: false,
		supportsStructureTree: false,
		supportsOcr: false,
	}

	async process(input: ProcessorInput): Promise<ProcessorOutput> {
		const text = new TextDecoder('utf-8').decode(input.file.buffer)
		const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
		const warnings: ProcessingWarning[] = []

		if (paragraphs.length === 0 && text.trim().length === 0) {
			warnings.push({
				code: 'EMPTY_FILE',
				message: 'Plain text file contains no content',
			})
		}

		const sections: CanonicalSection[] = [
			{ ordinal: 1, heading: 'Document Body' },
		]
		const spans: CanonicalSpan[] = []
		let offset = 0

		paragraphs.forEach((p, idx) => {
			const clean = p.trim()
			const startOffset = text.indexOf(p, offset)
			const endOffset =
				startOffset >= 0 ? startOffset + p.length : offset + p.length
			offset = endOffset

			const spanKey = generateStableSpanKey(null, 1, idx + 1, clean)
			spans.push({
				spanKey,
				originalText: clean,
				sectionOrdinal: 1,
				pageNumber: null,
				startOffset: startOffset >= 0 ? startOffset : null,
				endOffset: endOffset >= 0 ? endOffset : null,
			})
		})

		return {
			pages: [{ pageNumber: 1 }],
			sections,
			spans,
			warnings,
		}
	}
}

/**
 * Markdown Processor: extracts headings (# .. ######) into section hierarchies
 * and captures paragraphs and footnotes ([^marker]: footnote text).
 */
export class MarkdownProcessor implements ProcessorPlugin {
	readonly name = 'markdown-processor'
	readonly version = '1.0.0'
	readonly capabilities: ProcessorCapabilities = {
		supportedMimeTypes: ['text/markdown', 'text/x-markdown'],
		supportsPageNumbers: false,
		supportsBoundingBoxes: false,
		supportsFootnotes: true,
		supportsStructureTree: true,
		supportsOcr: false,
	}

	async process(input: ProcessorInput): Promise<ProcessorOutput> {
		const text = new TextDecoder('utf-8').decode(input.file.buffer)
		const lines = text.split(/\r?\n/)
		const warnings: ProcessingWarning[] = []

		const sections: CanonicalSection[] = []
		const spans: CanonicalSpan[] = []
		const footnotes: CanonicalFootnote[] = []
		const anchorMap = new Map<string, string>()

		let currentSectionOrdinal = 1
		sections.push({ ordinal: currentSectionOrdinal, heading: 'Introduction' })

		// Heading stack for nesting: level -> ordinal
		const headingStack: { level: number; ordinal: number }[] = []
		let spanOrdinal = 0
		let currentParagraph: string[] = []

		const flushParagraph = () => {
			if (currentParagraph.length === 0) return
			const content = currentParagraph.join(' ').trim()
			currentParagraph = []
			if (!content) return

			spanOrdinal++
			const spanKey = generateStableSpanKey(
				null,
				currentSectionOrdinal,
				spanOrdinal,
				content,
			)
			spans.push({
				spanKey,
				originalText: content,
				sectionOrdinal: currentSectionOrdinal,
				pageNumber: null,
			})

			// Check for inline footnote reference: [^marker]
			const fnRefMatch = content.match(/\[\^([^\]]+)\](?!:)/)
			if (fnRefMatch) {
				const marker = fnRefMatch[1]
				anchorMap.set(marker, spanKey)
			}
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const trimmed = line.trim()

			// Check for Footnote definition: [^1]: Footnote body
			const fnDefMatch = trimmed.match(/^\[\^([^\]]+)\]:\s*(.+)$/)
			if (fnDefMatch) {
				flushParagraph()
				const marker = fnDefMatch[1]
				const fnText = fnDefMatch[2].trim()
				spanOrdinal++
				const fnSpanKey = generateStableSpanKey(
					null,
					currentSectionOrdinal,
					spanOrdinal,
					fnText,
				)
				spans.push({
					spanKey: fnSpanKey,
					originalText: fnText,
					sectionOrdinal: currentSectionOrdinal,
					pageNumber: null,
				})

				const anchorKey = anchorMap.get(marker) ?? fnSpanKey
				footnotes.push({
					marker,
					anchorSpanKey: anchorKey,
					noteSpanKey: fnSpanKey,
				})
				continue
			}

			// Check for Headings: # Heading 1, ## Heading 2, etc.
			const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
			if (headingMatch) {
				flushParagraph()
				const level = headingMatch[1].length
				const headingTitle = headingMatch[2].trim()

				currentSectionOrdinal = sections.length + 1

				// Determine parent ordinal based on heading hierarchy
				while (
					headingStack.length > 0 &&
					headingStack[headingStack.length - 1].level >= level
				) {
					headingStack.pop()
				}
				const parentOrdinal =
					headingStack.length > 0
						? headingStack[headingStack.length - 1].ordinal
						: null

				sections.push({
					ordinal: currentSectionOrdinal,
					heading: headingTitle,
					parentOrdinal,
				})
				headingStack.push({ level, ordinal: currentSectionOrdinal })
				continue
			}

			if (trimmed.length === 0) {
				flushParagraph()
			} else {
				currentParagraph.push(trimmed)
			}
		}

		flushParagraph()

		if (spans.length === 0) {
			warnings.push({
				code: 'EMPTY_FILE',
				message: 'Markdown file contains no readable text spans',
			})
		}

		return {
			pages: [{ pageNumber: 1 }],
			sections,
			spans,
			footnotes,
			warnings,
		}
	}
}

/**
 * Sanitized HTML Processor: Strips dangerous scripts/styles, extracts headings and paragraphs.
 */
export class HtmlProcessor implements ProcessorPlugin {
	readonly name = 'html-processor'
	readonly version = '1.0.0'
	readonly capabilities: ProcessorCapabilities = {
		supportedMimeTypes: ['text/html', 'application/xhtml+xml'],
		supportsPageNumbers: false,
		supportsBoundingBoxes: false,
		supportsFootnotes: false,
		supportsStructureTree: true,
		supportsOcr: false,
	}

	async process(input: ProcessorInput): Promise<ProcessorOutput> {
		const rawHtml = new TextDecoder('utf-8').decode(input.file.buffer)
		const warnings: ProcessingWarning[] = []

		if (/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi.test(rawHtml)) {
			warnings.push({
				code: 'SCRIPTS_STRIPPED',
				message:
					'Potentially dangerous <script> tags were removed during parsing',
			})
		}

		// Sanitize HTML by removing scripts, styles, iframes, and dangerous handlers
		const sanitized = rawHtml
			.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
			.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
			.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
			.replace(/on\w+="[^"]*"/gi, '')
			.replace(/on\w+='[^']*'/gi, '')

		const sections: CanonicalSection[] = [
			{ ordinal: 1, heading: 'HTML Root Section' },
		]
		const spans: CanonicalSpan[] = []
		let currentSectionOrdinal = 1
		let spanOrdinal = 0

		// Tokenize elements by basic tags
		const tagRegex = /<(h[1-6]|p|div|li|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi
		for (const match of sanitized.matchAll(tagRegex)) {
			const tag = match[1].toLowerCase()
			const innerText = match[2]
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
			if (!innerText) continue

			if (tag.startsWith('h')) {
				currentSectionOrdinal = sections.length + 1
				sections.push({
					ordinal: currentSectionOrdinal,
					heading: innerText,
					parentOrdinal: 1,
				})
			} else {
				spanOrdinal++
				const spanKey = generateStableSpanKey(
					null,
					currentSectionOrdinal,
					spanOrdinal,
					innerText,
				)
				spans.push({
					spanKey,
					originalText: innerText,
					sectionOrdinal: currentSectionOrdinal,
					pageNumber: null,
				})
			}
		}

		// Fallback for flat body text if no paragraph tags found
		if (spans.length === 0) {
			const bodyText = sanitized
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
			if (bodyText) {
				const spanKey = generateStableSpanKey(null, 1, 1, bodyText)
				spans.push({
					spanKey,
					originalText: bodyText,
					sectionOrdinal: 1,
					pageNumber: null,
				})
			} else {
				warnings.push({
					code: 'EMPTY_HTML',
					message: 'HTML file contains no extractable text content',
				})
			}
		}

		return {
			pages: [{ pageNumber: 1 }],
			sections,
			spans,
			warnings,
		}
	}
}
