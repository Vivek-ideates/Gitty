import * as vscode from "vscode";

export interface GittyConfig {
	voiceEnabled: boolean;
	wakeWord: string;
	picovoiceAccessKey: string;
	porcupineKeyword: string;
	porcupineSensitivity: number;
	voskEnabled: boolean;
	groqEnabled: boolean;
	groqApiKey: string;
	groqModel: string;
	elevenLabsEnabled: boolean;
	elevenLabsVoiceId: string;
	elevenLabsModelId: string;
	elevenLabsOutputFormat: string;
}

export function readConfig(): GittyConfig {
	const cfg = vscode.workspace.getConfiguration("gitty");

	const voiceEnabled = cfg.get<boolean>("voice.enabled", false);
	const wakeWord = cfg.get<string>("voice.wakeWord", "Hey Gitty");
	const picovoiceAccessKey = cfg.get<string>("picovoice.accessKey", "");
	const porcupineKeyword = cfg.get<string>("picovoice.keyword", "hey-gitty");
	let porcupineSensitivity = cfg.get<number>("picovoice.sensitivity", 0.6);

	// Clamp sensitivity
	if (porcupineSensitivity < 0) {
		porcupineSensitivity = 0;
	} else if (porcupineSensitivity > 1) {
		porcupineSensitivity = 1;
	}

	const voskEnabled = cfg.get<boolean>("vosk.enabled", false);
	const groqEnabled = cfg.get<boolean>("groq.enabled", false);
	const groqApiKey = cfg.get<string>("groq.apiKey", "");
	const groqModel = cfg.get<string>("groq.model", "");

	const elevenLabsEnabled = cfg.get<boolean>("elevenlabs.enabled", false);
	const elevenLabsVoiceId = cfg.get<string>("elevenlabs.voiceId", "");
	const elevenLabsModelId = cfg.get<string>(
		"elevenlabs.modelId",
		"eleven_turbo_v2_5",
	);
	const elevenLabsOutputFormat = cfg.get<string>(
		"elevenlabs.outputFormat",
		"mp3_22050_32",
	);

	return {
		voiceEnabled,
		wakeWord,
		picovoiceAccessKey,
		porcupineKeyword,
		porcupineSensitivity,
		voskEnabled,
		groqEnabled,
		groqApiKey,
		groqModel,
		elevenLabsEnabled,
		elevenLabsVoiceId,
		elevenLabsModelId,
		elevenLabsOutputFormat,
	};
}
