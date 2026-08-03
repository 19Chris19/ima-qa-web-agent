const fs = require('node:fs');
const path = require('node:path');
const { buildQueryCandidates } = require('./ima-client');
const { buildEvidencePack, cleanText, truncateText } = require('./evidence-pack');
const { defaultIndexDir, tokenizeForSearch } = require('./local-rag-indexer');
const {
  buildSecondPassQueries,
  disambiguateCandidates,
  DOMAIN_TERMS,
  extractSecondPassTerms,
  hasStrongParameterThreshold,
  planLocalRagQuery,
  scoreCoveragePriority,
  selectCoverageCandidates,
} = require('./local-rag-planner');

const DEFAULT_LOCAL_RAG_MAX_SOURCES = 8;
const DEFAULT_LOCAL_RAG_QUERY_LIMIT = 12;
const DEFAULT_LOCAL_RAG_PER_QUERY_CANDIDATES = 80;
const DEFAULT_LOCAL_RAG_MAX_CANDIDATES = 700;
const DEFAULT_LOCAL_RAG_MAX_EVIDENCE_SOURCES = 18;
const DEFAULT_LOCAL_RAG_MAX_PUBLIC_SOURCES = 10;
const DEFAULT_LOCAL_RAG_ADJACENT_CHUNKS = 1;
const DEFAULT_LOCAL_RAG_MIN_RELEVANCE_SCORE = 18;
const GENERIC_RELEVANCE_TERMS = new Set([
  '今天',
  '今晚',
  '天晚',
  '晚上',
  '上吃',
  '吃什',
  '这个',
  '那个',
  '什么',
  '怎么',
  '如何',
  '哪些',
  '为什么',
  '是否',
  '定义',
  '原理',
  '流程',
  '应用',
  '边界',
  '误解',
  '案例',
  '方案',
  '问题',
  '需要',
  '主要',
  '可以',
  '进行',
  '使用',
  '时候',
  '方面',
]);
const ADDITIONAL_KNOWLEDGE_DOMAIN_TERMS = [
  '3DGS',
  '高斯',
  'Gaussian',
  'Blender',
  'GLB',
  'COLMAP',
  'PLY',
  'Splat',
  'MipMap',
  'NeRF',
  '点云',
  '建图',
  '渲染',
  '训练',
  '采集',
  '航拍',
  '无人机',
  '照片',
  '图像',
  '视频',
  '全景',
  '数字孪生',
  '文物',
  '电商',
  'VR',
  'AR',
  '商单',
  '定价',
  '交付',
  '创业',
  '小程序',
  '网站',
  '模型',
  '重建',
  '空三',
  '导出',
  '导入',
  '材质',
  '网格',
  'Mesh',
];
const KNOWLEDGE_DOMAIN_TERMS = mergeUnique([
  ...Object.values(DOMAIN_TERMS).flat(),
  ...ADDITIONAL_KNOWLEDGE_DOMAIN_TERMS,
]);

class LocalRAGIndexNotFoundError extends Error {
  constructor(indexPath) {
    super(`本地知识库索引不存在，请先运行 npm run local-rag:index (${indexPath})`);
    this.name = 'LocalRAGIndexNotFoundError';
    this.statusCode = 503;
    this.reason = 'local_rag_index_missing';
  }
}

class LocalRAGClient {
  constructor(config = {}) {
    this.indexDir = path.resolve(config.indexDir || defaultIndexDir());
    this.indexPath = path.join(this.indexDir, 'index.json');
    this.maxSources = config.maxSources || config.maxPublicSources || DEFAULT_LOCAL_RAG_MAX_PUBLIC_SOURCES;
    this.queryLimit = config.queryLimit || DEFAULT_LOCAL_RAG_QUERY_LIMIT;
    this.perQueryCandidates = config.perQueryCandidates || DEFAULT_LOCAL_RAG_PER_QUERY_CANDIDATES;
    this.maxCandidates = config.maxCandidates || DEFAULT_LOCAL_RAG_MAX_CANDIDATES;
    this.maxEvidenceSources = config.maxEvidenceSources || DEFAULT_LOCAL_RAG_MAX_EVIDENCE_SOURCES;
    this.maxPublicSources = config.maxPublicSources || this.maxSources || DEFAULT_LOCAL_RAG_MAX_PUBLIC_SOURCES;
    this.minRelevanceScore = Number.isFinite(config.minRelevanceScore)
      ? config.minRelevanceScore
      : DEFAULT_LOCAL_RAG_MIN_RELEVANCE_SCORE;
    this.enableSecondPass = config.enableSecondPass !== false;
    this.enableCoverage = config.enableCoverage !== false;
    this.adjacentChunks = Number.isInteger(config.adjacentChunks)
      ? config.adjacentChunks
      : DEFAULT_LOCAL_RAG_ADJACENT_CHUNKS;
    this.index = null;
    this.indexMtimeMs = 0;
  }

  async retrieveEvidencePack(question) {
    const index = this.loadIndex();
    const plan = planLocalRagQuery(question, { queryLimit: this.queryLimit });
    const legacyQueries = buildLocalQueryCandidates(question, { queryLimit: this.queryLimit });
    const queryCandidates = mergeUnique([...plan.queries, ...legacyQueries]).slice(0, this.queryLimit);
    const firstPass = scoreChunksByQuery(index, queryCandidates, {
      perQueryCandidates: this.perQueryCandidates,
      maxCandidates: this.maxCandidates,
    });

    let secondPassTerms = [];
    let secondPassQueries = [];
    let secondPass = [];
    if (this.enableSecondPass) {
      secondPassTerms = extractSecondPassTerms(firstPass, plan);
      secondPassQueries = buildSecondPassQueries(question, secondPassTerms, plan, {
        maxQueries: Math.max(0, this.queryLimit - queryCandidates.length + 4),
      });
      secondPass = scoreChunksByQuery(index, secondPassQueries, {
        perQueryCandidates: Math.max(20, Math.floor(this.perQueryCandidates / 2)),
        maxCandidates: this.maxCandidates,
        scoreMultiplier: 0.86,
      });
    }

    const mergedCandidates = mergeScoredCandidates([...firstPass, ...secondPass])
      .slice(0, this.maxCandidates);
    const disambiguated = disambiguateCandidates(question, mergedCandidates);
    const expanded = expandAdjacentChunks(index, disambiguated.kept, this.adjacentChunks)
      .slice(0, this.maxCandidates);
    const coverageSelection = this.enableCoverage
      ? selectCoverageCandidates(expanded, plan, { maxSources: this.maxEvidenceSources })
      : { selected: expanded.slice(0, this.maxEvidenceSources), coverage: null };
    const focusedEvidence = coverageSelection.selected.map((candidate) => focusEvidenceCandidate(candidate, {
      plan,
      focusTerms: secondPassTerms,
      question,
    }));
    const relevance = filterEvidenceByRelevance(focusedEvidence, {
      maxEvidenceSources: this.maxEvidenceSources,
      maxPublicSources: this.maxPublicSources,
      minRelevanceScore: this.minRelevanceScore,
      plan,
      question,
    });
    const publicEvidence = relevance.publicEvidence;
    const evidencePack = buildEvidencePack(publicEvidence, {
      maxSources: this.maxPublicSources,
      maxSnippetLength: 1200,
      maxEvidenceLength: 2200,
    });

    return {
      ...evidencePack,
      diagnostics: {
        ...(evidencePack.diagnostics || {}),
        provider: 'local-rag-mimo',
        plannerType: plan.plannerType,
        queryVariantCount: queryCandidates.length,
        queries: queryCandidates,
        matchedQueries: queryCandidates,
        firstPassCandidateCount: firstPass.length,
        secondPassTerms,
        secondPassQueries,
        secondPassCandidateCount: secondPass.length,
        dedupedCandidateCount: mergedCandidates.length,
        discardedByDisambiguation: disambiguated.discarded.length,
        coverage: coverageSelection.coverage || undefined,
        relevanceGate: relevance.diagnostics,
        rawEvidenceSourceCount: focusedEvidence.length,
        evidenceSourceCount: relevance.evidence.length,
        publicSourceCount: evidencePack.sources.length,
        focusedSourceCount: relevance.evidence.filter((candidate) => candidate.focused).length,
        indexedChunkCount: index.stats?.chunkCount || index.chunks?.length || 0,
        localCandidateCount: mergedCandidates.length,
        adjacentExpandedCount: expanded.length,
        indexBuiltAt: index.builtAt,
      },
    };
  }

  async searchKnowledge(question) {
    const evidencePack = await this.retrieveEvidencePack(question);
    return evidencePack.sources;
  }

  getStatus() {
    try {
      const index = this.loadIndex();
      return {
        available: true,
        indexPath: this.indexPath,
        builtAt: index.builtAt,
        stats: index.stats || {},
      };
    } catch (error) {
      return {
        available: false,
        indexPath: this.indexPath,
        error: error.reason || 'local_rag_unavailable',
      };
    }
  }

  loadIndex() {
    if (!fs.existsSync(this.indexPath)) {
      throw new LocalRAGIndexNotFoundError(this.indexPath);
    }

    const stat = fs.statSync(this.indexPath);
    if (this.index && stat.mtimeMs === this.indexMtimeMs) {
      return this.index;
    }

    this.index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    this.indexMtimeMs = stat.mtimeMs;
    return this.index;
  }
}

function buildLocalQueryCandidates(question, options = {}) {
  const candidates = [];
  const push = (...values) => {
    for (const value of values) {
      const text = cleanText(value);
      if (text && !candidates.includes(text)) {
        candidates.push(text);
      }
    }
  };

  push(...buildQueryCandidates(question));

  const compactChinese = cleanText(question).replace(/[^\p{Script=Han}a-zA-Z0-9]+/gu, '');
  if (compactChinese.length >= 4) {
    push(compactChinese.slice(0, 32));
  }

  return candidates.slice(0, options.queryLimit || 10);
}

function scoreChunksByQuery(index, queries, options = {}) {
  const perQueryCandidates = options.perQueryCandidates || DEFAULT_LOCAL_RAG_PER_QUERY_CANDIDATES;
  const maxCandidates = options.maxCandidates || DEFAULT_LOCAL_RAG_MAX_CANDIDATES;
  const scoreMultiplier = Number.isFinite(options.scoreMultiplier) ? options.scoreMultiplier : 1;
  const merged = new Map();

  for (const query of queries) {
    const scored = scoreChunks(index, [query], { maxCandidates: perQueryCandidates });
    for (const candidate of scored) {
      const existing = merged.get(candidate.id);
      const nextScore = (candidate.score || 0) * scoreMultiplier;
      if (existing) {
        existing.score += nextScore;
        existing.maxScore = Math.max(existing.maxScore || 0, nextScore);
        existing.matchedQueries = mergeUnique([...(existing.matchedQueries || []), query]);
        existing.matchedTerms = mergeUnique([
          ...(existing.matchedTerms || []),
          ...(candidate.matchedTerms || []),
        ]);
        continue;
      }
      merged.set(candidate.id, {
        ...candidate,
        score: nextScore,
        maxScore: nextScore,
        matchedQueries: mergeUnique([...(candidate.matchedQueries || []), query]),
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, maxCandidates);
}

function mergeScoredCandidates(candidates) {
  const merged = new Map();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.id);
    if (existing) {
      existing.score += candidate.score || 0;
      existing.maxScore = Math.max(existing.maxScore || 0, candidate.maxScore || candidate.score || 0);
      existing.matchedQueries = mergeUnique([
        ...(existing.matchedQueries || []),
        ...(candidate.matchedQueries || []),
      ]);
      existing.matchedTerms = mergeUnique([
        ...(existing.matchedTerms || []),
        ...(candidate.matchedTerms || []),
      ]);
      continue;
    }
    merged.set(candidate.id, { ...candidate });
  }
  return [...merged.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
}

function scoreChunks(index, queryCandidates, options = {}) {
  const maxCandidates = options.maxCandidates || DEFAULT_LOCAL_RAG_MAX_CANDIDATES;
  const scores = new Map();
  const matchedQueries = new Map();
  const matchedTerms = new Map();
  const chunks = Array.isArray(index.chunks) ? index.chunks : [];
  const docLengths = Array.isArray(index.docLengths) ? index.docLengths : [];
  const totalDocs = Math.max(chunks.length, 1);
  const avgDocLength = Number(index.stats?.avgDocLength) || 1;

  for (const query of queryCandidates) {
    const terms = [...new Set(tokenizeForSearch(query))];
    for (const term of terms) {
      const postings = index.postings?.[term] || [];
      if (!postings.length) {
        continue;
      }
      const idf = Math.log(1 + (totalDocs - postings.length + 0.5) / (postings.length + 0.5));
      for (const [chunkIndex, tf] of postings) {
        const docLength = docLengths[chunkIndex] || avgDocLength;
        const bm25 =
          idf *
          ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (docLength / avgDocLength))));
        const titleBoost = chunks[chunkIndex]?.title?.toLowerCase().includes(term) ? 0.35 : 0;
        scores.set(chunkIndex, (scores.get(chunkIndex) || 0) + bm25 + titleBoost);
        addUnique(matchedQueries, chunkIndex, query);
        addUnique(matchedTerms, chunkIndex, term);
      }
    }
  }

  return [...scores.entries()]
    .map(([chunkIndex, score]) => ({
      ...chunks[chunkIndex],
      score,
      matchedQueries: matchedQueries.get(chunkIndex) || [],
      matchedTerms: matchedTerms.get(chunkIndex) || [],
      evidenceType: 'local-search',
    }))
    .filter((chunk) => chunk.snippet)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}

function expandAdjacentChunks(index, scoredChunks, adjacentChunks) {
  const chunks = Array.isArray(index.chunks) ? index.chunks : [];
  const byId = new Map(chunks.map((chunk, index) => [chunk.id, index]));
  const selected = new Map();

  for (const chunk of scoredChunks) {
    const indexInChunks = byId.get(chunk.id);
    if (!Number.isInteger(indexInChunks)) {
      continue;
    }
    mergeSelected(selected, chunk);
    for (let offset = 1; offset <= adjacentChunks; offset += 1) {
      mergeAdjacent(selected, chunks[indexInChunks - offset], chunk, offset);
      mergeAdjacent(selected, chunks[indexInChunks + offset], chunk, offset);
    }
  }

  return [...selected.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map((chunk) => ({
      ...chunk,
      snippet: truncateText(chunk.snippet, 2200),
    }));
}

function focusEvidenceCandidate(candidate, options = {}) {
  const snippet = removeShareNoise(candidate.snippet || '');
  const focusIndex = findFocusIndex(snippet, options);
  if (focusIndex < 0 || snippet.length <= 2200) {
    return {
      ...candidate,
      snippet: truncateText(snippet, 2200),
      focused: false,
    };
  }

  const start = findWindowStart(snippet, Math.max(0, focusIndex - 520));
  const end = Math.min(snippet.length, start + 2200);
  const focusedSnippet = `${start > 0 ? '…' : ''}${snippet.slice(start, end)}${end < snippet.length ? '…' : ''}`;
  return {
    ...candidate,
    snippet: focusedSnippet,
    focused: true,
  };
}

function filterEvidenceByRelevance(candidates, options = {}) {
  const question = cleanText(options.question);
  const plan = options.plan || {};
  const maxEvidenceSources = options.maxEvidenceSources || DEFAULT_LOCAL_RAG_MAX_EVIDENCE_SOURCES;
  const maxPublicSources = options.maxPublicSources || DEFAULT_LOCAL_RAG_MAX_PUBLIC_SOURCES;
  const minRelevanceScore = Number.isFinite(options.minRelevanceScore)
    ? options.minRelevanceScore
    : DEFAULT_LOCAL_RAG_MIN_RELEVANCE_SCORE;
  const questionProfile = buildQuestionRelevanceProfile(question, plan);

  const assessed = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      candidate,
      assessment: assessEvidenceRelevance(candidate, {
        minRelevanceScore,
        plan,
        questionProfile,
      }),
    }))
    .sort((a, b) => b.assessment.relevanceScore - a.assessment.relevanceScore);

  const accepted = assessed.filter((item) => item.assessment.accepted);
  const evidence = accepted
    .slice(0, maxEvidenceSources)
    .map((item) => ({
      ...item.candidate,
      relevanceScore: item.assessment.relevanceScore,
      relevanceSignals: item.assessment.signals,
    }));
  const publicLimit = chooseDynamicPublicSourceLimit(accepted, maxPublicSources, plan);
  const publicEvidence = evidence.slice(0, publicLimit);
  const dropped = assessed.length - accepted.length;
  const top = assessed[0]?.assessment;

  return {
    evidence,
    publicEvidence,
    diagnostics: {
      accepted: accepted.length > 0,
      reason: accepted.length > 0 ? 'relevant_evidence' : top?.rejectReason || 'no_candidates',
      minRelevanceScore,
      effectiveQuestionTermCount: questionProfile.effectiveTerms.length,
      questionHasDomainSignal: questionProfile.hasDomainSignal,
      keptEvidenceCandidates: evidence.length,
      keptPublicSources: publicEvidence.length,
      droppedEvidenceCandidates: dropped,
      publicSourceLimit: publicLimit,
      topRelevanceScore: top?.relevanceScore || 0,
      strongEvidenceCount: accepted.filter((item) => item.assessment.tier === 'strong').length,
      mediumEvidenceCount: accepted.filter((item) => item.assessment.tier === 'medium').length,
      weakEvidenceCount: accepted.filter((item) => item.assessment.tier === 'weak').length,
    },
  };
}

function chooseDynamicPublicSourceLimit(accepted, maxPublicSources, plan = {}) {
  if (!accepted.length) {
    return 0;
  }
  const strongCount = accepted.filter((item) => item.assessment.tier === 'strong').length;
  const mediumCount = accepted.filter((item) => item.assessment.tier === 'medium').length;
  const publicCeiling =
    plan.plannerType === 'parameter_setting'
      ? maxPublicSources
      : plan.plannerType === 'concept_explanation'
        ? Math.min(maxPublicSources, 6)
        : Math.min(maxPublicSources, 8);

  if (plan.plannerType === 'parameter_setting' && strongCount >= 8) {
    return Math.min(maxPublicSources, 10);
  }
  if (strongCount >= 8) {
    return Math.min(publicCeiling, 8);
  }
  if (strongCount >= 5) {
    return Math.min(publicCeiling, 6);
  }
  if (strongCount >= 3) {
    return Math.min(publicCeiling, 5);
  }
  if (strongCount >= 1 && mediumCount >= 2) {
    return Math.min(publicCeiling, 4);
  }
  if (mediumCount >= 2) {
    return Math.min(publicCeiling, 3);
  }
  return Math.min(publicCeiling, accepted.length, 2);
}

function buildQuestionRelevanceProfile(question, plan = {}) {
  const effectiveTerms = effectiveSearchTerms(question);
  return {
    effectiveTerms,
    hasDomainSignal: hasKnowledgeDomainSignal(question) || hasPlannerDomainSignal(plan),
  };
}

function assessEvidenceRelevance(candidate, options = {}) {
  const plan = options.plan || {};
  const minRelevanceScore = options.minRelevanceScore || DEFAULT_LOCAL_RAG_MIN_RELEVANCE_SCORE;
  const questionProfile = options.questionProfile || buildQuestionRelevanceProfile('', plan);
  const text = cleanText(`${candidate.title || ''} ${candidate.snippet || ''}`);
  const lowerText = text.toLowerCase();
  const matchedTerms = effectiveSearchTerms((candidate.matchedTerms || []).join(' '));
  const directQuestionHits = questionProfile.effectiveTerms.filter((term) =>
    lowerText.includes(term.toLowerCase()),
  );
  const focusScore = scoreCoveragePriority({ ...candidate, score: 0 }, plan);
  const hasDomainTextSignal = hasKnowledgeDomainSignal(text);
  const hasStrongThreshold = hasStrongParameterThreshold(candidate);
  const hasSpecificQuestionOverlap =
    directQuestionHits.length >= 2 || hasAsciiOrNumericHit(directQuestionHits) || matchedTerms.length >= 2;

  let relevanceScore = 0;
  relevanceScore += Math.min(directQuestionHits.length * 5, 25);
  relevanceScore += Math.min(matchedTerms.length * 4, 20);
  if (questionProfile.hasDomainSignal) {
    relevanceScore += 8;
  }
  if (hasDomainTextSignal) {
    relevanceScore += 14;
  }
  if (hasStrongThreshold) {
    relevanceScore += 35;
  }
  if (focusScore >= 70) {
    relevanceScore += 30;
  } else if (focusScore >= 24) {
    relevanceScore += 16;
  }
  if (candidate.focused) {
    relevanceScore += 4;
  }

  const isOffDomainGeneric = !questionProfile.hasDomainSignal && !hasDomainTextSignal;
  const isGenericOverlapOnly = !hasSpecificQuestionOverlap && !hasStrongThreshold && focusScore < 24;
  const accepted = !isOffDomainGeneric && !isGenericOverlapOnly && relevanceScore >= minRelevanceScore;
  let rejectReason = '';
  if (isOffDomainGeneric) {
    rejectReason = 'off_domain_generic_question';
  } else if (isGenericOverlapOnly) {
    rejectReason = 'only_generic_term_overlap';
  } else if (relevanceScore < minRelevanceScore) {
    rejectReason = 'below_relevance_threshold';
  }

  return {
    accepted,
    rejectReason,
    relevanceScore,
    tier: relevanceScore >= 58 ? 'strong' : relevanceScore >= 32 ? 'medium' : 'weak',
    signals: {
      directQuestionHitCount: directQuestionHits.length,
      matchedSpecificTermCount: matchedTerms.length,
      hasDomainTextSignal,
      hasStrongThreshold,
      focusScore,
    },
  };
}

function effectiveSearchTerms(value) {
  return mergeUnique(tokenizeForSearch(value || ''))
    .filter((term) => !GENERIC_RELEVANCE_TERMS.has(term))
    .filter((term) => term.length >= 2)
    .slice(0, 24);
}

function hasAsciiOrNumericHit(terms) {
  return terms.some((term) => /[a-z0-9]/i.test(term) || /%|≥|<=|>=|\d/.test(term));
}

function hasPlannerDomainSignal(plan = {}) {
  const domainHints = Object.values(plan.domainHints || {}).flat().filter(Boolean);
  const focusHints = Array.isArray(plan.focusHints) ? plan.focusHints : [];
  return domainHints.length > 0 || focusHints.length > 0;
}

function hasKnowledgeDomainSignal(text) {
  const value = cleanText(text);
  const lowerValue = value.toLowerCase();
  return KNOWLEDGE_DOMAIN_TERMS.some((term) => lowerValue.includes(term.toLowerCase()));
}

function removeShareNoise(snippet) {
  const lines = String(snippet || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isShareNoiseLine(line) || hasParameterEvidenceText(line));
  const text = lines.length ? lines.join('\n') : String(snippet || '');
  return cleanText(text)
    .replace(/【ima知识库】/gi, ' ')
    .replace(/群聊知识AI答疑/gi, ' ')
    .replace(/卡片解析/gi, ' ')
    .replace(/https?:\/\/mp\.weixin\.qq\.com\/\S+/gi, ' ')
    .replace(/\[音乐\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isShareNoiseLine(line) {
  return /【ima知识库】|群聊知识AI答疑|卡片解析|mp\.weixin\.qq\.com|\[音乐\]|腾讯ima/i.test(line);
}

function hasParameterEvidenceText(text) {
  return (
    /航向.{0,40}(80\s*%|80％|≥\s*80|>=\s*80)|(80\s*%|80％|≥\s*80|>=\s*80).{0,40}航向/.test(text)
    || /旁向.{0,40}(70\s*%|70％|≥\s*70|>=\s*70)|(70\s*%|70％|≥\s*70|>=\s*70).{0,40}旁向/.test(text)
    || /GSD.{0,16}(3\s*厘米|3\s*cm|≤\s*3|<=\s*3)|(3\s*厘米|3\s*cm|≤\s*3|<=\s*3).{0,16}GSD/i.test(text)
  );
}

function findFocusIndex(snippet, options = {}) {
  const plan = options.plan || {};
  const focusTerms = Array.isArray(options.focusTerms) ? options.focusTerms : [];
  const patterns = [];

  if (plan.plannerType === 'parameter_setting') {
    patterns.push(
      /航向.{0,32}(80\s*%|80％|≥\s*80|>=\s*80)|(80\s*%|80％|≥\s*80|>=\s*80).{0,32}航向/,
      /旁向.{0,32}(70\s*%|70％|≥\s*70|>=\s*70)|(70\s*%|70％|≥\s*70|>=\s*70).{0,32}旁向/,
      /75\s*[-~—–至到]\s*85|75\s*%|75％|85\s*%|85％/,
      /60\s*%?.{0,20}(下限|再低|对不上|失败)|下限.{0,20}60/,
      /视角多样性|多高度|环绕|多角度/,
      /照片数|照片数量|显存|VRAM|爆显存/,
    );
  }
  patterns.push(...buildFocusHintPatterns(plan));
  patterns.push(...buildQuestionFocusPatterns(options.question));

  for (const pattern of patterns) {
    const match = pattern.exec(snippet);
    if (match) {
      return match.index;
    }
  }

  for (const term of focusTerms) {
    const index = snippet.toLowerCase().indexOf(String(term).toLowerCase());
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

function buildFocusHintPatterns(plan) {
  const hints = Array.isArray(plan?.focusHints) ? plan.focusHints : [];
  const patterns = [];
  if (hints.includes('tool_comparison')) {
    patterns.push(
      /PostShot.{0,80}BSD|BSD.{0,80}PostShot|LichtFeld|LFS|RealityScan/,
      /对比|差异|细节最好|错误\s*splat|效果|画质|色彩|速度|显存|渲染平台/,
    );
  }
  if (hints.includes('mesh_printing')) {
    patterns.push(/Kiri|高斯转\s*mesh|网格化|可打印|3D打印|打印机|球谐函数|颜色不正确/i);
  }
  if (hints.includes('material_reflection')) {
    patterns.push(/透明|反光|玻璃|金属|高光|材质|交叉偏振|偏振镜|灰扑扑|展柜|噪点/i);
  }
  if (hints.includes('four_d')) {
    patterns.push(/4DGS|4D高斯|时间维度|动态场景|人体|演唱会|舞台|子弹时间|摄像机阵列/i);
  }
  if (hints.includes('large_scene')) {
    patterns.push(/巨型|大场景|园区|城市街区|空地融合|无人机.{0,12}地面|地面.{0,12}无人机|分块训练|分批训练|LOD|流式加载|数千张|十万张/i);
  }
  if (hints.includes('opacity_color')) {
    patterns.push(/不透明度|opacity|颜色|color|密度|density|致密化|边缘|渲染精度|高斯点数量|过滤掉无效的高斯点/i);
  }
  if (hints.includes('software_io')) {
    patterns.push(/Metashape|PostShot|BSD|导入|空三|数据导入|高斯训练|ply|COLMAP|sparse|cameras|images/i);
  }
  if (hints.includes('panorama_training')) {
    patterns.push(/全景|单镜头|双镜头|Insta360|拼接|抽帧|鱼眼|画质|像素质量|涂抹/i);
  }
  return patterns;
}

function buildQuestionFocusPatterns(question) {
  const tokens = tokenizeForSearch(question || '')
    .filter((token) => String(token).length >= 2)
    .slice(0, 8)
    .map(escapeRegex);
  return tokens.map((token) => new RegExp(token, 'i'));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findWindowStart(text, preferredStart) {
  if (preferredStart <= 0) {
    return 0;
  }
  const before = text.slice(Math.max(0, preferredStart - 180), preferredStart);
  const boundary = Math.max(
    before.lastIndexOf('。'),
    before.lastIndexOf('；'),
    before.lastIndexOf(';'),
    before.lastIndexOf('\n'),
  );
  if (boundary >= 0) {
    return preferredStart - before.length + boundary + 1;
  }
  return preferredStart;
}

function mergeAdjacent(selected, adjacent, parent, offset) {
  if (!adjacent || adjacent.filePath !== parent.filePath) {
    return;
  }
  mergeSelected(selected, {
    ...adjacent,
    score: Math.max((parent.score || 0) - offset * 0.2, 0.01),
    matchedQueries: parent.matchedQueries,
    matchedTerms: parent.matchedTerms,
    evidenceType: 'local-adjacent',
  });
}

function mergeSelected(selected, chunk) {
  const existing = selected.get(chunk.id);
  if (!existing || (chunk.score || 0) > (existing.score || 0)) {
    selected.set(chunk.id, chunk);
  }
}

function addUnique(map, key, value) {
  const values = map.get(key) || [];
  if (!values.includes(value)) {
    values.push(value);
  }
  map.set(key, values);
}

function mergeUnique(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

module.exports = {
  DEFAULT_LOCAL_RAG_ADJACENT_CHUNKS,
  DEFAULT_LOCAL_RAG_MAX_CANDIDATES,
  DEFAULT_LOCAL_RAG_MAX_EVIDENCE_SOURCES,
  DEFAULT_LOCAL_RAG_MAX_PUBLIC_SOURCES,
  DEFAULT_LOCAL_RAG_MIN_RELEVANCE_SCORE,
  DEFAULT_LOCAL_RAG_PER_QUERY_CANDIDATES,
  DEFAULT_LOCAL_RAG_QUERY_LIMIT,
  DEFAULT_LOCAL_RAG_MAX_SOURCES,
  LocalRAGClient,
  LocalRAGIndexNotFoundError,
  assessEvidenceRelevance,
  buildLocalQueryCandidates,
  expandAdjacentChunks,
  filterEvidenceByRelevance,
  focusEvidenceCandidate,
  mergeScoredCandidates,
  scoreChunksByQuery,
  scoreChunks,
};
