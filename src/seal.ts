// Sealing the starter's price limit. The limit has to wait somewhere until the other side answers, but
// a copy of the database must not reveal it. So it is encrypted with a key made from the request code,
// which Neutra keeps only as a hash: only someone holding the code (the person answering) can open it.

const INFO = "neutra price limit v1";

function base64url(bytes: Uint8Array): string {
	let text = "";
	for (const b of bytes) text += String.fromCharCode(b);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
	const text = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** AES-GCM key from the code, salted with the decision ID so each request has its own key. */
async function keyFor(code: string, decisionId: string): Promise<CryptoKey> {
	const encoder = new TextEncoder();
	const material = await crypto.subtle.importKey("raw", encoder.encode(code.trim().toLowerCase()), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: encoder.encode(decisionId), info: encoder.encode(INFO) },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

async function sealText(text: string, code: string, decisionId: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(code, decisionId), new TextEncoder().encode(text));
	const out = new Uint8Array(iv.length + sealed.byteLength);
	out.set(iv);
	out.set(new Uint8Array(sealed), iv.length);
	return base64url(out);
}

async function unsealText(sealed: string, code: string, decisionId: string): Promise<string> {
	const bytes = fromBase64url(sealed);
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await keyFor(code, decisionId), bytes.slice(12));
	return new TextDecoder().decode(plain);
}

/** The limit (in smallest units) encrypted for this request: base64url of IV followed by ciphertext. */
export async function sealLimit(minor: number, code: string, decisionId: string): Promise<string> {
	return sealText(String(minor), code, decisionId);
}

/** The limit again. Throws if the code or decision ID is wrong or the value was changed. */
export async function unsealLimit(sealed: string, code: string, decisionId: string): Promise<number> {
	const minor = Number(await unsealText(sealed, code, decisionId));
	if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error("The sealed limit isn't an amount.");
	return minor;
}

/** Both ends of the starter's range, sealed together ("low:high", "inf" for no upper end). */
export async function sealRange(range: { low: number; high: number }, code: string, decisionId: string): Promise<string> {
	return sealText(`${range.low}:${Number.isFinite(range.high) ? range.high : "inf"}`, code, decisionId);
}

export async function unsealRange(sealed: string, code: string, decisionId: string): Promise<{ low: number; high: number }> {
	const [low, high] = (await unsealText(sealed, code, decisionId)).split(":");
	const range = { low: Number(low), high: high === "inf" ? Infinity : Number(high) };
	if (!Number.isSafeInteger(range.low) || !(range.high > range.low)) throw new Error("The sealed range isn't a range.");
	return range;
}
