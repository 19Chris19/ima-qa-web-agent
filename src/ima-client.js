const IMA_BASE_URL = 'https://ima.qq.com';
const SEARCH_KNOWLEDGE_PATH = '/openapi/wiki/v1/search_knowledge';
const GET_KNOWLEDGE_BASE_PATH = '/openapi/wiki/v1/get_knowledge_base';
const GET_KNOWLEDGE_LIST_PATH = '/openapi/wiki/v1/get_knowledge_list';
const GET_MEDIA_INFO_PATH = '/openapi/wiki/v1/get_media_info';
const GET_DOC_CONTENT_PATH = '/openapi/note/v1/get_doc_content';
const RAW_FOLDER_TITLE_PATTERN = /NotebookLM|raw|群聊|group/i;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 800;
const DEFAULT_MAX_ENRICHED_SOURCES = 6;
const DEFAULT_ENRICH_SNIPPET_THRESHOLD = 700;
const IMA_OPENAPI_QUOTA_EXCEEDED_CODE = 200005;
const DOMAIN_QUERY_TERMS = [
  'PostShot',
  'BSD',
  'Metashape',
  'LichtFeld Studio',
  'LFS',
  'RealityScan',
  'SuperSplat',
  'Spark 2.0',
  '知天下',
  'Quest 3',
  'Insta360',
  'LiDAR',
  'NeRF',
  '4DGS',
  'SfM',
  '空三',
  'LOD',
  'VRAM',
  'Ply',
  'sog',
  'Mesh',
  'Mask',
  '遮罩',
  '无人机',
  '航拍',
  '重叠率',
  '转台',
  '全景相机',
  '微距',
  '点云',
  '球谐函数',
  '高斯点数',
  '显存',
  '压缩',
  '流式加载',
  '空地融合',
  '数字孪生',
  '文物保护',
  '电商展示',
  '游戏开发',
  '透明',
  '反光',
  '玻璃',
  '金属',
  '分块训练',
  '冰雕状',
  '创业',
  '商单',
  '定价',
];
const DOMAIN_QUERY_RULES = [
  [/空三|SfM/i, ['空三 SfM 对齐', 'Metashape 空三 导入']],
  [/无人机|航拍|重叠率/, ['无人机 航拍 重叠率', '空地融合 航拍 地面']],
  [/全景|Insta360/i, ['全景相机 Insta360 训练', '单镜头 双镜头 全景']],
  [/转台/, ['转台 拍摄 背景 遮罩']],
  [/微距|小型物体/, ['微距 小物体 采集']],
  [/显存|VRAM|点数|高斯点数/i, ['显存 VRAM 高斯点数', '降低分辨率 限制高斯点数']],
  [/遮罩|Mask/i, ['遮罩 Mask 动态物体', '自动遮罩 手动遮罩']],
  [/LOD|流式加载/i, ['LOD 流式加载 大场景', '多层次细节 在线浏览']],
  [/知天下/, ['知天下 上传 格式', '知天下 SuperSplat']],
  [/Quest|VR|AR/i, ['Quest 3 VR AR 3DGS']],
  [/透明|反光|玻璃|金属/, ['透明 反光 玻璃 金属 3DGS']],
  [/4DGS|动态/i, ['4DGS 动态场景', '4D 高斯泼溅']],
  [/创业|商单|定价/, ['3DGS 创业 商单 定价']],
];
const {
  buildEvidencePack,
  cleanText,
  normalizeKnowledgeResults,
  truncateText,
} = require('./evidence-pack');

let PDFParse;

class IMAOpenAPIQuotaExceededError extends Error {
  constructor(message = 'IMA OpenAPI 请求超量，请明日再试', options = {}) {
    super(message);
    this.name = 'IMAOpenAPIQuotaExceededError';
    this.code = IMA_OPENAPI_QUOTA_EXCEEDED_CODE;
    this.imaMessage = message;
    this.exceededAt = options.exceededAt || new Date().toISOString();
    this.reason = 'openapi_quota_exceeded';
  }
}

function buildQueryCandidates(question) {
  const cleanedQuestion = cleanText(question);
  const candidates = [];
  const push = (...values) => {
    for (const value of values) {
      const text = cleanText(value);
      if (text && !candidates.includes(text)) {
        candidates.push(text);
      }
    }
  };

  push(cleanedQuestion);

  const asciiTokens = cleanedQuestion.match(/[A-Za-z0-9][A-Za-z0-9._-]{1,}/g) || [];
  push(...asciiTokens);

  const domainTerms = DOMAIN_QUERY_TERMS.filter((term) =>
    cleanedQuestion.toLowerCase().includes(term.toLowerCase()),
  );
  push(...domainTerms);

  if (domainTerms.length >= 2) {
    push(domainTerms.slice(0, 4).join(' '));
  }

  const compactChinese = cleanedQuestion
    .replace(/[是什么吗呢啊呀的了和与及以及关于请问一下这个那个主要包含内容怎么如何哪些有什么？?，,。.！!：:；;、\s]/g, '')
    .trim();
  if (compactChinese.length >= 2) {
    push(compactChinese.slice(0, 24));
  }

  if (/3d|3D|高斯|泼溅|gaussian|splat/i.test(cleanedQuestion)) {
    push('3DGS', '3D高斯泼溅');
  }

  if (/知识库|内容|包含|介绍|入门|怎么用|能做什么|擅长/.test(cleanedQuestion)) {
    push('知识库', '3DGS');
  }

  for (const [pattern, expansions] of DOMAIN_QUERY_RULES) {
    if (pattern.test(cleanedQuestion)) {
      push(...expansions);
    }
  }

  return candidates.slice(0, 8);
}

class IMAClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required');
    }

    this.clientId = config.clientId;
    this.apiKey = config.apiKey;
    this.sharedKnowledgeBaseId = config.sharedKnowledgeBaseId;
    this.fetchImpl = fetchImpl;
    this.maxSources = config.maxSources || 6;
    this.maxSnippetLength = config.maxSnippetLength || 900;
    this.maxSourceContentLength = config.maxSourceContentLength || 1800;
    this.requestTimeoutMs = config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRetries = Number.isInteger(config.maxRetries)
      ? config.maxRetries
      : DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = Number.isInteger(config.retryBaseDelayMs)
      ? config.retryBaseDelayMs
      : DEFAULT_RETRY_BASE_DELAY_MS;
    this.maxEnrichedSources = Number.isInteger(config.maxEnrichedSources)
      ? config.maxEnrichedSources
      : DEFAULT_MAX_ENRICHED_SOURCES;
    this.enrichSnippetThreshold = Number.isInteger(config.enrichSnippetThreshold)
      ? config.enrichSnippetThreshold
      : DEFAULT_ENRICH_SNIPPET_THRESHOLD;
    this.profileCache = null;
    this.quotaCircuit = {
      open: false,
      openedAt: null,
      code: null,
      message: '',
    };
  }

  async _request(path, body) {
    this._assertQuotaAvailable();
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this._requestOnce(path, body);
      } catch (error) {
        if (isOpenAPIQuotaExceededError(error)) {
          this._openQuotaCircuit(error);
          throw this._quotaCircuitError();
        }
        lastError = error;
        if (attempt >= this.maxRetries || !isRetryableIMAError(error)) {
          throw error;
        }
        await sleep(backoffDelay(this.retryBaseDelayMs, attempt));
      }
    }
    throw lastError;
  }

  async _requestOnce(path, body) {
    const response = await this.fetchImpl(`${IMA_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'ima-openapi-clientid': this.clientId,
        'ima-openapi-apikey': this.apiKey,
      },
      body: JSON.stringify(body),
      signal: makeTimeoutSignal(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      throw createIMAHTTPError(response.status, text);
    }

    const result = await response.json();
    if (result.code !== 0) {
      throw createIMABusinessError(result);
    }

    return result.data || {};
  }

  _assertQuotaAvailable() {
    if (this.quotaCircuit.open) {
      throw this._quotaCircuitError();
    }
  }

  _openQuotaCircuit(error) {
    if (this.quotaCircuit.open) {
      return;
    }
    this.quotaCircuit = {
      open: true,
      openedAt: new Date().toISOString(),
      code: IMA_OPENAPI_QUOTA_EXCEEDED_CODE,
      message: error.imaMessage || error.message || 'IMA OpenAPI 请求超量，请明日再试',
    };
  }

  _quotaCircuitError() {
    return new IMAOpenAPIQuotaExceededError(this.quotaCircuit.message, {
      exceededAt: this.quotaCircuit.openedAt || new Date().toISOString(),
    });
  }

  resetQuotaCircuit() {
    this.quotaCircuit = {
      open: false,
      openedAt: null,
      code: null,
      message: '',
    };
  }

  getQuotaStatus() {
    return {
      open: this.quotaCircuit.open,
      openedAt: this.quotaCircuit.openedAt,
      code: this.quotaCircuit.code,
      message: this.quotaCircuit.open ? 'IMA OpenAPI quota exceeded' : '',
    };
  }

  async _searchOnce(query, options = {}) {
    const maxPages = options.maxPages || 2;
    const maxSources = options.maxSources || this.maxSources;
    let cursor = '';
    const infoList = [];

    for (let page = 0; page < maxPages; page += 1) {
      const payload = {
        query,
        cursor,
        knowledge_base_id: this.sharedKnowledgeBaseId,
      };

      const data = await this._request(SEARCH_KNOWLEDGE_PATH, payload);
      infoList.push(...(Array.isArray(data.info_list) ? data.info_list : []));

      if (data.is_end || !data.next_cursor) {
        break;
      }
      cursor = data.next_cursor;
    }

    return normalizeKnowledgeResults(infoList, {
      maxSources,
      maxSnippetLength: this.maxSnippetLength,
    });
  }

  async retrieveEvidencePack(question) {
    const candidates = buildQueryCandidates(question);
    const merged = [];
    const maxCandidatesBeforeEnrichment = this.maxSources * 3;
    let lastSearchError = null;

    for (const candidate of candidates) {
      let results = [];
      try {
        results = await this._searchOnce(candidate, {
          maxSources: this.maxSources * 2,
        });
      } catch (error) {
        if (isOpenAPIQuotaExceededError(error)) {
          throw error;
        }
        lastSearchError = error;
        continue;
      }
      for (const source of results) {
        merged.push({ ...source, matchedQuery: candidate, evidenceType: 'search' });
      }
      if (merged.length >= maxCandidatesBeforeEnrichment) {
        break;
      }
    }

    if (merged.length === 0 && lastSearchError) {
      throw lastSearchError;
    }

    const enriched = [];
    const candidatesToEnrich = merged.slice(0, maxCandidatesBeforeEnrichment);
    for (let index = 0; index < candidatesToEnrich.length; index += 1) {
      const source = candidatesToEnrich[index];
      if (index < this.maxEnrichedSources) {
        enriched.push(await this._enrichSource(source));
      } else {
        enriched.push(source);
      }
    }

    const directPack = buildEvidencePack(enriched, {
      maxSources: this.maxSources,
      maxSnippetLength: this.maxSnippetLength,
      maxSourceContentLength: this.maxSourceContentLength,
    });

    if (directPack.sources.length >= this.maxSources) {
      return directPack;
    }

    const profileSource = await this._getKnowledgeBaseProfileSource();
    if (!profileSource) {
      return directPack;
    }

    return buildEvidencePack(
      [...directPack.evidence, { ...profileSource, evidenceType: 'profile' }],
      {
        maxSources: this.maxSources,
        maxSnippetLength: this.maxSnippetLength,
        maxSourceContentLength: this.maxSourceContentLength,
      },
    );
  }

  async searchKnowledge(question) {
    const evidencePack = await this.retrieveEvidencePack(question);
    return evidencePack.sources;
  }

  async _getKnowledgeBaseProfileSource() {
    if (this.profileCache) {
      return this.profileCache;
    }

    try {
      const baseData = await this._request(GET_KNOWLEDGE_BASE_PATH, {
        ids: [this.sharedKnowledgeBaseId],
      });
      const rootItems = await this._listKnowledge({ limit: 50, maxPages: 2 });

      const info = baseData.infos?.[this.sharedKnowledgeBaseId] || {};
      const knowledgeBaseName = cleanText(
        info.name || info.kb_name || info.knowledge_base_name || info.knowledgeBaseName,
      );
      const rootTitles = rootItems
        .map((item) => cleanText(item.title))
        .filter((title) => title && !looksLikeBinarySource(title, ''));
      const recommendedQuestions = Array.isArray(info.recommended_questions)
        ? info.recommended_questions.map(cleanText).filter(Boolean)
        : [];
      const corpusOverview = await this._buildCorpusOverview(rootItems);

      const snippet = [
        knowledgeBaseName ? `知识库名称：${knowledgeBaseName}` : '',
        info.description ? `描述：${cleanText(info.description)}` : '',
        recommendedQuestions.length
          ? `推荐问题：${recommendedQuestions.join('；')}`
          : '',
        rootTitles.length ? `根目录资料：${rootTitles.slice(0, 12).join('；')}` : '',
        corpusOverview,
      ]
        .filter(Boolean)
        .join('\n');

      this.profileCache = snippet
        ? {
            title: knowledgeBaseName || '共享知识库概览',
            snippet: truncateText(snippet, this.maxSourceContentLength),
          }
        : null;
      return this.profileCache;
    } catch (error) {
      if (isOpenAPIQuotaExceededError(error)) {
        throw error;
      }
      return null;
    }
  }

  async _listKnowledge({ folderId = '', limit = 50, maxPages = 3 } = {}) {
    let cursor = '';
    const items = [];

    for (let page = 0; page < maxPages; page += 1) {
      const body = {
        knowledge_base_id: this.sharedKnowledgeBaseId,
        cursor,
        limit,
      };
      if (folderId) {
        body.folder_id = folderId;
      }

      const data = await this._request(GET_KNOWLEDGE_LIST_PATH, body);
      items.push(...(Array.isArray(data.knowledge_list) ? data.knowledge_list : []));

      if (data.is_end || !data.next_cursor) {
        break;
      }
      cursor = data.next_cursor;
    }

    return items;
  }

  async _buildCorpusOverview(rootItems) {
    const rawFolders = rootItems.filter(
      (item) => item?.media_type === 99 && RAW_FOLDER_TITLE_PATTERN.test(getKnowledgeItemTitle(item)),
    );

    if (rawFolders.length === 0) {
      return '';
    }

    const folderSummaries = [];
    for (const folder of rawFolders.slice(0, 6)) {
      try {
        const items = await this._listKnowledge({
          folderId: folder.media_id,
          limit: 50,
          maxPages: 3,
        });
        const titles = items.map(getKnowledgeItemTitle).filter(Boolean);
        folderSummaries.push({
          title: getKnowledgeItemTitle(folder),
          count: items.length,
          titles: titles.slice(0, 12),
        });
      } catch (error) {
        if (isOpenAPIQuotaExceededError(error)) {
          throw error;
        }
        folderSummaries.push({
          title: getKnowledgeItemTitle(folder),
          count: 0,
          titles: [],
        });
      }
    }

    const total = folderSummaries.reduce((sum, folder) => sum + folder.count, 0);
    const folderLines = folderSummaries.map((folder) => {
      const titleSample = folder.titles.length
        ? `，代表资料：${folder.titles.join('；')}`
        : '';
      return `${folder.title}（已浏览 ${folder.count} 条${titleSample}）`;
    });

    return [
      `共享库资料调度概览：发现 ${rawFolders.length} 个 NotebookLM/raw 群聊资料夹，已浏览 ${total} 条资料标题。`,
      ...folderLines,
      '说明：这些 raw 群聊资料可证明共享库内存在大量相关讨论；若 OpenAPI 未返回原文片段，回答中应区分“资料目录显示”和“片段直接支持”。',
    ].join('\n');
  }

  async _enrichSource(source) {
    if (!source.mediaId || shouldSkipSourceEnrichment(source, this.enrichSnippetThreshold)) {
      return source;
    }

    try {
      const mediaInfo = await this._request(GET_MEDIA_INFO_PATH, { media_id: source.mediaId });
      if (mediaInfo.media_type === 11 && mediaInfo.notebook_ext_info?.notebook_id) {
        const note = await this._request(GET_DOC_CONTENT_PATH, {
          note_id: mediaInfo.notebook_ext_info.notebook_id,
          target_content_format: 0,
        });
        const content = truncateText(cleanText(note.content), this.maxSourceContentLength);
        return mergeEnrichedSource(source, content, this.maxSourceContentLength);
      }

      if (mediaInfo.url_info?.url && /^https?:\/\//i.test(mediaInfo.url_info.url)) {
        if (looksLikePdfSource(source.title, mediaInfo.url_info.url)) {
          const content = await this._fetchReadablePdf(mediaInfo.url_info);
          if (content) {
            return mergeEnrichedSource(source, content, this.maxSourceContentLength);
          }
          return source;
        }

        if (!looksLikeBinarySource(source.title, mediaInfo.url_info.url)) {
          const content = await this._fetchReadableUrl(mediaInfo.url_info);
          if (content) {
            return mergeEnrichedSource(source, content, this.maxSourceContentLength);
          }
        }
      }
    } catch (error) {
      if (isOpenAPIQuotaExceededError(error)) {
        throw error;
      }
      return source;
    }

    return source;
  }

  async _fetchReadableUrl(urlInfo) {
    const response = await this.fetchImpl(urlInfo.url, {
      method: 'GET',
      headers: urlInfo.headers || {},
      signal: makeTimeoutSignal(5000),
    });

    if (!response.ok) {
      return '';
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/text|json|markdown|html|xml/i.test(contentType)) {
      return '';
    }

    const text = await response.text();
    return truncateText(cleanText(text), this.maxSourceContentLength);
  }

  async _fetchReadablePdf(urlInfo) {
    const response = await this.fetchImpl(urlInfo.url, {
      method: 'GET',
      headers: urlInfo.headers || {},
      signal: makeTimeoutSignal(8000),
    });

    if (!response.ok) {
      return '';
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/pdf/i.test(contentType) && !looksLikePdfSource('', urlInfo.url)) {
      return '';
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
      return '';
    }

    try {
      PDFParse = PDFParse || require('pdf-parse').PDFParse;
      const parser = new PDFParse({ data: bytes });
      const result = await parser.getText({ partial: [1, 2, 3, 4, 5] });
      await parser.destroy();
      return truncateText(cleanText(result.text), this.maxSourceContentLength);
    } catch {
      return '';
    }
  }
}

function makeTimeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(ms)
    : undefined;
}

function createIMAHTTPError(status, text) {
  const error = new Error(`IMA API returned HTTP ${status}: ${String(text || '').slice(0, 200)}`);
  error.status = status;
  try {
    const parsed = JSON.parse(text);
    error.code = parsed.code;
    error.imaMessage = parsed.msg;
  } catch {
    error.imaMessage = text;
  }
  return error;
}

function createIMABusinessError(result) {
  if (Number(result.code) === IMA_OPENAPI_QUOTA_EXCEEDED_CODE || /请求超量|明日再试/.test(String(result.msg || ''))) {
    return new IMAOpenAPIQuotaExceededError(result.msg || 'IMA OpenAPI 请求超量，请明日再试');
  }
  const error = new Error(result.msg || `IMA API returned code ${result.code}`);
  error.code = result.code;
  error.imaMessage = result.msg;
  return error;
}

function isOpenAPIQuotaExceededError(error) {
  if (!error) {
    return false;
  }
  return (
    error instanceof IMAOpenAPIQuotaExceededError ||
    Number(error.code) === IMA_OPENAPI_QUOTA_EXCEEDED_CODE ||
    /请求超量|明日再试/.test(`${error.message || ''} ${error.imaMessage || ''}`)
  );
}

function isRetryableIMAError(error) {
  if (!error) {
    return false;
  }
  if (isOpenAPIQuotaExceededError(error)) {
    return false;
  }
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }
  if (error.status === 429 || error.status === 408 || error.status >= 500) {
    return true;
  }
  const message = `${error.message || ''} ${error.imaMessage || ''}`;
  return error.code === 200001 || /频率|超限|稍后重试|timeout|timed out/i.test(message);
}

function backoffDelay(baseDelayMs, attempt) {
  if (!baseDelayMs) {
    return 0;
  }
  return Math.min(baseDelayMs * 2 ** attempt, baseDelayMs * 8);
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function shouldSkipSourceEnrichment(source, threshold) {
  const snippetLength = cleanText(source.snippet).length;
  return snippetLength > 0 && snippetLength >= threshold;
}

function mergeEnrichedSource(source, content, maxLength) {
  const snippet = cleanText(source.snippet);
  const enriched = cleanText(content);
  if (!enriched) {
    return source;
  }
  if (!snippet || enriched.includes(snippet)) {
    return { ...source, snippet: truncateText(enriched, maxLength), evidenceType: 'enriched' };
  }
  if (snippet.includes(enriched)) {
    return { ...source, snippet: truncateText(snippet, maxLength), evidenceType: 'enriched' };
  }
  return {
    ...source,
    snippet: truncateText(`${snippet}\n${enriched}`, maxLength),
    evidenceType: 'enriched',
  };
}

function getKnowledgeItemTitle(item) {
  return cleanText(item?.title || item?.name || item?.media_title || item?.file_name || item?.kb_name);
}

function looksLikeBinarySource(title, url) {
  return /\.(pdf|docx?|pptx?|xlsx?|zip|png|jpe?g|webp|gif|mp3|m4a|wav|aac)(\s|\?|#|$)/i.test(
    `${title || ''} ${url || ''}`,
  );
}

function looksLikePdfSource(title, url) {
  return /\.pdf(\s|\?|#|$)/i.test(`${title || ''} ${url || ''}`);
}

module.exports = {
  buildQueryCandidates,
  buildEvidencePack,
  IMAOpenAPIQuotaExceededError,
  IMA_OPENAPI_QUOTA_EXCEEDED_CODE,
  IMAClient,
  isOpenAPIQuotaExceededError,
  looksLikePdfSource,
  looksLikeBinarySource,
  normalizeKnowledgeResults,
};
