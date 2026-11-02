import { beforeEach, describe, expect, it } from "vitest";
import { createFeatureRequest, FEATURE_REQUESTS_PER_DAY, getFeatureRequest, scrub } from "../src/feedback";
import { FakeD1 } from "./fake-d1";

const anna = { email: "anna@example.com", name: "Anna", client: "Claude" };
const ben = { email: "ben@example.com", name: "Ben" };
let db: FakeD1;
let env: Env;

beforeEach(() => {
	db = new FakeD1();
	env = { DB: db, COOKIE_ENCRYPTION_KEY: "test-key" } as unknown as Env;
});

describe("scrub", () => {
	it("removes emails, links and phone numbers", () => {
		expect(scrub("Mail ben@example.com or call +41 79 123 45 67, see https://x.example/a")).toBe(
			"Mail [removed] or call [removed], see [removed]",
		);
	});
});

describe("feature requests", () => {
	it("stores a scrubbed summary under a pseudonymous author, readable only by its author", async () => {
		const created = await createFeatureRequest(env, anna, "Let three friends pick a restaurant. Ask anna@example.com");
		expect(created.name).toMatch(/^featureRequests\/[a-z][a-z2-7]{25}$/);
		expect(created.summary).toBe("Let three friends pick a restaurant. Ask [removed]");

		expect((await getFeatureRequest(env, anna, created.name)).summary).toBe(created.summary);
		await expect(getFeatureRequest(env, ben, created.name)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

		const stored = JSON.stringify(db.db.prepare("SELECT * FROM feature_requests").all());
		expect(stored).not.toContain("anna@example.com");
		expect(stored).not.toContain("Anna");
		expect(stored).toContain("Claude");
	});

	it("refuses empty or too long text", async () => {
		await expect(createFeatureRequest(env, anna, "   ")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await expect(createFeatureRequest(env, anna, "x".repeat(501))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
	});

	it(`allows ${FEATURE_REQUESTS_PER_DAY} per person per day`, async () => {
		for (let i = 0; i < FEATURE_REQUESTS_PER_DAY; i++) await createFeatureRequest(env, anna, `idea ${i}`);
		await expect(createFeatureRequest(env, anna, "one more")).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
		await expect(createFeatureRequest(env, ben, "mine")).resolves.toBeTruthy();
	});
});
