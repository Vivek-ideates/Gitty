export type VoiceState =
	| "off"
	| "wake_listening"
	| "command_listening"
	| "processing"
	| "awaiting_confirmation";

export interface VoiceSnapshot {
	state: VoiceState;
	lastWakeAtIso?: string;
	lastHeardText?: string;
}

export class VoiceController {
	private state: VoiceState = "off";
	private lastWakeAtIso?: string;
	private lastHeardText?: string;
	private onChange: (snap: VoiceSnapshot) => void;

	constructor(onChange: (snap: VoiceSnapshot) => void) {
		this.onChange = onChange;
	}

	public getSnapshot(): VoiceSnapshot {
		return {
			state: this.state,
			lastWakeAtIso: this.lastWakeAtIso,
			lastHeardText: this.lastHeardText,
		};
	}

	public startWakeListening(): void {
		this.updateState("wake_listening");
	}

	public stop(): void {
		this.updateState("off");
	}

	public simulateWakeWord(): void {
		this.lastWakeAtIso = new Date().toISOString();
		this.updateState("command_listening");
	}

	public setHeardText(text: string): void {
		this.lastHeardText = text;
		this.updateState("processing");
	}

	public setAwaitingConfirmation(): void {
		this.updateState("awaiting_confirmation");
	}

	public setBackToWakeListening(): void {
		this.updateState("wake_listening");
	}

	private updateState(newState: VoiceState): void {
		this.state = newState;
		this.notify();
	}

	private notify(): void {
		this.onChange(this.getSnapshot());
	}
}
