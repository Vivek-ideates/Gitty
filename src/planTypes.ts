export type Risk = "low" | "medium" | "high";

export interface CommandPlan {
	command: string; // shell command to execute
	risk: Risk; // low/medium/high
	explanation: string; // brief human explanation
}
