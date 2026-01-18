import * as https from "https";
import { IncomingMessage } from "http";

export async function elevenLabsTtsMp3(args: {
	apiKey: string;
	voiceId: string;
	text: string;
	modelId?: string;
	outputFormat?: string;
}): Promise<Buffer> {
	const {
		apiKey,
		voiceId,
		text,
		modelId = "eleven_turbo_v2_5",
		outputFormat = "mp3_22050_32",
	} = args;

	const postData = JSON.stringify({
		text,
		model_id: modelId,
	});

	const options = {
		hostname: "api.elevenlabs.io",
		port: 443,
		path: `/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`,
		method: "POST",
		headers: {
			"xi-api-key": apiKey,
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(postData),
		},
	};

	return new Promise((resolve, reject) => {
		const req = https.request(options, (res: IncomingMessage) => {
			if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
				let errorBody = "";
				res.on("data", (chunk) => (errorBody += chunk));
				res.on("end", () => {
					reject(
						new Error(`ElevenLabs API Error: ${res.statusCode} - ${errorBody}`),
					);
				});
				return;
			}

			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve(Buffer.concat(chunks)));
		});

		req.on("error", (e) => reject(e));
		req.write(postData);
		req.end();
	});
}
