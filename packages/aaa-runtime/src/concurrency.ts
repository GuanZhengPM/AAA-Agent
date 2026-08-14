/** Ordered, fail-fast concurrency-limited mapping with cooperative cancellation. */
export interface ParallelResult<R> {
	results: (R | undefined)[];
	aborted: boolean;
}

export async function mapWithConcurrencyLimit<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	signal?: AbortSignal,
): Promise<ParallelResult<R>> {
	const normalized = Number.isFinite(concurrency) ? Math.floor(concurrency) : items.length;
	const limit = Math.max(1, Math.min(normalized > 0 ? normalized : items.length, items.length));
	const results: (R | undefined)[] = new Array(items.length);
	const controller = new AbortController();
	const workerSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const firstError = Promise.withResolvers<never>();
	let nextIndex = 0;

	const worker = async (): Promise<void> => {
		while (!workerSignal.aborted) {
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index] as T, index, workerSignal);
			} catch (error) {
				if (!workerSignal.aborted) {
					controller.abort(error);
					firstError.reject(error);
					throw error;
				}
			}
		}
	};

	const workers = Array.from({ length: limit }, () => worker());
	try {
		await Promise.race([Promise.all(workers), firstError.promise]);
	} catch (error) {
		if (signal?.aborted) return { results, aborted: true };
		throw error;
	}
	return { results, aborted: signal?.aborted ?? false };
}
