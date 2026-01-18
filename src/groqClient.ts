import * as https from "https";
import { URL } from "url";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export async function groqChatComplete(args: {
	apiKey: string;
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	maxTokens?: number;
}): Promise<string> {
	return new Promise((resolve, reject) => {
		const requestUrl = new URL(
			"https://api.groq.com/openai/v1/chat/completions",
		);

		const options: https.RequestOptions = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${args.apiKey}`,
			},
		};

		const body = JSON.stringify({
			model: args.model,
			messages: args.messages,
			temperature: args.temperature ?? 0.7, // Default temp
			max_tokens: args.maxTokens, // Optional
		});

		const req = https.request(requestUrl, options, (res) => {
			let data = "";

			res.on("data", (chunk) => {
				data += chunk;
			});

			res.on("end", () => {
				if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
					reject(
						new Error(
							`Groq API Error: ${res.statusCode} ${res.statusMessage} - ${data}`,
						),
					);
					return;
				}

				try {
					const json = JSON.parse(data);
					if (
						json.choices &&
						json.choices.length > 0 &&
						json.choices[0].message
					) {
						resolve(json.choices[0].message.content);
					} else {
						// Fallback or error if structure unexpected
						reject(new Error(`Unexpected Groq response structure: ${data}`));
					}
				} catch (e) {
					reject(new Error(`Failed to parse Groq response: ${data}`));
				}
			});
		});

		req.on("error", (e) => {
			reject(e);
		});

		req.write(body);
		req.end();
	});
}
