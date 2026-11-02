// A small stand-in for Cloudflare D1, backed by real SQLite (better-sqlite3).
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

class Statement {
	constructor(
		private readonly db: Database.Database,
		private readonly sql: string,
		private readonly params: unknown[] = [],
	) {}
	bind(...params: unknown[]) {
		return new Statement(this.db, this.sql, params);
	}
	async first<T>(): Promise<T | null> {
		return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
	}
	async all<T>(): Promise<{ results: T[] }> {
		return { results: this.db.prepare(this.sql).all(...this.params) as T[] };
	}
	// Shaped like D1's result, so code can check meta.changes.
	async run() {
		return this.runSync();
	}
	runSync() {
		const info = this.db.prepare(this.sql).run(...this.params);
		return { success: true, meta: { changes: info.changes } };
	}
}

export class FakeD1 {
	readonly db = new Database(":memory:");
	constructor() {
		for (const file of ["0001_init.sql", "0002_retries.sql", "0003_time_zones.sql", "0004_lifecycle.sql", "0005_limits.sql", "0006_feature_requests.sql"]) {
			this.db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
		}
	}
	prepare(sql: string) {
		return new Statement(this.db, sql);
	}
	async batch(statements: Statement[]) {
		return this.db.transaction(() => statements.map((s) => s.runSync()))();
	}
}
