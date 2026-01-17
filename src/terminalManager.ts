import * as vscode from "vscode";

export class TerminalManager {
	private terminal: vscode.Terminal | undefined;

	constructor() {
		// Listen for terminal close events to clear our reference if the user closes it manually
		vscode.window.onDidCloseTerminal((term) => {
			if (term === this.terminal) {
				this.terminal = undefined;
			}
		});
	}

	public getOrCreate(): vscode.Terminal {
		if (!this.terminal || this.terminal.exitStatus !== undefined) {
			this.terminal = vscode.window.createTerminal("Gitty");
		}
		return this.terminal;
	}

	public show(): void {
		const terminal = this.getOrCreate();
		terminal.show(true);
	}

	public sendText(text: string, addNewLine: boolean = true): void {
		const terminal = this.getOrCreate();
		terminal.sendText(text, addNewLine);
	}
}
