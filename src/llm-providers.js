import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callClaude } from './spawn-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'llm-config.json');

const DEFAULT_CONFIG = {
  providers: {
    'claude-cli': { type: 'claude-cli' },
  },
  stages: {
    default: 'claude-cli',
  },
};

export function loadConfig() {
  let config;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    config = DEFAULT_CONFIG;
  }

  // Env overrides: TF_LLM_<STAGE>=<provider_name> (e.g. TF_LLM_PARTITION=gpt4o-mini)
  const stages = { ...config.stages };
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith('TF_LLM_') && val) {
      const stage = key.slice(7).toLowerCase(); // TF_LLM_PARTITION → partition
      stages[stage] = val;
    }
  }
  return { ...config, stages };
}

export function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function callClaudeCli(prompt, systemPrompt, timeoutMs) {
  return callClaude(prompt, systemPrompt, timeoutMs);
}

async function callOpenAI(providerConfig, providerName, prompt, systemPrompt, images, timeoutMs) {
  const apiKey = process.env[providerConfig.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Provider '${providerName}' requires ${providerConfig.apiKeyEnv} environment variable to be set`);
  }

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  let userContent;
  if (images && images.length > 0) {
    const contentParts = [{ type: 'text', text: prompt }];
    for (const imgPath of images) {
      const buf = await readFile(imgPath);
      const b64 = buf.toString('base64');
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${b64}` },
      });
    }
    userContent = contentParts;
  } else {
    userContent = prompt;
  }

  messages.push({ role: 'user', content: userContent });

  const call = client.chat.completions.create({
    model: providerConfig.model,
    messages,
  });

  const response = await withTimeout(call, timeoutMs);
  return response.choices[0].message.content;
}

async function callAnthropic(providerConfig, providerName, prompt, systemPrompt, images, timeoutMs) {
  const apiKey = process.env[providerConfig.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Provider '${providerName}' requires ${providerConfig.apiKeyEnv} environment variable to be set`);
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const contentArray = [];

  if (images && images.length > 0) {
    for (const imgPath of images) {
      const buf = await readFile(imgPath);
      const b64 = buf.toString('base64');
      contentArray.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: b64 },
      });
    }
  }

  contentArray.push({ type: 'text', text: prompt });

  const params = {
    model: providerConfig.model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: contentArray }],
  };
  if (systemPrompt) {
    params.system = systemPrompt;
  }

  const call = client.messages.create(params);
  const response = await withTimeout(call, timeoutMs);
  return response.content[0].text;
}

async function callOllama(providerConfig, prompt, systemPrompt, timeoutMs) {
  const baseUrl = providerConfig.baseUrl || 'http://localhost:11434';
  const body = {
    model: providerConfig.model,
    prompt,
    stream: false,
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const call = fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }).then(r => r.json());

  const json = await withTimeout(call, timeoutMs);
  return json.response;
}

export function providerSupportsVision(providerConfig) {
  return providerConfig.type === 'anthropic' || providerConfig.type === 'openai';
}

export function getStageProvider(stage) {
  const config = loadConfig();
  const providerName = config.stages?.[stage] ?? config.stages?.default ?? 'claude-cli';
  const providerConfig = config.providers?.[providerName];
  if (!providerConfig) throw new Error(`Provider '${providerName}' not found in llm-config.json`);
  return { providerName, providerConfig };
}

export async function callLLM(prompt, systemPrompt, options = {}) {
  const { stage = 'default', timeoutMs = 120000, images = [] } = options;

  const config = loadConfig();
  const providerName = config.stages?.[stage] ?? config.stages?.default ?? 'claude-cli';
  const providerConfig = config.providers?.[providerName];

  if (!providerConfig) {
    throw new Error(`Unknown LLM provider '${providerName}' referenced by stage '${stage}'`);
  }

  switch (providerConfig.type) {
    case 'claude-cli':
      return withTimeout(callClaudeCli(prompt, systemPrompt, timeoutMs), timeoutMs);

    case 'openai':
      return callOpenAI(providerConfig, providerName, prompt, systemPrompt, images, timeoutMs);

    case 'anthropic':
      return callAnthropic(providerConfig, providerName, prompt, systemPrompt, images, timeoutMs);

    case 'ollama':
      return callOllama(providerConfig, prompt, systemPrompt, timeoutMs);

    default:
      throw new Error(`Unsupported provider type '${providerConfig.type}' for provider '${providerName}'`);
  }
}
