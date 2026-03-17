import { spawn } from 'node:child_process';

export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function callClaude(prompt, systemPrompt, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt];
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', err => reject(new Error(`Failed to spawn claude: ${err.message}`)));

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}
