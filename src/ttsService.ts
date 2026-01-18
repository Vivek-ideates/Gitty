import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { elevenLabsTtsMp3 } from "./elevenlabsTts";

export async function speakText(
	context: vscode.ExtensionContext,
	text: string,
	opts?: { voiceId: string; modelId: string; outputFormat: string },
): Promise<void> {
	const channel = vscode.window.createOutputChannel("Gitty");

	// Check config
	const config = vscode.workspace.getConfiguration("gitty");
	const enabled = config.get<boolean>("elevenlabs.enabled", false);
	if (!enabled) {
		return;
	}

	// Secrets
	const apiKey = await context.secrets.get("gitty.elevenlabs.apiKey");
	if (!apiKey) {
		channel.appendLine(
			"[TTS] Error: No API key found. Use 'Gitty: Set ElevenLabs API Key'.",
		);
		return;
	}

	// Parameters
	const voiceId =
		opts?.voiceId ?? config.get<string>("elevenlabs.voiceId") ?? "";
	const modelId =
		opts?.modelId ??
		config.get<string>("elevenlabs.modelId") ??
		"eleven_turbo_v2_5";
	const outputFormat =
		opts?.outputFormat ??
		config.get<string>("elevenlabs.outputFormat") ??
		"mp3_22050_32";

	if (!voiceId) {
		channel.appendLine("[TTS] Error: No Voice ID configured.");
		return;
	}

	try {
        // channel.appendLine(`[TTS] Generating audio for: "${text.substring(0, 20)}..."`);
		const mp3 = await elevenLabsTtsMp3({
			apiKey,
			voiceId,
			text,
			modelId,
			outputFormat,
		});

		const storagePath = context.globalStorageUri.fsPath;
		if (!fs.existsSync(storagePath)) {
			await fs.promises.mkdir(storagePath, { recursive: true });
		}

		const tempFilePath = path.join(
			storagePath,
			`gitty-tts-${Date.now()}.mp3`,
		);
		await fs.promises.writeFile(tempFilePath, mp3);

		if (os.platform() === "darwin") {
			await new Promise<void>((resolve) => {
				const proc = spawn("afplay", [tempFilePath]);
				proc.on("close", () => resolve());
				proc.on("error", (e) => {
					channel.appendLine(`[TTS] Playback error: ${e.message}`);
					resolve();
				});
			});
			// Cleanup
			await fs.promises.unlink(tempFilePath).catch(() => {});
		} else {
			channel.appendLine(
				"[TTS] Playback skipped: Platform is not macOS.",
			);
            await fs.promises.unlink(tempFilePath).catch(() => {});
		}
	} catch (error: any) {
		channel.appendLine(`[TTS] Generation Error: ${error.message}`);
	}
}
