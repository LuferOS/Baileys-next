import { LRUCache } from 'lru-cache'
import type { CacheStore } from '../Types/Socket'

export class NodeCacheAdapter<T extends {}> implements CacheStore {
	private cache: LRUCache<string, T>

	constructor(options: LRUCache.Options<string, T, unknown>) {
		this.cache = new LRUCache(options)
	}

	get<U>(key: string): U | undefined {
		return this.cache.get(key) as unknown as U
	}

	set<U>(key: string, value: U): void {
		this.cache.set(key, value as unknown as T)
	}

	del(key: string): void {
		this.cache.delete(key)
	}

	mget<U>(keys: string[]): Record<string, U | undefined> {
		const result: Record<string, U | undefined> = {}
		for (const key of keys) {
			result[key] = this.cache.get(key) as unknown as U
		}

		return result
	}

	mset<U>(data: Record<string, U>): void {
		for (const key in data) {
			this.cache.set(key, data[key] as unknown as T)
		}
	}

	flushAll(): void {
		this.cache.clear()
	}

	close(): void {
		this.cache.clear()
	}
}
