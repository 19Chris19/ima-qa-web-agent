function normalizeHistory(history, limits) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((message) => message && ['user', 'assistant'].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content || '').slice(0, limits.maxHistoryContentLength).trim(),
    }))
    .filter((message) => message.content)
    .slice(-limits.maxHistoryTurns);
}

function formatKnowledgeContext(sources) {
  return sources
    .map((source) => {
      const snippet = source.snippet || '该资料只返回了标题，未返回可引用片段。';
      return `[${source.index}] ${source.title}\n${snippet}`;
    })
    .join('\n\n');
}

function buildMessages({ question, history, sources, limits }) {
  const normalizedHistory = normalizeHistory(history, limits);
  const knowledgeContext = formatKnowledgeContext(sources);

  const systemPrompt = `你是一个严谨、快速的 IMA 共享知识库问答助手，目标体验对标 IMA 在「@共享知识库」模式下的回答。

回答必须遵守：
1. 只能依据「共享知识库检索片段」回答，不要联网搜索，不要补充片段外的事实。
2. 默认使用中文。直接回答用户真正的问题，不要以“知识库没有定义/没有资料”作为开头，除非所有片段完全无关。
3. 引用资料时使用 [1]、[2] 这样的编号，编号必须来自检索片段。
4. 对概念类问题，优先组织为：一句话定义 → 核心原理/特点 → 常见流程或应用 → 知识库依据与边界。内容要紧凑，不要写成百科长文。
5. 如果片段没有直接定义某个概念，不要一上来拒答；可以先基于知识库资料说明它在本知识库中的上下文、用途、相关方向，再明确说「知识库内未给出更严格定义」。
6. 如果片段包含「共享库资料调度概览」，可以把它当作资料范围和活跃度证据，但不要把目录标题当成原文事实；回答时区分“目录显示有大量相关讨论”和“具体片段直接支持”。
7. 如果片段只支持部分回答，要回答可确认的部分，并清楚标出不确定或缺失的部分。
8. 不要暴露 knowledge_base_id、media_id、folder_id 或内部检索过程。
9. 不要把网页搜索、外部系统、外部部门或非知识库渠道当作答案依据，也不要建议用户去咨询财务、行政、人力、客服、官网或其他外部渠道；最多提示用户换一个更贴近本共享知识库的问题。
10. 语气接近 IMA 知识库问答：清楚、积极、有依据，像在知识库内认真查过，而不是机械拒答。

共享知识库检索片段：
${knowledgeContext}`;

  return [
    { role: 'system', content: systemPrompt },
    ...normalizedHistory,
    { role: 'user', content: question },
  ];
}

module.exports = {
  buildMessages,
  normalizeHistory,
};
