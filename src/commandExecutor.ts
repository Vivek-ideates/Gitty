import * as cp from "child_process";
import * as vscode from "vscode";

export type RiskLevel = "low" | "high";

export interface RunOptions {
	cwd: string;
	timeoutMs?: number;
}

export interface RunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export function assessRisk(command: string): RiskLevel {
	if (command.trim().startsWith("git ")) {
		return "low";
	}
	return "high";
}

export function briefExplain(command: string): string {
	if (command.trim().startsWith("git ")) {
		return "Runs a git command in this repo.";
	}
	return "Runs a shell command in the current workspace folder.";
}

export async function runShellCommandCaptured(
	command: string,
	opts: RunOptions,
): Promise<RunResult> {
	return new Promise((resolve) => {
		const timeoutMs = opts.timeoutMs ?? 20000;
		let timedOut = false;

		const child = cp.spawn(command, {
			shell: true,
			cwd: opts.cwd,
		});

		let stdout = "";
		let stderr = "";

		if (child.stdout) {
			child.stdout.on("data", (data) => {
				stdout += data.toString();
			});
		}

		if (child.stderr) {
			child.stderr.on("data", (data) => {
				stderr += data.toString();
			});
		}

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: code,
				stdout,
				stderr,
				timedOut,
			});
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			// In case of error (like spawn failed), treat as error result
			resolve({
				exitCode: -1,
				stdout,
				stderr: stderr + "\n" + err.message,
				timedOut,
			});
		});
	});
}

export async function verifyAndRunCaptured(
	command: string,
	opts: RunOptions,
	ui: {
		confirmLow(msg: string): Promise<boolean>;
		confirmHigh(msg: string): Promise<boolean>;
	},
	output: vscode.OutputChannel,
): Promise<RunResult | null> {
	const risk = assessRisk(command);
	const explanation = briefExplain(command);

	if (risk === "low") {
		const confirmed = await ui.confirmLow(`Run command: "${command}"?`);
		if (!confirmed) {
			return null;
		}
	} else {
		// High risk: Two-step confirmation
		const step1 = await ui.confirmHigh(
			`High-risk command detected: "${command}"... Continue?`,
		);
		if (!step1) {
			return null;
		}
		const step2 = await ui.confirmHigh("Are you sure you want to run it now?");
		if (!step2) {
			return null;
		}
	}

	// Run command
	output.appendLine(`$ ${command}`);
	output.appendLine(`${explanation} (risk: ${risk})`);
	output.show(true);

	const result = await runShellCommandCaptured(command, opts);

	if (result.stdout) {
		output.appendLine(result.stdout);
	}
	if (result.stderr) {
		output.appendLine(result.stderr);
	}
	if (result.timedOut) {
		output.appendLine("[Timed out]");
	}
	if (result.exitCode !== 0 && result.exitCode !== null) {
		output.appendLine(`[Exit code: ${result.exitCode}]`);
	}

	return result;
}
