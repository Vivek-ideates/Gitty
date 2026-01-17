export interface RepoContext {
	workspaceRoot: string | null;
	gitRoot: string | null;
	preferredCwd: string | null;
	branch: string | null;
	statusPorcelain: string | null;
	updatedAtIso: string;
	isClean?: boolean;
}

export interface SimpleRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

export async function getRepoContext(
	workspaceRoot: string | null,
	runCaptured: (cmd: string, cwd: string) => Promise<SimpleRunResult>,
): Promise<RepoContext> {
	const ctx: RepoContext = {
		workspaceRoot,
		gitRoot: null,
		preferredCwd: workspaceRoot,
		branch: null,
		statusPorcelain: null,
		updatedAtIso: new Date().toISOString(),
		isClean: undefined,
	};

	if (!workspaceRoot) {
		return ctx;
	}

	// 1. Determine git root
	// git rev-parse --show-toplevel
	const gitRootHelpers = await runCaptured(
		"git rev-parse --show-toplevel",
		workspaceRoot,
	);

	if (
		gitRootHelpers.exitCode === 0 &&
		gitRootHelpers.stdout.trim().length > 0
	) {
		ctx.gitRoot = gitRootHelpers.stdout.trim();
		ctx.preferredCwd = ctx.gitRoot;
	} else {
		// Not a git repo or something failed
		return ctx;
	}

	// 2. Get Branch
	// git rev-parse --abbrev-ref HEAD
	if (ctx.gitRoot) {
		const branchRes = await runCaptured(
			"git rev-parse --abbrev-ref HEAD",
			ctx.gitRoot,
		);
		if (branchRes.exitCode === 0 && branchRes.stdout.trim().length > 0) {
			ctx.branch = branchRes.stdout.trim();
		}

		// 3. Get Status Porcelain
		// git status --porcelain=v2 -b
		const statusRes = await runCaptured(
			"git status --porcelain=v2 -b",
			ctx.gitRoot,
		);
		if (statusRes.exitCode === 0) {
			ctx.statusPorcelain = statusRes.stdout.trimEnd();

			// Basic parser for isClean
			// In porcelain v2, normal headers start with '#'
			// Changed files start with '1', '2', 'u', '?' etc.
			// If no lines start with anything other than '#', it's clean (mostly).
			// Or simply checks if there are any file entries.
			const lines = ctx.statusPorcelain.split("\n");
			const hasFileEntries = lines.some(
				(line) => line.trim().length > 0 && !line.startsWith("#"),
			);
			ctx.isClean = !hasFileEntries;
		}
	}

	return ctx;
}
