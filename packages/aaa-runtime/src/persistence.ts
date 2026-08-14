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
		await fs.rename(tempPath, filePath);
		await syncDirectory(directory);
	} finally {
		await handle?.close();
		await fs.rm(tempPath, { force: true });
	}
}
