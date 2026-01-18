export interface LearningTurn {
	q: string;
	a: string;
}

export interface LearningContext {
	lastTranscript?: string;
	lastPlan?: {
		command: string;
		risk: "low" | "medium" | "high";
		explanation: string;
	};
	repoSummary?: {
		branch?: string;
		gitRoot?: string;
		statusPorcelain?: string;
	};
	lastCommandOutput?: {
		ok: boolean;
		exitCode?: number;
		stdout?: string;
		stderr?: string;
	};
	recentQA: LearningTurn[];
	lastLearningText?: string;
}

export function createLearningContext(): LearningContext {
	return {
		recentQA: [],
	};
}

export function addQATurn(ctx: LearningContext, turn: LearningTurn) {
	ctx.recentQA.push(turn);
	if (ctx.recentQA.length > 3) {
		ctx.recentQA.shift();
	}
}
