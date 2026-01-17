import { Porcupine } from "@picovoice/porcupine-node";
import { PvRecorder } from "@picovoice/pvrecorder-node";

export type WakeWordCallback = () => void;

export class WakeWordService {
	private porcupine: Porcupine | undefined;
	private recorder: PvRecorder | undefined;
	private _isRunning = false;
	private lastTrigger = 0;

	constructor(
		private args: {
			accessKey: string;
			keywordPath: string; // path to .ppn
			sensitivity: number;
			onWakeWord: WakeWordCallback;
			log: (line: string) => void;
		},
	) {}

	get isRunning(): boolean {
		return this._isRunning;
	}

	async start(): Promise<void> {
		if (this._isRunning) {
			return;
		}

		try {
			this.args.log("[WakeWord] Initializing Porcupine...");
			this.porcupine = new Porcupine(
				this.args.accessKey,
				[this.args.keywordPath],
				[this.args.sensitivity],
			);

			this.args.log(
				`[WakeWord] Created Porcupine (frameLength=${this.porcupine.frameLength})`,
			);

			// deviceIndex -1 = default microphone
			this.recorder = new PvRecorder(this.porcupine.frameLength, -1);
			this.recorder.start();

			this._isRunning = true;
			this.args.log("[WakeWord] Recorder started. Listening...");

			this.loop();
		} catch (err: any) {
			this.args.log(`[WakeWord] Error starting: ${err.message}`);
			// Clean up if partially initialized
			await this.stop();
			throw err;
		}
	}

	private async loop() {
		while (this._isRunning && this.recorder && this.porcupine) {
			try {
				const frame = await this.recorder.read();
				const index = this.porcupine.process(frame);

				if (index === 0) {
					const now = Date.now();
					if (now - this.lastTrigger > 1200) {
						this.lastTrigger = now;
						this.args.log("[WakeWord] DETECTED!");
						this.args.onWakeWord();
					}
				}
			} catch (err: any) {
				if (this._isRunning) {
					this.args.log(`[WakeWord] Loop Error: ${err.message}`);
					await this.stop();
				}
			}
		}
	}

	async stop(): Promise<void> {
		this._isRunning = false;

		if (this.recorder) {
			try {
				this.recorder.stop();
				this.recorder.release();
			} catch (err: any) {
				this.args.log(`[WakeWord] Error stopping recorder: ${err.message}`);
			}
			this.recorder = undefined;
		}

		if (this.porcupine) {
			try {
				this.porcupine.release();
			} catch (err: any) {
				this.args.log(`[WakeWord] Error releasing Porcupine: ${err.message}`);
			}
			this.porcupine = undefined;
		}

		this.args.log("[WakeWord] Stopped.");
	}
}
