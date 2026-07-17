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

	flushAll(): void {
		this.cache.clear()
	}

	close(): void {
		this.cache.clear()
	}
}
