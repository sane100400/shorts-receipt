import { GoogleGenAI } from '@google/genai';

const vertexMode = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

let client;
if (vertexMode) {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';

  if (!project) {
    throw new Error('GOOGLE_CLOUD_PROJECT is required when Vertex AI mode is enabled.');
  }

  client = new GoogleGenAI({ vertexai: true, project, location });
} else {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing. Copy .env.example to .env and add the event key.');
  }

  client = new GoogleGenAI({ apiKey });
}

const response = await client.models.generateContent({
  model,
  contents: 'Reply with exactly: STUDYJAM_READY',
});

const output = response.text?.trim();
if (!output) {
  throw new Error('Gemini returned an empty response.');
}

console.log(`Gemini ${model}: ${output}`);
console.log('SDK authentication and generation are working.');
