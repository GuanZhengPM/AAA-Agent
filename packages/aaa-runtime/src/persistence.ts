import * as fs from "node:fs/promises";
import * as path from "node:path";

async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} catch (error) {
		if (!(error instanceof Error && "code" in error && (error.code === "EINVAL" || error.code === "ENOTSUP"))) {
			throw error;
		}
	} finally {
		await handle.close();
	}
}

function isTransientWindowsRenameError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return error.code === "EACCES" || error.code === "EBUSY" || error.code === "EPERM";
}

async function renameAtomically(source: string, destination: string): Promise<void> {
	if (process.platform !== "win32") {
		await fs.rename(source, destination);
		return;
	}

	// Windows can temporarily deny replacement while another process, antivirus,
	// or a concurrent reader still holds the destination. Keep the old file in
	// place and retry the atomic rename instead of unlinking it and exposing a
	// missing or partially written session file.
	const deadline = Date.now() + 5_000;
	let attempt = 0;
	while (true) {
		try {
			await fs.rename(source, destination);
			return;
		} catch (error) {
			if (!isTransientWindowsRenameError(error) || Date.now() >= deadline) throw error;
			attempt += 1;
			await new Promise<void>(resolve => setTimeout(resolve, Math.min(10 * attempt, 100)));
		}
	}
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	const directory = path.dirname(filePath);
	await fs.mkdir(directory, { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(tempPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await renameAtomically(tempPath, filePath);
		await syncDirectory(directory);
	} finally {
		await handle?.close();
		await fs.rm(tempPath, { force: true });
	}
}
