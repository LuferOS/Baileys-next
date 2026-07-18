import * as constants from './constants'
import { type FullJid, jidDecode } from './jid-utils'
import type { BinaryNode, BinaryNodeCodingOptions } from './types'

class WABinaryEncoder {
	private opts: Pick<BinaryNodeCodingOptions, 'TAGS' | 'TOKEN_MAP'>
	private buffer: number[]

	constructor(opts: Pick<BinaryNodeCodingOptions, 'TAGS' | 'TOKEN_MAP'>, buffer: number[]) {
		this.opts = opts
		this.buffer = buffer
	}

	private pushByte(value: number) {
		this.buffer.push(value & 0xff)
	}

	private pushInt(value: number, n: number, littleEndian = false) {
		for (let i = 0; i < n; i++) {
			const curShift = littleEndian ? i : n - 1 - i
			this.buffer.push((value >> (curShift * 8)) & 0xff)
		}
	}

	private pushBytes(bytes: Uint8Array | Buffer | number[]) {
		for (const b of bytes) {
			this.buffer.push(b)
		}
	}

	private pushInt16(value: number) {
		this.pushBytes([(value >> 8) & 0xff, value & 0xff])
	}

	private pushInt20(value: number) {
		this.pushBytes([(value >> 16) & 0x0f, (value >> 8) & 0xff, value & 0xff])
	}

	private writeByteLength(length: number) {
		if (length >= 4294967296) {
			throw new Error('string too large to encode: ' + length)
		}

		if (length >= 1 << 20) {
			this.pushByte(this.opts.TAGS.BINARY_32)
			this.pushInt(length, 4) // 32 bit integer
		} else if (length >= 256) {
			this.pushByte(this.opts.TAGS.BINARY_20)
			this.pushInt20(length)
		} else {
			this.pushByte(this.opts.TAGS.BINARY_8)
			this.pushByte(length)
		}
	}

	private writeStringRaw(str: string) {
		const bytes = Buffer.from(str, 'utf-8')
		this.writeByteLength(bytes.length)
		this.pushBytes(bytes)
	}

	private writeJid({ domainType, device, user, server }: FullJid) {
		if (typeof device !== 'undefined') {
			this.pushByte(this.opts.TAGS.AD_JID)
			this.pushByte(domainType || 0)
			this.pushByte(device || 0)
			this.writeString(user)
		} else {
			this.pushByte(this.opts.TAGS.JID_PAIR)
			if (user.length) {
				this.writeString(user)
			} else {
				this.pushByte(this.opts.TAGS.LIST_EMPTY)
			}

			this.writeString(server)
		}
	}

	private packNibble(char: string) {
		switch (char) {
			case '-':
				return 10
			case '.':
				return 11
			case '\0':
				return 15
			default:
				if (char >= '0' && char <= '9') {
					return char.charCodeAt(0) - '0'.charCodeAt(0)
				}

				throw new Error(`invalid byte for nibble "${char}"`)
		}
	}

	private packHex(char: string) {
		if (char >= '0' && char <= '9') {
			return char.charCodeAt(0) - '0'.charCodeAt(0)
		}

		if (char >= 'A' && char <= 'F') {
			return 10 + char.charCodeAt(0) - 'A'.charCodeAt(0)
		}

		if (char >= 'a' && char <= 'f') {
			return 10 + char.charCodeAt(0) - 'a'.charCodeAt(0)
		}

		if (char === '\0') {
			return 15
		}

		throw new Error(`Invalid hex char "${char}"`)
	}

	private writePackedBytes(str: string, type: 'nibble' | 'hex') {
		if (str.length > this.opts.TAGS.PACKED_MAX) {
			throw new Error('Too many bytes to pack')
		}

		this.pushByte(type === 'nibble' ? this.opts.TAGS.NIBBLE_8 : this.opts.TAGS.HEX_8)

		let roundedLength = Math.ceil(str.length / 2.0)
		if (str.length % 2 !== 0) {
			roundedLength |= 128
		}

		this.pushByte(roundedLength)
		const packFunction = type === 'nibble' ? this.packNibble : this.packHex

		const packBytePair = (v1: string, v2: string) => {
			const result = (packFunction(v1) << 4) | packFunction(v2)
			return result
		}

		const strLengthHalf = Math.floor(str.length / 2)
		for (let i = 0; i < strLengthHalf; i++) {
			this.pushByte(packBytePair(str[2 * i]!, str[2 * i + 1]!))
		}

		if (str.length % 2 !== 0) {
			this.pushByte(packBytePair(str[str.length - 1]!, '\x00'))
		}
	}

	private isNibble(str?: string) {
		if (!str || str.length > this.opts.TAGS.PACKED_MAX) {
			return false
		}

		for (const char of str) {
			const isInNibbleRange = char >= '0' && char <= '9'
			if (!isInNibbleRange && char !== '-' && char !== '.') {
				return false
			}
		}

		return true
	}

	private isHex(str?: string) {
		if (!str || str.length > this.opts.TAGS.PACKED_MAX) {
			return false
		}

		for (const char of str) {
			const isInNibbleRange = char >= '0' && char <= '9'
			if (!isInNibbleRange && !(char >= 'A' && char <= 'F')) {
				return false
			}
		}

		return true
	}

	private writeString(str?: string) {
		if (str === undefined || str === null) {
			this.pushByte(this.opts.TAGS.LIST_EMPTY)
			return
		}

		if (str === '') {
			this.writeStringRaw(str)
			return
		}

		const tokenIndex = this.opts.TOKEN_MAP[str]
		if (tokenIndex) {
			if (typeof tokenIndex.dict === 'number') {
				this.pushByte(this.opts.TAGS.DICTIONARY_0 + tokenIndex.dict)
			}

			this.pushByte(tokenIndex.index)
		} else if (this.isNibble(str)) {
			this.writePackedBytes(str, 'nibble')
		} else if (this.isHex(str)) {
			this.writePackedBytes(str, 'hex')
		} else {
			const decodedJid = jidDecode(str)
			if (decodedJid) {
				this.writeJid(decodedJid)
			} else {
				this.writeStringRaw(str)
			}
		}
	}

	private writeListStart(listSize: number) {
		if (listSize === 0) {
			this.pushByte(this.opts.TAGS.LIST_EMPTY)
		} else if (listSize < 256) {
			this.pushBytes([this.opts.TAGS.LIST_8, listSize])
		} else {
			this.pushByte(this.opts.TAGS.LIST_16)
			this.pushInt16(listSize)
		}
	}

	public encodeNode({ tag, attrs, content }: BinaryNode) {
		if (!tag) {
			throw new Error('Invalid node: tag cannot be undefined')
		}

		const validAttributes = Object.keys(attrs || {}).filter(k => typeof attrs[k] !== 'undefined' && attrs[k] !== null)

		this.writeListStart(2 * validAttributes.length + 1 + (typeof content !== 'undefined' ? 1 : 0))
		this.writeString(tag)

		for (const key of validAttributes) {
			if (typeof attrs[key] === 'string') {
				this.writeString(key)
				this.writeString(attrs[key])
			}
		}

		if (typeof content === 'string') {
			this.writeString(content)
		} else if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
			this.writeByteLength(content.length)
			this.pushBytes(content)
		} else if (Array.isArray(content)) {
			const validContent = content.filter(
				item => item && (item.tag || Buffer.isBuffer(item) || item instanceof Uint8Array || typeof item === 'string')
			)
			this.writeListStart(validContent.length)
			for (const item of validContent) {
				this.encodeNode(item)
			}
		} else if (typeof content === 'undefined') {
			// do nothing
		} else {
			throw new Error(`invalid children for header "${tag}": ${content} (${typeof content})`)
		}
	}
}

export const encodeBinaryNode = (
	node: BinaryNode,
	opts: Pick<BinaryNodeCodingOptions, 'TAGS' | 'TOKEN_MAP'> = constants,
	buffer: number[] = [0]
): Buffer => {
	const encoder = new WABinaryEncoder(opts, buffer)
	encoder.encodeNode(node)
	return Buffer.from(buffer)
}
