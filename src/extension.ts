import * as vscode from "vscode";
import { TerminalManager } from "./terminalManager";
import {
	verifyAndRunCaptured,
	runShellCommandCaptured,
} from "./commandExecutor";
import { getRepoContext, RepoContext } from "./repoContext";

interface GittyState {
	isListening: boolean;
	lastVerifiedCommand: string | undefined;
	repoContext: RepoContext | undefined;
}

const state: GittyState = {
	isListening: false,
	lastVerifiedCommand: undefined,
	repoContext: undefined,
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
		statusBarItem,
		outputChannel,
	);
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
			repoContext: state.repoContext,
		});
	}
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

    <div class="context-section">
        <h2>Repo Context</h2>
        <button id="refresh-ctx-btn">Refresh Repo Context</button>
        <p><strong>Git Root:</strong> <span id="ctx-root">${gitRoot}</span></p>
        <p><strong>Branch:</strong> <span id="ctx-branch">${branch}</span></p>
        <p><strong>Clean:</strong> <span id="ctx-clean">${clean}</span></p>
        <pre id="ctx-porcelain">${porcelain}</pre>
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
                    break;
            }
        });
    </script>
</body>
</html>`;
}

export function deactivate() {}
