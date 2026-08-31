import { spawn } from 'node:child_process';

const BUILTIN_TOOLS_TO_DISABLE = 'Bash Edit Write Read Glob Grep WebFetch WebSearch NotebookEdit Task';

const TOOL_CALL_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    text: { type: ['string', 'null'] },
    tool_call: {
      type: ['object', 'null'],
      properties: {
        name: { type: 'string' },
        input: { type: 'object' },
      },
      required: ['name', 'input'],
    },
  },
  required: ['text', 'tool_call'],
});

function serializeBlocks(blocks) {
  return blocks.map(b => {
    if (b.type === 'text') return b.text;
    if (b.type === 'tool_use') return `(chamou a ferramenta "${b.name}" com input ${JSON.stringify(b.input)})`;
    if (b.type === 'tool_result') return `(resultado da ferramenta: ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)})`;
    return JSON.stringify(b);
  }).join('\n');
}

function contentToText(content) {
  return typeof content === 'string' ? content : serializeBlocks(content);
}

function serializeMessages(messages) {
  return messages.map(m => `[${m.role}]\n${contentToText(m.content)}`).join('\n\n');
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

// The model sometimes wraps its JSON answer in a markdown code fence
// (```json ... ```) despite being asked for raw JSON. Strip that before parsing.
export function parseJsonLoose(text) {
  const trimmed = text.trim();
  const fenced = trimmed.startsWith('```') ? trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/) : null;
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

// The full zod-to-json-schema output (verbose nested types + long descriptions
// with examples) is expensive to repeat on every call across ~25 tools. This
// keeps only what the model needs to pick reasonable params: name, type,
// required flag, and a short description.
function compactSchema(schema) {
  const required = new Set(schema.required || []);
  const props = schema.properties || {};
  return Object.entries(props)
    .map(([name, def]) => {
      const type = def.type || (def.anyOf ? def.anyOf.map(d => d.type).join('|') : 'any');
      const req = required.has(name) ? ', obrigatório' : '';
      const desc = truncate(def.description, 100);
      return `  - ${name} (${type}${req})${desc ? `: ${desc}` : ''}`;
    })
    .join('\n');
}

export function createClaudeCodeAdapter({ model = 'claude-sonnet-5', run } = {}) {
  const execClaude = run ?? defaultRun;

  async function runWithRetryOnEnoent(args, prompt) {
    try {
      return await execClaude(args, prompt);
    } catch (err) {
      // The claude CLI occasionally self-updates its binary mid-flight (atomic
      // symlink swap), causing a transient ENOENT on spawn. One retry after a
      // short delay is enough to ride out that window.
      if (err.code !== 'ENOENT') throw err;
      await new Promise(resolve => setTimeout(resolve, 500));
      return execClaude(args, prompt);
    }
  }

  async function runClaude({ prompt, jsonSchema }) {
    // The prompt is sent over stdin rather than as a CLI argument: conversation
    // history makes it grow across turns, and argv has an OS-level size limit
    // (E2BIG) that a long-running chat will eventually hit.
    const args = [
      '-p',
      '--output-format', 'json',
      '--no-session-persistence',
      '--safe-mode',
      '--model', model,
      '--disallowedTools', BUILTIN_TOOLS_TO_DISABLE,
    ];
    if (jsonSchema) args.push('--json-schema', jsonSchema);

    const stdout = await runWithRetryOnEnoent(args, prompt);
    return parseJsonLoose(stdout);
  }

  return {
    messages: {
      async create({ system, messages, tools }) {
        if (!tools || tools.length === 0) {
          const prompt = `${system}\n\n${serializeMessages(messages)}`;
          const envelope = await runClaude({ prompt });
          return { content: [{ type: 'text', text: envelope.result }] };
        }

        const toolsBlock = tools
          .map(t => `- ${t.name}: ${truncate(t.description, 200)}\n${compactSchema(t.input_schema)}`)
          .join('\n');
        const prompt = [
          system,
          '',
          'Ferramentas disponíveis (você NÃO deve executá-las diretamente — apenas decidir qual chamar, se alguma):',
          toolsBlock,
          '',
          'Se precisar chamar uma ferramenta, preencha "tool_call" com {name, input} e deixe "text" como null.',
          'Se já tiver a resposta final para o usuário, preencha "text" com essa resposta e deixe "tool_call" como null.',
          '',
          'Histórico da conversa:',
          serializeMessages(messages),
        ].join('\n');

        const envelope = await runClaude({ prompt, jsonSchema: TOOL_CALL_JSON_SCHEMA });
        const parsed = envelope.structured_output ?? parseJsonLoose(envelope.result);

        const content = [];
        if (parsed.text) content.push({ type: 'text', text: parsed.text });
        if (parsed.tool_call) {
          content.push({
            type: 'tool_use',
            id: `toolu_${Math.random().toString(36).slice(2)}`,
            name: parsed.tool_call.name,
            input: parsed.tool_call.input,
          });
        }

        return { content, stop_reason: parsed.tool_call ? 'tool_use' : 'end_turn' };
      },
    },
  };
}

function extractFailureReason(stdout) {
  try {
    const envelope = JSON.parse(stdout);
    return envelope.result || envelope.error_description || null;
  } catch {
    return null;
  }
}

function defaultRun(args, prompt) {
  const { ANTHROPIC_API_KEY, ...env } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        const reason = extractFailureReason(stdout) || stderr.trim() || '(sem detalhe)';
        const err = new Error(`claude exited with code ${code}: ${truncate(reason, 300)}`);
        err.stdoutOutput = stdout;
        err.stderrOutput = stderr;
        return reject(err);
      }
      resolve(stdout);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
