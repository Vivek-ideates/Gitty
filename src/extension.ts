import * as vscode from "vscode";
import { TerminalManager } from "./terminalManager";
import { verifyAndRunCaptured } from "./commandExecutor";

interface GittyState {
	isListening: boolean;
	lastVerifiedCommand: string | undefined;
}

const state: GittyState = {
	isListening: false,
	lastVerifiedCommand: undefined,
};

let statusBarItem: vscode.StatusBarItem;
let currentPanel: vscode.WebviewPanel | undefined = undefined;
let terminalManager: TerminalManager;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
	terminalManager = new TerminalManager();
	outputChannel = vscode.window.createOutputChannel("Gitty");

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
		statusBarItem,
		outputChannel,
	);
}

function toggleListening() {
	updateListeningState(!state.isListening);
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
		});
	}
}

function setupWebview(context: vscode.ExtensionContext) {
	if (currentPanel) {
		currentPanel.reveal(vscode.ViewColumn.Beside);
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

    <script>
        const vscode = acquireVsCodeApi();
        const statusText = document.getElementById('status-text');
        const lastCommandText = document.getElementById('last-command-text');
        
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

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateState':
                    const stateStr = message.isListening ? 'Listening' : 'Idle';
                    const lastCmd = message.lastVerifiedCommand ? message.lastVerifiedCommand : '(none)';
                    
                    statusText.textContent = 'State: ' + stateStr;
                    lastCommandText.textContent = 'Last command: ' + lastCmd;
                    break;
            }
        });
    </script>
</body>
</html>`;
}

export function deactivate() {}
