import { toolsForClaude, getTool } from './tool-registry.js';

const CLASSIFY_SYSTEM_PROMPT = `Você classifica a resposta de um usuário a uma proposta de ação pendente no Bitrix24.
Responda APENAS com um JSON válido, sem texto ao redor, no formato:
{"category": "confirm" | "refuse" | "adjust" | "new_request", "updatedParams": <objeto com os parâmetros atualizados da ação, no mesmo formato dos parâmetros originais, ou null>}

Regras:
- "confirm": o usuário concorda em executar a ação como proposta (ex: "sim", "pode", "confirma").
- "refuse": o usuário não quer executar a ação (ex: "não", "deixa pra lá", "cancela").
- "adjust": o usuário quer mudar um detalhe da MESMA ação/entidade (ex: outro prazo, outro responsável). Inclua em "updatedParams" os parâmetros já com o ajuste aplicado.
- "new_request": o usuário mudou de assunto — menciona uma entidade diferente ou uma intenção sem relação com a ação pendente.`;

function extractJson(response) {
  const textBlock = response.content.find(b => b.type === 'text');
  return JSON.parse(textBlock.text);
}

export function createAgentLoop({ anthropic, pendingActions, memory, auditLog, model = 'claude-sonnet-5', toolExecutor }) {
  async function executeTool(name, params) {
    if (toolExecutor) return toolExecutor(name, params);
    return getTool(name).handler(params);
  }

  async function evaluateMemory({ userId, interactionSummary }) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 300,
      system: 'Você decide se uma interação revelou um fato durável sobre o usuário que vale lembrar para o futuro (ex: preferências, padrões repetidos). Responda APENAS com JSON: {"fact": string | null, "reason": string, "howToApply": string}. Use fact: null se não houver nada digno de nota.',
      messages: [{ role: 'user', content: interactionSummary }],
    });
    const parsed = extractJson(response);
    if (parsed.fact) {
      memory.appendFact(userId, { fact: parsed.fact, reason: parsed.reason, howToApply: parsed.howToApply });
    }
  }

  async function handlePending({ userId, dialogId, text, pending }) {
    const classifyResponse = await anthropic.messages.create({
      model,
      max_tokens: 500,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Ação pendente: ${pending.summary}\nParâmetros atuais: ${JSON.stringify(pending.params)}\nResposta do usuário: "${text}"`,
      }],
    });
    const { category, updatedParams } = extractJson(classifyResponse);

    if (category === 'confirm') {
      const result = await executeTool(pending.tool, pending.params);
      pendingActions.clearPending(dialogId);
      auditLog.logAction({ userId, dialogId, tool: pending.tool, params: pending.params, result });
      await evaluateMemory({ userId, interactionSummary: `Usuário confirmou e o assistente executou: ${pending.summary}. Resultado: ${JSON.stringify(result)}.` });
      return { replies: [`Feito! ${JSON.stringify(result)}`] };
    }

    if (category === 'refuse') {
      pendingActions.clearPending(dialogId);
      return { replies: ['Ok, cancelado.'] };
    }

    if (category === 'adjust') {
      const updated = { tool: pending.tool, params: updatedParams ?? pending.params, summary: pending.summary };
      pendingActions.setPending(dialogId, updated);
      return { replies: [`Atualizei a proposta: ${JSON.stringify(updated.params)}. Confirma? (sim/não)`] };
    }

    // category === 'new_request'
    pendingActions.clearPending(dialogId);
    const newRequestResult = await loop._handleNewRequest({ userId, dialogId, text });
    return { replies: ['Cancelei a proposta anterior, já que você mudou de assunto.', ...newRequestResult.replies] };
  }

  async function handleNewRequest({ userId, dialogId, text }) {
    const facts = memory.loadFacts(userId);
    const factsBlock = facts.length
      ? `Fatos conhecidos sobre este usuário (use para não pedir informação que ele já deu antes):\n${facts.map(f => `- ${f.fact} (${f.howToApply})`).join('\n')}`
      : '';

    const messages = [{ role: 'user', content: text }];

    while (true) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: `Você é o assistente do Bitrix24. Interprete o pedido do usuário e use as ferramentas disponíveis para executá-lo. ${factsBlock}`,
        tools: toolsForClaude(),
        messages,
      });

      if (response.stop_reason !== 'tool_use') {
        const textBlock = response.content.find(b => b.type === 'text');
        const replyText = textBlock ? textBlock.text : '(sem resposta)';
        await evaluateMemory({ userId, interactionSummary: `Pedido do usuário: "${text}". Resposta do assistente: "${replyText}".` });
        return { replies: [replyText] };
      }

      const toolUseBlock = response.content.find(b => b.type === 'tool_use');
      const tool = getTool(toolUseBlock.name);

      if (tool.sensitive) {
        const introBlock = response.content.find(b => b.type === 'text');
        const summary = introBlock ? introBlock.text : `Executar ${tool.name} com ${JSON.stringify(toolUseBlock.input)}`;
        pendingActions.setPending(dialogId, { tool: tool.name, params: toolUseBlock.input, summary });
        return { replies: [`${summary} Confirma? (sim/não)`] };
      }

      const result = await executeTool(tool.name, toolUseBlock.input);
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: JSON.stringify(result) }] });
    }
  }

  const loop = {
    async handleMessage({ userId, dialogId, text }) {
      const pending = pendingActions.getPending(dialogId);
      if (pending) {
        return handlePending({ userId, dialogId, text, pending });
      }
      return loop._handleNewRequest({ userId, dialogId, text });
    },
    _handleNewRequest: handleNewRequest,
  };

  return loop;
}
