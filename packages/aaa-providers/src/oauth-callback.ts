export interface BrowserAuthorizationInfo {
	url: string;
	instructions?: string;
}

export interface BrowserAuthorizationOptions {
	provider: string;
	preferredPort: number;
	callbackPath?: string;
	timeoutMs?: number;
	buildAuthorizationUrl(
		state: string,
		redirectUri: string,
	): BrowserAuthorizationInfo | Promise<BrowserAuthorizationInfo>;
	onAuthorization?(info: BrowserAuthorizationInfo & { redirectUri: string }): void;
}

export interface BrowserAuthorizationResult {
	code: string;
	state: string;
	redirectUri: string;
}

export function launchExternalUrl(url: string): void {
	const command =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["rundll32", "url.dll,FileProtocolHandler", url]
				: ["xdg-open", url];
	try {
		Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
	} catch {
		// The caller always prints the direct provider URL; launching is best-effort.
	}
}

function randomState(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

export async function authorizeWithLocalCallback(
	options: BrowserAuthorizationOptions,
	signal?: AbortSignal,
): Promise<BrowserAuthorizationResult> {
	const state = randomState();
	const callbackPath = options.callbackPath ?? "/callback";
	const completion = Promise.withResolvers<{ code: string; state: string }>();
	let settled = false;
	const serve = (port: number): Bun.Server<unknown> =>
		Bun.serve({
			hostname: "127.0.0.1",
			port,
			reusePort: false,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname !== callbackPath) return new Response("Not found", { status: 404 });
				const returnedState = url.searchParams.get("state") ?? "";
				const providerError = url.searchParams.get("error");
				const code = url.searchParams.get("code");
				if (returnedState !== state) return new Response("Authorization failed: state mismatch.", { status: 400 });
				if (providerError) {
					if (!settled) {
						settled = true;
						completion.reject(
							new Error(
								`${options.provider} authorization failed: ${url.searchParams.get("error_description") ?? providerError}`,
							),
						);
					}
					return new Response("Authorization denied. You can close this tab.", { status: 400 });
				}
				if (!code) return new Response("Missing authorization code.", { status: 400 });
				if (!settled) {
					settled = true;
					completion.resolve({ code, state: returnedState });
				}
				return new Response("AAA Agent is authenticated. You can close this tab.", {
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			},
		});

	let server: Bun.Server<unknown>;
	try {
		server = serve(options.preferredPort);
	} catch {
		server = serve(0);
	}
	const port = server.port;
	if (typeof port !== "number") {
		server.stop(true);
		throw new Error(`${options.provider} OAuth callback did not bind a TCP port.`);
	}
	const redirectUri = `http://localhost:${port}${callbackPath}`;
	let combinedSignal: AbortSignal | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const authorization = await options.buildAuthorizationUrl(state, redirectUri);
		options.onAuthorization?.({ ...authorization, redirectUri });
		launchExternalUrl(authorization.url);
		const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000);
		combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		onAbort = (): void => {
			if (settled) return;
			settled = true;
			completion.reject(new Error(`${options.provider} authorization cancelled or timed out.`));
		};
		if (combinedSignal.aborted) onAbort();
		else combinedSignal.addEventListener("abort", onAbort, { once: true });
		const result = await completion.promise;
		return { ...result, redirectUri };
	} finally {
		if (combinedSignal && onAbort) combinedSignal.removeEventListener("abort", onAbort);
		server.stop(true);
	}
}
