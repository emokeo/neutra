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
	async run() {
		return this.db.prepare(this.sql).run(...this.params);
	}
	runSync() {
		return this.db.prepare(this.sql).run(...this.params);
	}
}

export class FakeD1 {
	readonly db = new Database(":memory:");
	constructor() {
		this.db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
	}
	prepare(sql: string) {
		return new Statement(this.db, sql);
	}
	async batch(statements: Statement[]) {
		return this.db.transaction(() => statements.map((s) => s.runSync()))();
	}
}
