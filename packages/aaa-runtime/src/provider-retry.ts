/**
 * Transient provider failures worth an automatic retry: rate limits, gateway
 * hiccups, socket drops and timeouts. Auth, malformed requests and hard quota
 * exhaustion surface immediately.
 */
const TRANSIENT_PROVIDER_ERROR_PATTERN =
	/\b(?:408|409|425|429|500|502|503|504)\b|rate.?limit|too many requests|timed? ?out|etimedout|econnreset|econnrefused|epipe|socket hang up|fetch failed|network|stream (?:error|ended unexpectedly)| overloaded/i;
const NON_RETRIABLE_QUOTA_PATTERN = /\b1310\b|weekly\/?monthly|usage (?:cap|quota)|使用上限|限额将在.*重置/i;

const RETRY_BACKOFF_MS = [1_500, 4_000, 10_000];
const DEFAULT_PROVIDER_ATTEMPT_TIMEOUT_MS = 180_000;

export function resolveProviderAttemptTimeoutMs(): number {
	const configured = Number(process.env.AAA_PROVIDER_ATTEMPT_TIMEOUT_MS);
	return Number.isFinite(configured) && configured >= 1_000
		? Math.min(900_000, Math.floor(configured))
		: DEFAULT_PROVIDER_ATTEMPT_TIMEOUT_MS;
}

/** Deadline for one HTTP/SSE attempt; the outer retry owner gets a TimeoutError. */
export function createProviderAttemptSignal(
	parent: AbortSignal,
	timeoutMs = resolveProviderAttemptTimeoutMs(),
): AbortSignal {
	if (parent.aborted) return parent;
	const controller = new AbortController();
	const timer = setTimeout(
		() => {
			controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
		},
		Math.max(1, timeoutMs),
	);
	// A completed request must not keep the CLI alive until the attempt deadline,
	// while an active network request/test runner still lets this timer fire.
	timer.unref();
	const onParentAbort = (): void => controller.abort(parent.reason);
	parent.addEventListener("abort", onParentAbort, { once: true });
	controller.signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			parent.removeEventListener("abort", onParentAbort);
		},
		{ once: true },
	);
	return controller.signal;
}

/** Structured HTTP failure so retry policy does not have to scrape strings. */
export class ProviderHttpError extends Error {
	readonly status: number;
	readonly retryAfterMs?: number;
	readonly providerCode?: string;
	readonly hardQuota: boolean;

	constructor(
		message: string,
		options: { status: number; retryAfterMs?: number; providerCode?: string; hardQuota?: boolean },
	) {
		super(message);
		this.name = "ProviderHttpError";
		this.status = options.status;
		this.retryAfterMs = options.retryAfterMs;
		this.providerCode = options.providerCode;
		this.hardQuota = options.hardQuota === true;
	}
}

export function retryAfterMilliseconds(response: Response, now = Date.now()): number | undefined {
	const raw = response.headers.get("retry-after")?.trim();
	if (!raw) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
	const date = Date.parse(raw);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function providerErrorCode(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { error?: { code?: unknown }; code?: unknown };
		const code = parsed.error?.code ?? parsed.code;
		return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
	} catch {
		return undefined;
	}
}

export function isHardQuotaFailure(message: string, code?: string): boolean {
	return code === "1310" || NON_RETRIABLE_QUOTA_PATTERN.test(message);
}

async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>(resolve => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

function shouldRetry(error: unknown, message: string): boolean {
	if (error instanceof ProviderHttpError) {
		if (error.hardQuota || isHardQuotaFailure(message, error.providerCode)) return false;
		return [408, 409, 425, 429, 500, 502, 503, 504].includes(error.status);
	}
	return !NON_RETRIABLE_QUOTA_PATTERN.test(message) && TRANSIENT_PROVIDER_ERROR_PATTERN.test(message);
}

/**
 * Retries a provider turn up to three extra times. This is the single retry
 * owner: transports perform exactly one HTTP attempt (apart from a 401 token
 * refresh), preventing nested retries from amplifying a 429 into 12 requests.
 */
export async function withTransientRetry<T>(
	signal: AbortSignal,
	attempt: () => Promise<T>,
	onRetry?: (attemptNumber: number, delayMs: number, error: unknown) => void,
	delaysOverride?: readonly number[],
): Promise<T> {
	const delays = delaysOverride ?? RETRY_BACKOFF_MS;
	for (let attemptIndex = 0; ; attemptIndex += 1) {
		try {
			return await attempt();
		} catch (error) {
			const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			const retriable = !signal.aborted && attemptIndex < delays.length && shouldRetry(error, message);
			if (!retriable) throw error;
			const configured = delays[attemptIndex] ?? 0;
			const requested = error instanceof ProviderHttpError ? error.retryAfterMs : undefined;
			const baseDelay = Math.max(configured, requested ?? 0);
			// Deterministic override keeps tests predictable; production jitter avoids
			// synchronized retry storms across subagents/processes.
			const delayMs = delaysOverride ? baseDelay : Math.ceil(baseDelay * (0.85 + Math.random() * 0.3));
			onRetry?.(attemptIndex + 1, delayMs, error);
			await sleepUnlessAborted(delayMs, signal);
			if (signal.aborted) throw error;
		}
	}
}

interface PermitWaiter {
	resolve(release: () => void): void;
	reject(error: Error): void;
	signal: AbortSignal;
	onAbort(): void;
}

class ProviderConcurrencyGate {
	#active = 0;
	#limit: number;
	#queue: PermitWaiter[] = [];

	constructor(limit: number) {
		this.#limit = Math.max(1, Math.floor(limit));
	}

	constrain(limit: number): void {
		// The strictest live caller wins. This is intentional for a shared
		// provider/account where one GLM session requires serial requests.
		this.#limit = Math.min(this.#limit, Math.max(1, Math.floor(limit)));
	}

	async acquire(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) throw new DOMException("Provider request aborted", "AbortError");
		if (this.#active < this.#limit) {
			this.#active += 1;
			return this.#releaseOnce();
		}
		return await new Promise<() => void>((resolve, reject) => {
			const waiter: PermitWaiter = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = this.#queue.indexOf(waiter);
					if (index >= 0) this.#queue.splice(index, 1);
					reject(new DOMException("Provider request aborted", "AbortError"));
				},
			};
			this.#queue.push(waiter);
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		});
	}

	#releaseOnce(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#active = Math.max(0, this.#active - 1);
			this.#drain();
		};
	}

	#drain(): void {
		while (this.#active < this.#limit && this.#queue.length > 0) {
			const waiter = this.#queue.shift();
			if (!waiter) return;
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal.aborted) continue;
			this.#active += 1;
			waiter.resolve(this.#releaseOnce());
		}
	}
}

const providerGates = new Map<string, ProviderConcurrencyGate>();

/** Global per-process provider/account semaphore shared by all subagents. */
export async function withProviderPermit<T>(
	key: string,
	limit: number,
	signal: AbortSignal,
	run: () => Promise<T>,
	onAcquired?: (waitMs: number) => void,
): Promise<T> {
	let gate = providerGates.get(key);
	if (!gate) {
		gate = new ProviderConcurrencyGate(limit);
		providerGates.set(key, gate);
	} else {
		gate.constrain(limit);
	}
	const waitingAt = performance.now();
	const release = await gate.acquire(signal);
	onAcquired?.(performance.now() - waitingAt);
	try {
		return await run();
	} finally {
		release();
	}
}

/** Test/process reset; production callers normally never need this. */
export function resetProviderConcurrencyGates(): void {
	providerGates.clear();
}
