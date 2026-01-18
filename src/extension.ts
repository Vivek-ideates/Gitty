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

interface GittyState {
	isListening: boolean;
	lastVerifiedCommand: string | undefined;
	repoContext: RepoContext | undefined;
	voice: VoiceSnapshot;
	config: GittyConfig;
}

const state: GittyState = {
	isListening: false,
	lastVerifiedCommand: undefined,
	repoContext: undefined,
	voice: { state: "off" },
	config: readConfig(),
};

let statusBarItem: vscode.StatusBarItem;
let currentPanel: vscode.WebviewPanel | undefined = undefined;
let terminalManager: TerminalManager;
let outputChannel: vscode.OutputChannel;
let voiceController: VoiceController;
let wakeWordService: WakeWordService | undefined;

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

	// Command: Toggle Listening
	const toggleCommand = vscode.commands.registerCommand(
		"gitty.toggleListening",
		() => {
			toggleListening();
		},
	);

	// Command: Open Coach
	const openCoachCommand = vscode.commands.registerCommand(
		"gitty.openCoach",
		() => {
			setupWebview(context);
		},
	);

	// Command: Spawn Terminal
	const spawnTerminalCommand = vscode.commands.registerCommand(
		"gitty.spawnTerminal",
		() => {
			terminalManager.show();
		},
	);

	// Command: Send Text to Terminal
	const sendTextCommand = vscode.commands.registerCommand(
		"gitty.sendTextToTerminal",
		async () => {
			const text = await vscode.window.showInputBox({
				prompt: "Text to send to Gitty terminal",
			});
			if (text) {
				terminalManager.show();
				terminalManager.sendText(text);
			}
		},
	);
	// Command: Run Command (Verified)
	const runCommandVerified = vscode.commands.registerCommand(
		"gitty.runCommandVerified",
		async () => {
			if (
				!vscode.workspace.workspaceFolders ||
				vscode.workspace.workspaceFolders.length === 0
			) {
				vscode.window.showErrorMessage("No workspace folder open.");
				return;
			}
			const cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;

			const commandText = await vscode.window.showInputBox({
				prompt: "Command to run (verified) [temporary text input]",
				placeHolder: "Example: git status",
				ignoreFocusOut: true,
			});

			if (!commandText) {
				return;
			}

			const result = await verifyAndRunCaptured(
				commandText,
				{ cwd },
				{
					confirmLow: async (msg) => {
						const selected = await vscode.window.showInformationMessage(
							msg,
							{ modal: true },
							"Run",
							"Cancel",
						);
						return selected === "Run";
					},
					confirmHigh: async (msg) => {
						const selected = await vscode.window.showWarningMessage(
							msg,
							{ modal: true },
							"Continue",
							"Cancel",
						);
						return selected === "Continue";
					},
				},
				outputChannel,
			);

			if (result !== null) {
				state.lastVerifiedCommand = commandText;
				broadcastState();
			}
		},
	);

	// Command: Run Last Command Again
	const runLastCommandAgain = vscode.commands.registerCommand(
		"gitty.runLastCommandAgain",
		async () => {
			if (!state.lastVerifiedCommand) {
				vscode.window.showInformationMessage(
					"No previous verified command yet.",
				);
				return;
			}

			if (
				!vscode.workspace.workspaceFolders ||
				vscode.workspace.workspaceFolders.length === 0
			) {
				vscode.window.showErrorMessage("No workspace folder open.");
				return;
			}
			const cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;

			await verifyAndRunCaptured(
				state.lastVerifiedCommand,
				{ cwd },
				{
					confirmLow: async (msg) => {
						const selected = await vscode.window.showInformationMessage(
							msg,
							{ modal: true },
							"Run",
							"Cancel",
						);
						return selected === "Run";
					},
					confirmHigh: async (msg) => {
						const selected = await vscode.window.showWarningMessage(
							msg,
							{ modal: true },
							"Continue",
							"Cancel",
						);
						return selected === "Continue";
					},
				},
				outputChannel,
			);
			broadcastState();
		},
	);

	// Command: Debug Run (git status)
	const debugRunCommand = vscode.commands.registerCommand(
		"gitty.debugRunGitStatus",
		async () => {
			if (
				!vscode.workspace.workspaceFolders ||
				vscode.workspace.workspaceFolders.length === 0
			) {
				vscode.window.showErrorMessage("No workspace folder open.");
				return;
			}
			const cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;

			await verifyAndRunCaptured(
				"git status",
				{ cwd },
				{
					confirmLow: async (msg) => {
						const selected = await vscode.window.showInformationMessage(
							msg,
							{ modal: true },
							"Run",
							"Cancel",
						);
						return selected === "Run";
					},
					confirmHigh: async (msg) => {
						const selected = await vscode.window.showWarningMessage(
							msg,
							{ modal: true },
							"Continue",
							"Cancel",
						);
						return selected === "Continue";
					},
				},
				outputChannel,
			);
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

	// Command: Capture Speech Once (Python Vosk)
	const sttCaptureOncePy = vscode.commands.registerCommand(
		"gitty.sttCaptureOncePy",
		async () => {
			if (
				!vscode.workspace.workspaceFolders ||
				vscode.workspace.workspaceFolders.length === 0
			) {
				vscode.window.showErrorMessage("No workspace folder open.");
				return;
			}
			const workspaceRootOrRepoRoot =
				vscode.workspace.workspaceFolders[0].uri.fsPath;

			const pythonPath = context.asAbsolutePath(".venv/bin/python");
			const scriptPath = context.asAbsolutePath("scripts/stt_capture.py");
			const modelDir = context.asAbsolutePath(
				"resources/vosk-model/vosk-model-small-en-us-0.15",
			);

			if (!fs.existsSync(pythonPath)) {
				const msg = `Python interpreter not found at ${pythonPath}. Please create venv and install dependencies.`;
				vscode.window.showErrorMessage(msg);
				return;
			}

			if (!fs.existsSync(modelDir)) {
				const msg = `Vosk model not found at ${modelDir}. Please download and unzip the model.`;
				vscode.window.showErrorMessage(msg);
				return;
			}

			vscode.window.showInformationMessage("Listening for 5 seconds...");
			outputChannel.appendLine(
				`Running STT with python: ${pythonPath} ${scriptPath}`,
			);

			const child = spawn(
				pythonPath,
				[
					scriptPath,
					"--model",
					modelDir,
					"--seconds",
					"5",
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

			child.on("close", (code) => {
				if (code !== 0) {
					outputChannel.appendLine(`STT process exited with code ${code}`);
					outputChannel.appendLine(`stderr: ${stderrData}`);
					outputChannel.appendLine(`stdout: ${stdoutData}`);
					vscode.window.showErrorMessage(`STT failed. Check Output -> Gitty.`);
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
					} else {
						const text = result.text || "";
						outputChannel.appendLine(`STT: ${text}`);
						if (text && text.trim().length > 0) {
							vscode.window.showInformationMessage(
								`Heard: "${text.substring(0, 120)}"`,
							);
							voiceController.setHeardText(text);
							broadcastState();
						} else {
							vscode.window.showInformationMessage("Heard nothing.");
						}
					}
				} catch (e) {
					outputChannel.appendLine(`Failed to parse JSON: ${lastLine}`);
					vscode.window.showErrorMessage("STT JSON parse error.");
				}
			});
		},
	);

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
						onWakeWord: () => {
							// 1. Focus Coach
							vscode.commands.executeCommand("gitty.openCoach");
							// 2. Simulate Wake Word (transition state)
							voiceController.simulateWakeWord();
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

	// Command: Simulate Wake Word
	const voiceSimulateCommand = vscode.commands.registerCommand(
		"gitty.simulateWakeWord",
		() => {
			voiceController.simulateWakeWord();
			vscode.commands.executeCommand("gitty.openCoach");
		},
	);

	// Status Bar
	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
	);
	statusBarItem.command = "gitty.toggleListening";
	// Initialize status bar state
	statusBarItem.text = "Gitty: Idle";
	statusBarItem.show();

	context.subscriptions.push(
		toggleCommand,
		openCoachCommand,
		spawnTerminalCommand,
		sendTextCommand,
		runCommandVerified,
		runLastCommandAgain,
		debugRunCommand,
		refreshRepoContextCommand,
		sttCaptureOncePy,
		voiceStartCommand,
		voiceStopCommand,
		voiceSimulateCommand,
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
				case "toggle":
					toggleListening();
					break;
				case "showTerminal":
					vscode.commands.executeCommand("gitty.spawnTerminal");
					break;
				case "runVerifiedCommand":
					await vscode.commands.executeCommand("gitty.runCommandVerified");
					broadcastState();
					break;
				case "runLastCommandAgain":
					await vscode.commands.executeCommand("gitty.runLastCommandAgain");
					broadcastState();
					break;
				case "refreshRepoContext":
					await vscode.commands.executeCommand("gitty.refreshRepoContext");
					break;
				case "voiceStart":
					vscode.commands.executeCommand("gitty.voiceStart");
					break;
				case "voiceStop":
					vscode.commands.executeCommand("gitty.voiceStop");
					break;
				case "simulateWakeWord":
					vscode.commands.executeCommand("gitty.simulateWakeWord");
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
    <button id="toggle-btn">Toggle Listening</button>
    
    <div class="command-section">
        <h2>Commands</h2>
        <button id="terminal-btn">Show Terminal</button>
        <button id="run-verified-btn">Run Verified Command...</button>
        <button id="run-last-btn">Run Last Command Again</button>
        <p id="last-command-text">Last command: ${lastCommandLabel}</p>
    </div>

    <div class="voice-section">
        <h2>Voice Control</h2>
        <p><strong>Wake Engine:</strong> <span id="v-ww-status">${wwStatus}</span></p>
        <p><strong>Status:</strong> <span id="v-state">${vState}</span></p>
        <p><strong>Last Wake:</strong> <span id="v-wake">${vWake}</span></p>
        <p><strong>Last Heard:</strong> <span id="v-heard">${vText}</span></p>
        <button id="v-start-btn">Start Voice</button>
        <button id="v-stop-btn">Stop Voice</button>
        <button id="v-sim-btn">Simulate Wake Word</button>
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
        document.getElementById('toggle-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'toggle' });
        });
        document.getElementById('terminal-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'showTerminal' });
        });
        document.getElementById('run-verified-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'runVerifiedCommand' });
        });
        document.getElementById('run-last-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'runLastCommandAgain' });
        });
        document.getElementById('refresh-ctx-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'refreshRepoContext' });
        });
        document.getElementById('v-start-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'voiceStart' });
        });
        document.getElementById('v-stop-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'voiceStop' });
        });
        document.getElementById('v-sim-btn').addEventListener('click', () => {
             vscode.postMessage({ command: 'simulateWakeWord' });
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

export function deactivate() {}
