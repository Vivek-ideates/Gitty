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
import { speakText, stopSpeaking } from "./ttsService";

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
							// Stop any ongoing TTS
							stopSpeaking();

							if (sttInProgress) {
								return;
							}
							sttInProgress = true;

							// PAUSE Wake Word to release microphone
							if (wakeWordService) {
								await wakeWordService.pause();
							}

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
								// RESUME Wake Word
								if (wakeWordService) {
									await wakeWordService.resume();
								}
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
			const confirmed = true;

			// NOTE: Verification logic moved to UI/Webview.
			// High/Medium risk commands initiated via webview "Run" button are considered confirmed.

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
			// Auto-execution logic:
			// If Last Plan exists:
			//   - If Low Risk: Auto-execute
			//   - If Medium/High Risk: Stop here. Rely on Webview UI to let user click "Run".
			//     (Webview sends "executePlan" which calls gitty.executeLastPlan)
			if (state.lastPlan && state.lastPlan.risk === "low") {
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
			lastPlan: state.lastPlan,
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
				case "executePlan":
					vscode.commands.executeCommand("gitty.executeLastPlan");
					break;
				case "dismissPlan":
					// No-op in extension for now, webview handles UI
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

function getWebviewContent(_initialState: GittyState) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gitty Coach</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
            background-color: transparent;
            color: #E0E0E0;
            margin: 0;
            padding: 20px;
            display: flex;
            justify-content: center;
        }

        .card {
            position: relative;
            background: rgba(25, 25, 30, 0.85);
            border-radius: 16px;
            box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(5px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            width: 100%;
            max-width: 400px;
            padding: 24px;
            text-align: center;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }

        .settings-btn {
            position: absolute;
            top: 20px;
            right: 20px;
            background: none;
            border: none;
            padding: 5px;
            cursor: pointer;
            color: #666;
            transition: color 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .settings-btn:hover {
            color: #ccc;
        }

        h1 {
            font-size: 18px;
            font-weight: 500;
            margin: 0;
            color: #FFFFFF;
        }

        .status-line {
            font-size: 14px;
            color: #888888;
            margin-top: -15px;
            height: 20px;
        }

        .icon-area {
            height: 120px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 10px 0;
        }

        .icon {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: #333;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
            color: #7C7CFF;
            transition: all 0.3s ease;
        }

        .icon.listening {
            background: rgba(124, 124, 255, 0.1);
            border: 2px solid #7C7CFF;
            box-shadow: 0 0 15px rgba(124, 124, 255, 0.3);
        }
        
        .icon.processing {
            border: 2px solid transparent;
            border-top: 2px solid #7C7CFF;
            background: transparent;
            animation: spin 1s linear infinite;
        }

        .icon.idle {
            background: #2A2A2A;
            color: #555;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .plan-card {
            background: rgba(40, 40, 45, 0.9);
            border-radius: 8px;
            padding: 16px;
            text-align: left;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .plan-cmd {
            font-family: 'Courier New', Courier, monospace;
            background: #111;
            padding: 8px;
            border-radius: 4px;
            word-break: break-all;
            margin-bottom: 8px;
            color: #7C7CFF;
            font-size: 13px;
        }

        .risk-badge {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 10px;
            text-transform: uppercase;
            font-weight: bold;
            margin-bottom: 8px;
        }
        .risk-low { background: #2E5C38; color: #8FBC9B; }
        .risk-medium { background: #665228; color: #E0C074; }
        .risk-high { background: #662E2E; color: #E08585; }

        .plan-exp {
            font-size: 13px;
            color: #BBBBBB;
            margin-bottom: 12px;
            line-height: 1.4;
        }

        .controls {
            display: flex;
            gap: 10px;
            justify-content: center;
            margin-top: 10px;
        }

        button.btn {
            background: #333;
            color: #eee;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            font-size: 14px;
            cursor: pointer;
            transition: background 0.2s;
            flex: 1;
        }
        
        button.btn:hover {
            background: #444;
        }

        button.btn-primary {
            background: #7C7CFF;
            color: #fff;
        }
        
        button.btn-primary:hover {
            background: #6B6BFF;
        }

        button.btn-danger {
            background: #FF5C5C;
            color: #fff;
        }
        
        button.btn-danger:hover {
            background: #FF4444;
        }

    </style>
</head>
<body>
    <div class="card">
        <button id="btn-settings" class="settings-btn" title="Open Settings">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
        </button>
        <h1>Say "Hey Gitty" to start</h1>
        <div class="status-line" id="status-text">Idle</div>

        <div class="icon-area">
            <div id="main-icon" class="icon idle">
                <!-- Icon content injected by JS -->
            </div>
        </div>

        <!-- Plan Section -->
        <div id="plan-section" style="display: none;">
            <div class="plan-card">
                <div id="plan-risk-badge" class="risk-badge risk-low">LOW RISK</div>
                <div id="plan-command" class="plan-cmd">git status</div>
                <div id="plan-explanation" class="plan-exp">Checking repository status.</div>
                
                <div class="controls" id="plan-controls">
                    <!-- Injected buttons -->
                </div>
            </div>
        </div>

        <!-- Manual Controls -->
        <div class="controls">
            <button id="btn-start" class="btn">Start</button>
            <button id="btn-stop" class="btn">Stop</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        // Element Refs
        const statusText = document.getElementById('status-text');
        const mainIcon = document.getElementById('main-icon');
        const planSection = document.getElementById('plan-section');
        const planRisk = document.getElementById('plan-risk-badge');
        const planCmd = document.getElementById('plan-command');
        const planExp = document.getElementById('plan-explanation');
        const planControls = document.getElementById('plan-controls');
        
        // State
        let localState = {
            voiceState: 'off',
            plan: null,
            planDismissed: false
        };

        // Icons
        const icons = {
            mic: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>',
            off: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>',
        };

        // Initial Render
        render();

        // Listeners
        document.getElementById('btn-start').addEventListener('click', () => {
            vscode.postMessage({ command: 'voiceStart' });
        });
        document.getElementById('btn-stop').addEventListener('click', () => {
             vscode.postMessage({ command: 'voiceStop' });
        });
        document.getElementById('btn-settings').addEventListener('click', () => {
             vscode.postMessage({ command: 'openSettings' });
        });

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'updateState') {
                if (msg.voice) {
                    localState.voiceState = msg.voice.state;
                }
                
                if (msg.lastPlan) {
                    const isNew = !localState.plan || (localState.plan.command !== msg.lastPlan.command);
                    localState.plan = msg.lastPlan;
                    if (isNew) {
                         localState.planDismissed = false;
                    }
                }
                
                render();
            }
        });

        function render() {
            // 1. Status Text & Icon Class
            let sText = "Idle";
            let iconClass = "idle";
            let iconHtml = icons.off;

            switch (localState.voiceState) {
                case 'wake_listening':
                    sText = "Listening for the wake phrase";
                    iconClass = "listening";
                    iconHtml = icons.mic;
                    break;
                case 'command_listening':
                    sText = "Listening to the command";
                    iconClass = "listening";
                    iconHtml = icons.mic;
                    break;
                case 'processing':
                    sText = "Processing";
                    iconClass = "processing";
                    iconHtml = ""; 
                    break;
                case 'awaiting_confirmation':
                    sText = "Awaiting confirmation";
                    iconClass = "idle"; 
                    iconHtml = icons.mic; 
                    break;
                case 'off':
                default:
                    sText = "Idle";
                    iconClass = "idle";
                    iconHtml = icons.off;
                    break;
            }

            statusText.textContent = sText;
            mainIcon.className = "icon " + iconClass;
            mainIcon.innerHTML = iconHtml;

            // 2. Plan Section
            if (localState.plan && !localState.planDismissed) {
                planSection.style.display = 'block';
                const p = localState.plan;
                
                planCmd.textContent = p.command;
                planExp.textContent = p.explanation;
                
                // Risk Badge
                planRisk.className = 'risk-badge risk-' + p.risk;
                planRisk.textContent = p.risk.toUpperCase() + ' RISK';

                // Controls
                planControls.innerHTML = ''; // clear

                if (p.risk === 'low') {
                    // Start Button Only
                    const btnRun = document.createElement('button');
                    btnRun.className = 'btn btn-primary';
                    btnRun.textContent = 'Run Command';
                    btnRun.onclick = () => {
                        vscode.postMessage({ command: 'executePlan' });
                    };
                    planControls.appendChild(btnRun);
                } else {
                    // Run + Cancel
                    const btnRun = document.createElement('button');
                    btnRun.className = 'btn btn-primary';
                    btnRun.textContent = 'Run';
                    btnRun.onclick = () => {
                        vscode.postMessage({ command: 'executePlan' });
                    };

                    const btnCancel = document.createElement('button');
                    btnCancel.className = 'btn'; 
                    btnCancel.textContent = 'Cancel';
                    btnCancel.onclick = () => {
                        localState.planDismissed = true;
                        vscode.postMessage({ command: 'dismissPlan' });
                        render();
                    };

                    planControls.appendChild(btnCancel);
                    planControls.appendChild(btnRun);
                }

            } else {
                planSection.style.display = 'none';
            }
        }
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

		// TTS: Speak explanation (concurrent)
		const elevenCfg = state.config;
		if (elevenCfg.elevenLabsEnabled && elevenCfg.elevenLabsVoiceId) {
			context.secrets.get("gitty.elevenlabs.apiKey").then((apiKey) => {
				if (apiKey) {
					const textToSpeak =
						plan.explanation || "Here is what I propose to run.";
					// Fire and forget - do not await
					void speakText(context, textToSpeak, {
						voiceId: elevenCfg.elevenLabsVoiceId,
						modelId: elevenCfg.elevenLabsModelId,
						outputFormat: elevenCfg.elevenLabsOutputFormat,
					}).catch((ttsErr) => {
						outputChannel.appendLine(`[Gitty] TTS Error: ${ttsErr.message}`);
					});
				}
			});
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
