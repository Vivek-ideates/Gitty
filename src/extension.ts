import * as vscode from "vscode";
import { TerminalManager } from "./terminalManager";
import {
	verifyAndRunCaptured,
	runShellCommandCaptured,
} from "./commandExecutor";
import { getRepoContext, RepoContext } from "./repoContext";
import { VoiceController, VoiceSnapshot } from "./voiceController";
import { GittyConfig, readConfig } from "./config";
import { WakeWordService } from "./wakeWordService";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import { groqChatComplete } from "./groqClient";
import { CommandPlan, Risk } from "./planTypes";
import { speakText } from "./ttsService";

interface GittyState {
	isListening: boolean;
	lastVerifiedCommand: string | undefined;
	repoContext: RepoContext | undefined;
	voice: VoiceSnapshot;
	config: GittyConfig;
	lastPlan: CommandPlan | undefined;
}

const state: GittyState = {
	isListening: false,
	lastVerifiedCommand: undefined,
	repoContext: undefined,
	voice: { state: "off" },
	config: readConfig(),
	lastPlan: undefined,
};

let statusBarItem: vscode.StatusBarItem;
let currentPanel: vscode.WebviewPanel | undefined = undefined;
let terminalManager: TerminalManager;
let outputChannel: vscode.OutputChannel;
let voiceController: VoiceController;
let wakeWordService: WakeWordService | undefined;
let sttInProgress = false;
let autoPlanExecuteInProgress = false;

export function activate(context: vscode.ExtensionContext) {
	terminalManager = new TerminalManager();
	outputChannel = vscode.window.createOutputChannel("Gitty");

	// Initialize Voice Controller
	voiceController = new VoiceController((snap) => {
		onVoiceChange(snap);
	});

	// Config Listener
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("gitty")) {
				refreshConfig();
			}
		}),
	);

	// Command: Open Coach
	const openCoachCommand = vscode.commands.registerCommand(
		"gitty.openCoach",
		() => {
			setupWebview(context);
		},
	);

	// Command: Refresh Repo Context
	const refreshRepoContextCommand = vscode.commands.registerCommand(
		"gitty.refreshRepoContext",
		async () => {
			const root = getWorkspaceRoot();
			state.repoContext = await getRepoContext(root, runCaptured);

			outputChannel.appendLine(
				`[Repo Context] Refresh at ${state.repoContext.updatedAtIso}`,
			);
			outputChannel.appendLine(
				`  Workspace: ${state.repoContext.workspaceRoot ?? "(none)"}`,
			);
			outputChannel.appendLine(
				`  Git Root:  ${state.repoContext.gitRoot ?? "(none)"}`,
			);
			outputChannel.appendLine(
				`  Branch:    ${state.repoContext.branch ?? "(none)"}`,
			);
			outputChannel.appendLine(
				`  Is Clean:  ${state.repoContext.isClean ?? "unknown"}`,
			);

			broadcastState();
		},
	);

	// Function: Capture Speech Once (Internal Use)
	const sttCaptureOncePy = async () => {
		const text = await runStt(context, 12, 2200);
		if (text) {
			// Auto Plan & Execute
			if (!autoPlanExecuteInProgress) {
				autoPlanExecuteInProgress = true;
				outputChannel.appendLine(
					"Auto: planning + executing from transcript...",
				);
				try {
					await vscode.commands.executeCommand(
						"gitty.planAndExecuteFromTranscript",
					);
				} catch (e: any) {
					outputChannel.appendLine(`Auto Plan Error: ${e.message}`);
				} finally {
					autoPlanExecuteInProgress = false;
				}
			}
		}
	};

	// Function: Capture Voice Confirmation (Internal Use - for now)
	// Not strictly needed in extension.ts unless exposed as a tool
	// but keeping the logic in runStt usage within commandExecutor or extension flows

	// Command: Voice Start
	const voiceStartCommand = vscode.commands.registerCommand(
		"gitty.voiceStart",
		async () => {
			const cfg = readConfig();
			if (!cfg.voiceEnabled) {
				vscode.window.showInformationMessage(
					"Enable gitty.voice.enabled to use wake word",
				);
				return;
			}
			if (!cfg.picovoiceAccessKey) {
				vscode.window.showErrorMessage(
					"Set gitty.picovoice.accessKey in Settings",
				);
				return;
			}

			// Start Voice Controller state
			voiceController.startWakeListening();
			// Best effort context refresh
			vscode.commands.executeCommand("gitty.refreshRepoContext");

			// Start Wake Word Service
			if (!wakeWordService || !wakeWordService.isRunning) {
				try {
					const keywordPath = resolveKeywordPath(context);
					if (!keywordPath) {
						return; // Error already shown
					}

					wakeWordService = new WakeWordService({
						accessKey: cfg.picovoiceAccessKey,
						keywordPath: keywordPath,
						sensitivity: cfg.porcupineSensitivity,
						log: (line) => outputChannel.appendLine(line),
						onWakeWord: async () => {
							if (sttInProgress) {
								return;
							}
							sttInProgress = true;

							// 1. Focus Coach
							vscode.commands.executeCommand("gitty.openCoach");
							// 2. Simulate Wake Word (transition state)
							voiceController.simulateWakeWord();

							try {
								// 3. Trigger One-Shot Capture
								await sttCaptureOncePy();
							} catch (e: any) {
								outputChannel.appendLine(
									`[Gitty] STT Trigger Error: ${e.message}`,
								);
							} finally {
								// 4. Return to wake listening
								voiceController.setBackToWakeListening();
								sttInProgress = false;
							}
						},
					});

					await wakeWordService.start();
					outputChannel.appendLine("[Gitty] Wake word service started.");
				} catch (err: any) {
					vscode.window.showErrorMessage(
						`Failed to start wake word: ${err.message}`,
					);
					outputChannel.appendLine(`[Gitty] Wake word error: ${err.message}`);
				}
			}
			broadcastState();
		},
	);

	// Command: Voice Stop
	const voiceStopCommand = vscode.commands.registerCommand(
		"gitty.voiceStop",
		async () => {
			voiceController.stop();
			if (wakeWordService) {
				await wakeWordService.stop();
				wakeWordService = undefined;
				outputChannel.appendLine("[Gitty] Wake word service stopped.");
			}
			broadcastState();
		},
	);

	// Command: Groq Ping
	const groqPingCommand = vscode.commands.registerCommand(
		"gitty.groqPing",
		async () => {
			const cfg = readConfig();
			if (!cfg.groqEnabled) {
				vscode.window.showErrorMessage("Gitty: Groq is disabled in settings.");
				return;
			}
			if (!cfg.groqApiKey) {
				vscode.window.showErrorMessage("Gitty: Groq API Key is missing.");
				return;
			}

			outputChannel.appendLine("[Gitty] Pinging Groq...");
			try {
				const response = await groqChatComplete({
					apiKey: cfg.groqApiKey,
					model: cfg.groqModel || "llama-3.3-70b-versatile",
					messages: [{ role: "user", content: "Reply with exactly: pong" }],
					temperature: 0,
					maxTokens: 10,
				});

				outputChannel.appendLine(`[Gitty] Groq Response: ${response}`);
				vscode.window.showInformationMessage(`Groq says: ${response}`);
			} catch (e: any) {
				outputChannel.appendLine(`[Gitty] Groq Error: ${e.message}`);
				vscode.window.showErrorMessage(`Groq Ping Failed: ${e.message}`);
			}
		},
	);

	// Command: Execute Last Plan (Verified)
	const executeLastPlanCommand = vscode.commands.registerCommand(
		"gitty.executeLastPlan",
		async () => {
			if (!state.lastPlan) {
				vscode.window.showInformationMessage(
					"No plan yet. Run 'Gitty: Plan Command...' first.",
				);
				return;
			}

			const plan = state.lastPlan;

			// Determine CWD
			let cwd: string;
			if (state.repoContext && state.repoContext.gitRoot) {
				cwd = state.repoContext.gitRoot;
			} else if (
				vscode.workspace.workspaceFolders &&
				vscode.workspace.workspaceFolders.length > 0
			) {
				cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
			} else {
				vscode.window.showErrorMessage("No workspace open to run command.");
				return;
			}

			// Verification Flow based on Risk
			const message = `Run: ${plan.command}\n\nExplanation: ${plan.explanation}`;
			let confirmed = false;

			if (plan.risk === "high") {
				// Two-step confirmation for high risk
				const step1 = await vscode.window.showWarningMessage(
					`[HIGH RISK] ${plan.explanation}. Continue?`,
					{ modal: true },
					"Data Loss Risk: Continue",
					"Cancel",
				);
				if (step1 === "Data Loss Risk: Continue") {
					const step2 = await vscode.window.showWarningMessage(
						`Are you sure you want to run: ${plan.command}?`,
						{ modal: true },
						"Yes, Run It",
						"Cancel",
					);
					confirmed = step2 === "Yes, Run It";
				}
			} else if (plan.risk === "medium") {
				const choice = await vscode.window.showWarningMessage(
					`[Medium Risk] ${message}`,
					{ modal: true },
					"Run",
					"Cancel",
				);
				confirmed = choice === "Run";
			} else {
				// low risk
				const choice = await vscode.window.showInformationMessage(
					`[Low Risk] ${message}`,
					{ modal: true },
					"Run",
					"Cancel",
				);
				confirmed = choice === "Run";
			}

			if (!confirmed) {
				vscode.window.showInformationMessage("Command cancelled.");
				return;
			}

			// Execute
			outputChannel.show(true);
			outputChannel.appendLine(`\n[Gitty] Running: ${plan.command}`);
			outputChannel.appendLine(`[Gitty] Reason:  ${plan.explanation}`);

			try {
				const result = await runShellCommandCaptured(plan.command, {
					cwd,
					timeoutMs: 30000,
				});

				outputChannel.appendLine(result.stdout);
				if (result.stderr && result.stderr.trim().length > 0) {
					outputChannel.appendLine("[stderr]");
					outputChannel.appendLine(result.stderr);
				}

				if (result.timedOut) {
					vscode.window.showWarningMessage("Command timed out.");
				} else if (result.exitCode === 0) {
					vscode.window.showInformationMessage(
						"Command executed successfully.",
					);
					state.lastVerifiedCommand = plan.command; // track as last verified
					broadcastState();
					// Refresh context if successful
					vscode.commands.executeCommand("gitty.refreshRepoContext");
				} else {
					vscode.window.showErrorMessage(
						`Command failed with exit code ${result.exitCode}`,
					);
				}
			} catch (e: any) {
				outputChannel.appendLine(`[Gitty] Execution Error: ${e.message}`);
				vscode.window.showErrorMessage(
					`Failed to run command: ${e.message || "Unknown error"}`,
				);
			}
		},
	);

	// Command: Plan + Execute (One-Shot)
	const planAndExecuteCommand = vscode.commands.registerCommand(
		"gitty.planAndExecuteFromTranscript",
		async () => {
			await planFromTranscriptInternal(context);
			if (state.lastPlan) {
				await vscode.commands.executeCommand("gitty.executeLastPlan");
			}
		},
	);

	// Command: Set ElevenLabs API Key
	const setElevenLabsApiKeyCommand = vscode.commands.registerCommand(
		"gitty.setElevenLabsApiKey",
		async () => {
			const output = await vscode.window.showInputBox({
				prompt: "Enter ElevenLabs API key",
				password: true,
				ignoreFocusOut: true,
			});
			if (output) {
				await context.secrets.store("gitty.elevenlabs.apiKey", output);
				vscode.window.showInformationMessage("ElevenLabs API key saved.");
			}
		},
	);

	// Status Bar
	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
	);
	statusBarItem.command = "gitty.openCoach";
	// Initialize status bar state
	statusBarItem.text = "Gitty: Idle";
	statusBarItem.show();

	context.subscriptions.push(
		openCoachCommand,
		refreshRepoContextCommand,
		groqPingCommand,
		executeLastPlanCommand,
		planAndExecuteCommand,
		voiceStartCommand,
		voiceStopCommand,
		setElevenLabsApiKeyCommand,
		statusBarItem,
		outputChannel,
	);
}

function onVoiceChange(snap: VoiceSnapshot) {
	state.voice = snap;

	// Update Status Bar
	switch (snap.state) {
		case "off":
			statusBarItem.text = "Gitty: Idle";
			break;
		case "wake_listening":
			statusBarItem.text = "Gitty: Listening (Wake)";
			break;
		case "command_listening":
			statusBarItem.text = "Gitty: Listening (Command)";
			break;
		case "processing":
			statusBarItem.text = "Gitty: Processing";
			break;
		case "awaiting_confirmation":
			statusBarItem.text = "Gitty: Awaiting Confirm";
			break;
	}

	broadcastState();
}

function refreshConfig() {
	state.config = readConfig();
	broadcastState();
}

function getWorkspaceRoot(): string | null {
	if (
		vscode.workspace.workspaceFolders &&
		vscode.workspace.workspaceFolders.length > 0
	) {
		return vscode.workspace.workspaceFolders[0].uri.fsPath;
	}
	return null;
}

async function runCaptured(cmd: string, cwd: string) {
	return runShellCommandCaptured(cmd, { cwd }); // uses default timeout
}

async function toggleListening() {
	updateListeningState(!state.isListening);
	if (state.isListening) {
		await vscode.commands.executeCommand("gitty.refreshRepoContext");
	}
}

function updateListeningState(listening: boolean) {
	state.isListening = listening;

	// Update Status Bar
	statusBarItem.text = state.isListening ? "Gitty: Listening" : "Gitty: Idle";

	broadcastState();
}

function broadcastState() {
	if (currentPanel) {
		currentPanel.webview.postMessage({
			command: "updateState",
			isListening: state.isListening,
			lastVerifiedCommand: state.lastVerifiedCommand,
			repoContext: state.repoContext,
			voice: state.voice,
			config: state.config,
			wakeWordRunning: wakeWordService ? wakeWordService.isRunning : false,
		});
	}
}

function resolveKeywordPath(context: vscode.ExtensionContext): string | null {
	// e.g. resources/porcupine/hey-gitty.ppn
	// For user customization we might want to allow this to be a path in config,
	// but for MVP we look in extension resources
	const relative = "resources/porcupine/hey-gitty.ppn";
	const absPath = context.asAbsolutePath(relative);

	if (!fs.existsSync(absPath)) {
		vscode.window.showErrorMessage(
			`Wake word file not found at: ${absPath}. Please add it to enable wake word.`,
		);
		return null;
	}
	return absPath;
}

function setupWebview(context: vscode.ExtensionContext) {
	if (currentPanel) {
		currentPanel.reveal(vscode.ViewColumn.Beside);
		// Force refresh context so UI isn't empty on focus
		vscode.commands.executeCommand("gitty.refreshRepoContext");
		return;
	}

	currentPanel = vscode.window.createWebviewPanel(
		"gittyCoach",
		"Gitty Coach",
		vscode.ViewColumn.Beside,
		{
			enableScripts: true,
		},
	);

	// Set initial HTML content with current state
	currentPanel.webview.html = getWebviewContent(state);

	// Initial refresh to populate data
	vscode.commands.executeCommand("gitty.refreshRepoContext");

	// Handle messages from the webview
	currentPanel.webview.onDidReceiveMessage(
		async (message) => {
			switch (message.command) {
				case "refreshRepoContext":
					await vscode.commands.executeCommand("gitty.refreshRepoContext");
					break;
				case "voiceStart":
					vscode.commands.executeCommand("gitty.voiceStart");
					break;
				case "voiceStop":
					vscode.commands.executeCommand("gitty.voiceStop");
					break;
				case "openSettings":
					vscode.commands.executeCommand(
						"workbench.action.openSettings",
						"@ext:pauravhparam.gitty", // Assuming publisher.name, or just "gitty" query
					);
					// Fallback to simpler search query if extension id lookup is tricky
					vscode.commands.executeCommand(
						"workbench.action.openSettings",
						"gitty",
					);
					break;
			}
		},
		undefined,
		context.subscriptions,
	);

	// Cleanup when panel is closed
	currentPanel.onDidDispose(
		() => {
			currentPanel = undefined;
		},
		null,
		context.subscriptions,
	);
}

function getWebviewContent(initialState: GittyState) {
	const stateLabel = initialState.isListening ? "Listening" : "Idle";
	const lastCommandLabel = initialState.lastVerifiedCommand ?? "(none)";
	const wwStatus =
		wakeWordService && wakeWordService.isRunning ? "Running" : "Stopped";

	// Context formatting
	const ctx = initialState.repoContext;
	const gitRoot = ctx?.gitRoot ?? "(scanning...)";
	const branch = ctx?.branch ?? "(unknown)";
	const clean =
		ctx?.isClean === undefined ? "(unknown)" : ctx.isClean ? "Yes" : "No";
	const porcelain = ctx?.statusPorcelain
		? ctx.statusPorcelain.length > 2000
			? ctx.statusPorcelain.substring(0, 2000) + "..."
			: ctx.statusPorcelain
		: "";

	// Voice formatting
	const vState = initialState.voice.state;
	const vWake = initialState.voice.lastWakeAtIso ?? "-";
	const vText = initialState.voice.lastHeardText ?? "-";

	// Config formatting
	const {
		voiceEnabled,
		wakeWord,
		picovoiceAccessKey,
		porcupineKeyword,
		porcupineSensitivity,
		groqApiKey,
	} = initialState.config;
	const picoKeyStatus = picovoiceAccessKey ? "(set)" : "(not set)";
	const groqKeyStatus = groqApiKey ? "(set)" : "(not set)";

	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gitty Coach</title>
    <style>
        body { font-family: sans-serif; padding: 20px; }
        h1 { font-size: 1.5em; }
        h2 { font-size: 1.2em; margin-top: 20px; }
        p { margin-bottom: 20px; }
        pre { background: var(--vscode-textCodeBlock-background); padding: 10px; overflow: auto; max-height: 200px; }
        button { 
            padding: 8px 16px; 
            cursor: pointer; 
            background-color: var(--vscode-button-background); 
            color: var(--vscode-button-foreground); 
            border: none;
            margin-right: 10px;
            margin-bottom: 10px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .command-section {
            border-top: 1px solid var(--vscode-panel-border);
            padding-top: 10px;
        }
        .context-section {
            border-top: 1px solid var(--vscode-panel-border);
            padding-top: 10px;
        }
        .voice-section {
            border-top: 1px solid var(--vscode-panel-border);
            padding-top: 10px;
        }
        .config-section {
            border-top: 1px solid var(--vscode-panel-border);
            padding-top: 10px;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <h1>Gitty Coach (MVP)</h1>
    <p id="status-text">State: ${stateLabel}</p>
    <p id="last-command-text">Last verified command: ${lastCommandLabel}</p>
    
    <div class="voice-section">
        <h2>Voice Control</h2>
        <p><strong>Wake Engine:</strong> <span id="v-ww-status">${wwStatus}</span></p>
        <p><strong>Status:</strong> <span id="v-state">${vState}</span></p>
        <p><strong>Last Wake:</strong> <span id="v-wake">${vWake}</span></p>
        <p><strong>Last Heard:</strong> <span id="v-heard">${vText}</span></p>
        <button id="v-start-btn">Start Voice</button>
        <button id="v-stop-btn">Stop Voice</button>
    </div>

    <div class="context-section">
        <h2>Repo Context</h2>
        <button id="refresh-ctx-btn">Refresh Repo Context</button>
        <p><strong>Git Root:</strong> <span id="ctx-root">${gitRoot}</span></p>
        <p><strong>Branch:</strong> <span id="ctx-branch">${branch}</span></p>
        <p><strong>Clean:</strong> <span id="ctx-clean">${clean}</span></p>
        <pre id="ctx-porcelain">${porcelain}</pre>
    </div>

    <div class="config-section">
        <h2>Config</h2>
        <button id="config-btn">Open Gitty Settings</button>
        <p><strong>Voice Enabled:</strong> <span id="cfg-voice-enabled">${voiceEnabled}</span></p>
        <p><strong>Wake Word:</strong> <span id="cfg-wake-word">${wakeWord}</span></p>
        <p><strong>Porcupine Keyword:</strong> <span id="cfg-pico-keyword">${porcupineKeyword}</span></p>
        <p><strong>Sensitivity:</strong> <span id="cfg-pico-sens">${porcupineSensitivity}</span></p>
        <p><strong>Picovoice AccessKey:</strong> <span id="cfg-pico-key">${picoKeyStatus}</span></p>
        <p><strong>Groq API Key:</strong> <span id="cfg-groq-key">${groqKeyStatus}</span></p>
        <p><em>Keys are hidden. Set them in Settings.</em></p>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const statusText = document.getElementById('status-text');
        const lastCommandText = document.getElementById('last-command-text');
        
        // Context elements
        const ctxRoot = document.getElementById('ctx-root');
        const ctxBranch = document.getElementById('ctx-branch');
        const ctxClean = document.getElementById('ctx-clean');
        const ctxPorcelain = document.getElementById('ctx-porcelain');

        // Voice elements
        const vWwStatus = document.getElementById('v-ww-status');
        const vStateEl = document.getElementById('v-state');
        const vWakeEl = document.getElementById('v-wake');
        const vHeardEl = document.getElementById('v-heard');

        // Config elements
        const cfgVoiceEnabled = document.getElementById('cfg-voice-enabled');
        const cfgWakeWord = document.getElementById('cfg-wake-word');
        const cfgPicoKeyword = document.getElementById('cfg-pico-keyword');
        const cfgPicoSens = document.getElementById('cfg-pico-sens');
        const cfgPicoKey = document.getElementById('cfg-pico-key');
        const cfgGroqKey = document.getElementById('cfg-groq-key');

        // Buttons
        document.getElementById('refresh-ctx-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'refreshRepoContext' });
        });
        document.getElementById('v-start-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'voiceStart' });
        });
        document.getElementById('v-stop-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'voiceStop' });
        });
        document.getElementById('config-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'openSettings' });
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateState':
                    // existing updates
                    const stateStr = message.isListening ? 'Listening' : 'Idle';
                    const lastCmd = message.lastVerifiedCommand ? message.lastVerifiedCommand : '(none)';
                    statusText.textContent = 'State: ' + stateStr;
                    lastCommandText.textContent = 'Last command: ' + lastCmd;

                    // context updates
                    const ctx = message.repoContext;
                    if (ctx) {
                        ctxRoot.textContent = ctx.gitRoot || '(not a git repo)';
                        ctxBranch.textContent = ctx.branch || '(no branch)';
                        ctxClean.textContent = ctx.isClean ? 'Yes' : 'No';
                        
                        let p = ctx.statusPorcelain || '';
                        if (p.length > 2000) p = p.substring(0, 2000) + '...';
                        ctxPorcelain.textContent = p;
                    }

                    // voice updates
                    const voice = message.voice;
                    if (voice) {
                        vStateEl.textContent = voice.state;
                        vWakeEl.textContent = voice.lastWakeAtIso || '-';
                        vHeardEl.textContent = voice.lastHeardText || '-';
                    }
                    if (message.wakeWordRunning !== undefined) {
                        vWwStatus.textContent = message.wakeWordRunning ? 'Running' : 'Stopped';
                    }

                     // config updates
                    const config = message.config;
                    if (config) {
                        cfgVoiceEnabled.textContent = config.voiceEnabled;
                        cfgWakeWord.textContent = config.wakeWord;
                        cfgPicoKeyword.textContent = config.porcupineKeyword;
                        cfgPicoSens.textContent = config.porcupineSensitivity;
                        cfgPicoKey.textContent = config.picovoiceAccessKey ? '(set)' : '(not set)';
                        cfgGroqKey.textContent = config.groqApiKey ? '(set)' : '(not set)';
                    }
                    break;
            }
        });
    </script>
</body>
</html>`;
}

async function runStt(
	context: vscode.ExtensionContext,
	maxSeconds: number,
	silenceMs: number,
): Promise<string | undefined> {
	if (
		!vscode.workspace.workspaceFolders ||
		vscode.workspace.workspaceFolders.length === 0
	) {
		vscode.window.showErrorMessage("No workspace folder open.");
		return undefined;
	}
	const workspaceRootOrRepoRoot =
		vscode.workspace.workspaceFolders[0].uri.fsPath;

	const pythonPath = context.asAbsolutePath(".venv/bin/python");
	const scriptPath = context.asAbsolutePath("scripts/stt_capture.py");
	const modelDir = context.asAbsolutePath(
		"resources/vosk-model/vosk-model-en-us-0.22-lgraph",
	);

	if (!fs.existsSync(pythonPath)) {
		const msg = `Python interpreter not found at ${pythonPath}. Please create venv and install dependencies.`;
		vscode.window.showErrorMessage(msg);
		return undefined;
	}

	if (!fs.existsSync(modelDir)) {
		const msg = `Vosk model not found at ${modelDir}. Please download and unzip the model.`;
		vscode.window.showErrorMessage(msg);
		return undefined;
	}

	vscode.window.setStatusBarMessage(
		`Listening (max ${maxSeconds}s)...`,
		maxSeconds * 1000,
	);
	outputChannel.appendLine(
		`Running STT with python: ${pythonPath} ${scriptPath} --max_seconds ${maxSeconds} --silence_ms ${silenceMs}`,
	);

	return new Promise((resolve) => {
		const child = spawn(
			pythonPath,
			[
				scriptPath,
				"--model",
				modelDir,
				"--max_seconds",
				String(maxSeconds),
				"--silence_ms",
				String(silenceMs),
				"--vad_mode",
				"3",
				"--samplerate",
				"16000",
			],
			{
				cwd: workspaceRootOrRepoRoot,
			},
		);

		let stdoutData = "";
		let stderrData = "";

		child.stdout.on("data", (data) => {
			stdoutData += data.toString();
		});

		child.stderr.on("data", (data) => {
			stderrData += data.toString();
		});

		child.on("close", async (code) => {
			if (code !== 0) {
				outputChannel.appendLine(`STT process exited with code ${code}`);
				outputChannel.appendLine(`stderr: ${stderrData}`);
				outputChannel.appendLine(`stdout: ${stdoutData}`);
				vscode.window.showErrorMessage(`STT failed. Check Output -> Gitty.`);
				resolve(undefined);
				return;
			}

			// Parse last line
			const lines = stdoutData.trim().split("\n");
			let lastLine = "";
			for (let i = lines.length - 1; i >= 0; i--) {
				if (lines[i].trim().length > 0) {
					lastLine = lines[i];
					break;
				}
			}

			try {
				const result = JSON.parse(lastLine);
				if (result.error) {
					vscode.window.showErrorMessage(`STT Error: ${result.error}`);
					outputChannel.appendLine(`STT JSON Error: ${result.error}`);
					resolve(undefined);
				} else {
					const text = (result.text || "").trim();
					outputChannel.appendLine(`STT: ${text}`);
					if (text.length > 0) {
						vscode.window.showInformationMessage(
							`Heard: "${text.substring(0, 120)}"`,
						);
						voiceController.setHeardText(text);
						broadcastState();
						resolve(text);
					} else {
						vscode.window.showInformationMessage("Heard nothing.");
						resolve(undefined);
					}
				}
			} catch (e) {
				outputChannel.appendLine(`Failed to parse JSON: ${lastLine}`);
				vscode.window.showErrorMessage("STT JSON parse error.");
				resolve(undefined);
			}
		});
	});
}

async function planFromTranscriptInternal(context: vscode.ExtensionContext) {
	const cfg = readConfig();
	if (!cfg.groqEnabled) {
		vscode.window.showErrorMessage("Gitty: Groq is disabled in settings.");
		return;
	}
	if (!cfg.groqApiKey) {
		vscode.window.showErrorMessage("Gitty: Groq API Key is missing.");
		return;
	}

	const transcript = voiceController.getSnapshot().lastHeardText;
	if (!transcript || transcript.trim().length === 0) {
		vscode.window.showInformationMessage(
			"No transcript yet. Say a command first.",
		);
		return;
	}

	outputChannel.appendLine(`[Gitty] Planning for: "${transcript}"`);

	// Build Context Block
	const repoCtx = state.repoContext;
	let contextStr = "No valid git repository.";
	if (repoCtx && repoCtx.gitRoot) {
		const statusShort =
			(repoCtx.statusPorcelain || "").substring(0, 2000) +
			(repoCtx.statusPorcelain && repoCtx.statusPorcelain.length > 2000
				? "\n...[truncated]"
				: "");
		contextStr = `Git Root found.
Current Branch: ${repoCtx.branch || "unknown"}
Git Status (porcelain):
${statusShort}`;
	}

	try {
		const response = await groqChatComplete({
			apiKey: cfg.groqApiKey,
			model: cfg.groqModel || "llama-3.3-70b-versatile",
			messages: [
				{
					role: "system",
					content: `You are Gitty, a git command planner. Return ONLY valid JSON and nothing else.
Produce a JSON object with this shape:
{
  "command": "string",
  "risk": "low" | "medium" | "high",
  "explanation": "string (2 sentences)"
}`,
				},
				{
					role: "user",
					content: `User Intent: "${transcript}"

Repo Context:
${contextStr}

Constraints:
1. Produce ONE valid shell command (can use &&).
2. Prefer safe, common git commands.
3. If intent is ambiguous or dangerous, set risk="high" or choose a read-only command like "git status".
4. If checking status/diff, set risk="low".
5. If modifying history (rebase, reset --hard), set risk="high".
6. Explanation should be 1-2 sentences, narrative style. This is spoken back to the user.
6. Return ONLY the JSON object.`,
				},
			],
			temperature: 0.2,
			maxTokens: 280,
		});

		outputChannel.appendLine(`[Gitty] Raw Plan JSON: ${response}`);

		// Robust JSON parsing
		let jsonStart = response.indexOf("{");
		let jsonEnd = response.lastIndexOf("}");
		let jsonStr = response;
		if (jsonStart >= 0 && jsonEnd > jsonStart) {
			jsonStr = response.substring(jsonStart, jsonEnd + 1);
		}

		const planRaw = JSON.parse(jsonStr);

		// Validate / Default
		const plan: CommandPlan = {
			command:
				typeof planRaw.command === "string" ? planRaw.command : "echo error",
			risk: ["low", "medium", "high"].includes(planRaw.risk)
				? (planRaw.risk as Risk)
				: "medium",
			explanation:
				typeof planRaw.explanation === "string"
					? planRaw.explanation
					: "Run command.",
		};

		// Save Plan
		state.lastPlan = plan;
		outputChannel.appendLine(`[Gitty] Plan Accepted:`);
		outputChannel.appendLine(`  Cmd: ${plan.command}`);
		outputChannel.appendLine(`  Risk: ${plan.risk}`);
		outputChannel.appendLine(`  Exp: ${plan.explanation}`);
		outputChannel.show(true);

		const shortCmd =
			plan.command.length > 80
				? plan.command.substring(0, 80) + "..."
				: plan.command;
		vscode.window.showInformationMessage(`Planned: ${shortCmd}`);

		broadcastState();

		// TTS: Speak explanation
		try {
			const elevenCfg = state.config;
			const apiKey = await context.secrets.get("gitty.elevenlabs.apiKey");
			if (
				elevenCfg.elevenLabsEnabled &&
				apiKey &&
				elevenCfg.elevenLabsVoiceId
			) {
				const textToSpeak =
					plan.explanation || "Here is what I propose to run.";
				await speakText(context, textToSpeak, {
					voiceId: elevenCfg.elevenLabsVoiceId,
					modelId: elevenCfg.elevenLabsModelId,
					outputFormat: elevenCfg.elevenLabsOutputFormat,
				});
			}
		} catch (ttsErr: any) {
			outputChannel.appendLine(`[Gitty] TTS Error: ${ttsErr.message}`);
		}
	} catch (e: any) {
		outputChannel.appendLine(`[Gitty] Planning Error: ${e.message}`);
		vscode.window.showErrorMessage("Failed to plan command. See Output.");
	}
}

export function deactivate() {}

export async function getElevenLabsApiKey(
	context: vscode.ExtensionContext,
): Promise<string | undefined> {
	return context.secrets.get("gitty.elevenlabs.apiKey");
}
