import * as vscode from "vscode";
import { TerminalManager } from "./terminalManager";

let isListening = false;
let statusBarItem: vscode.StatusBarItem;
let currentPanel: vscode.WebviewPanel | undefined = undefined;
let terminalManager: TerminalManager;

export function activate(context: vscode.ExtensionContext) {
	terminalManager = new TerminalManager();

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
		statusBarItem,
	);
}

function toggleListening() {
	updateListeningState(!isListening);
}

function updateListeningState(listening: boolean) {
	isListening = listening;

	// Update Status Bar
	statusBarItem.text = isListening ? "Gitty: Listening" : "Gitty: Idle";

	// Update Webview if open
	if (currentPanel) {
		currentPanel.webview.postMessage({ command: "updateState", isListening });
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
	currentPanel.webview.html = getWebviewContent(isListening);

	// Handle messages from the webview
	currentPanel.webview.onDidReceiveMessage(
		(message) => {
			switch (message.command) {
				case "toggle":
					toggleListening();
					break;
				case "showTerminal":
					vscode.commands.executeCommand("gitty.spawnTerminal");
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

function getWebviewContent(initialState: boolean) {
	const stateLabel = initialState ? "Listening" : "Idle";
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gitty Coach</title>
    <style>
        body { font-family: sans-serif; padding: 20px; }
        h1 { font-size: 1.5em; }
        p { margin-bottom: 20px; }
        button { 
            padding: 8px 16px; 
            cursor: pointer; 
            background-color: var(--vscode-button-background); 
            color: var(--vscode-button-foreground); 
            border: none; 
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
    </style>
</head>
<body>
    <h1>Gitty Coach (MVP)</h1>
    <p id="status-text">State: ${stateLabel}</p>
    <button id="toggle-btn">Toggle Listening</button>
    <button id="terminal-btn">Show Terminal</button>

    <script>
        const vscode = acquireVsCodeApi();
        const statusText = document.getElementById('status-text');
        const btn = document.getElementById('toggle-btn');
        const termBtn = document.getElementById('terminal-btn');

        // Handle button click
        btn.addEventListener('click', () => {
            vscode.postMessage({ command: 'toggle' });
        });

        termBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'showTerminal' });
        });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateState':
                    const stateStr = message.isListening ? 'Listening' : 'Idle';
                    statusText.textContent = 'State: ' + stateStr;
                    break;
            }
        });
    </script>
</body>
</html>`;
}

export function deactivate() {}
