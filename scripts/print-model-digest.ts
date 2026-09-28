const baseUrl = process.env.LOCAL_AI_BASE_URL ?? 'http://127.0.0.1:11434';
const model = process.env.LOCAL_AI_MODEL ?? 'qwen3-vl:4b-instruct';

const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`ollama_tags_failed:${response.status}`);

const body = await response.json() as {
  models?: Array<{ name?: string; model?: string; digest?: string }>;
};
const row = (body.models ?? []).find((candidate) =>
  candidate.name === model || candidate.model === model
);
if (!row?.digest || !/^[a-f0-9]{64}$/i.test(row.digest)) {
  throw new Error(`model_digest_not_found:${model}`);
}

console.log(row.digest.toLowerCase());
