const IMA_BASE_URL = 'https://ima.qq.com';
const SEARCH_KNOWLEDGE_PATH = '/openapi/wiki/v1/search_knowledge';
const GET_KNOWLEDGE_BASE_PATH = '/openapi/wiki/v1/get_knowledge_base';
const GET_KNOWLEDGE_LIST_PATH = '/openapi/wiki/v1/get_knowledge_list';
const GET_MEDIA_INFO_PATH = '/openapi/wiki/v1/get_media_info';
const GET_DOC_CONTENT_PATH = '/openapi/note/v1/get_doc_content';
const RAW_FOLDER_TITLE_PATTERN = /NotebookLM|raw|群聊|group/i;

let PDFParse;

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function buildQueryCandidates(question) {
  const cleanedQuestion = cleanText(question);
  const candidates = [cleanedQuestion];

  const asciiTokens = cleanedQuestion.match(/[A-Za-z0-9][A-Za-z0-9._-]{1,}/g) || [];
  candidates.push(...asciiTokens);

  const compactChinese = cleanedQuestion
    .replace(/[是什么吗呢啊呀的了和与及以及关于请问一下这个那个主要包含内容怎么如何哪些有什么？?，,。.！!：:；;、\s]/g, '')
    .trim();
  if (compactChinese.length >= 2) {
    candidates.push(compactChinese.slice(0, 18));
  }

  if (/3d|3D|高斯|泼溅|gaussian|splat/i.test(cleanedQuestion)) {
    candidates.push('3DGS', '3D高斯泼溅');
  }

  if (/知识库|内容|包含|介绍|入门|怎么用|能做什么|擅长/.test(cleanedQuestion)) {
    candidates.push('知识库', '3DGS');
  }

  return [...new Set(candidates.filter(Boolean))].slice(0, 6);
}

function normalizeKnowledgeResults(infoList, options = {}) {
  const maxSources = options.maxSources || 6;
  const maxSnippetLength = options.maxSnippetLength || 900;

  if (!Array.isArray(infoList)) {
    return [];
  }

  const seen = new Set();
  const sources = [];

  for (const item of infoList) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const title = cleanText(item.title) || '未命名资料';
    const snippet = truncateText(cleanText(item.highlight_content), maxSnippetLength);
    const dedupeKey = cleanText(item.media_id) || title;

    if (!dedupeKey || seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    sources.push({
      index: sources.length + 1,
      mediaId: cleanText(item.media_id),
      title,
      snippet,
    });

    if (sources.length >= maxSources) {
      break;
    }
  }

  return sources;
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
    this.profileCache = null;
  }

  async _request(path, body) {
    const response = await this.fetchImpl(`${IMA_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'ima-openapi-clientid': this.clientId,
        'ima-openapi-apikey': this.apiKey,
      },
      body: JSON.stringify(body),
      signal: makeTimeoutSignal(8000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`IMA API returned HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const result = await response.json();
    if (result.code !== 0) {
      throw new Error(result.msg || `IMA API returned code ${result.code}`);
    }

    return result.data || {};
  }

  async _searchOnce(query, options = {}) {
    const maxPages = options.maxPages || 2;
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
      maxSources: this.maxSources,
      maxSnippetLength: this.maxSnippetLength,
    });
  }

  async searchKnowledge(question) {
    const candidates = buildQueryCandidates(question);
    const merged = [];
    const seen = new Set();

    for (const candidate of candidates) {
      const results = await this._searchOnce(candidate);
      for (const source of results) {
        const key = source.mediaId || source.title;
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        merged.push({ ...source, matchedQuery: candidate });
        if (merged.length >= this.maxSources) {
          break;
        }
      }
      if (merged.length >= this.maxSources) {
        break;
      }
    }

    const enriched = [];
    for (const source of merged) {
      enriched.push(await this._enrichSource(source));
    }

    const groundedSources = enriched
      .filter((source) => source.snippet)
      .map((source, index) => sanitizePublicSource({ ...source, index: index + 1 }));

    if (groundedSources.length > 0) {
      return this._appendProfileSource(groundedSources);
    }

    const profileSource = await this._getKnowledgeBaseProfileSource();
    return profileSource ? [{ ...profileSource, index: 1 }] : [];
  }

  async _appendProfileSource(sources) {
    if (sources.length >= this.maxSources) {
      return sources;
    }

    const profileSource = await this._getKnowledgeBaseProfileSource();
    if (!profileSource) {
      return sources;
    }

    const profileKey = profileSource.title;
    const alreadyIncluded = sources.some((source) => source.title === profileKey);
    if (alreadyIncluded) {
      return sources;
    }

    return [...sources, { ...profileSource, index: sources.length + 1 }];
  }

  async _getKnowledgeBaseProfileSource() {
    if (this.profileCache) {
      return this.profileCache;
    }

    try {
      const [baseData, rootItems] = await Promise.all([
        this._request(GET_KNOWLEDGE_BASE_PATH, { ids: [this.sharedKnowledgeBaseId] }),
        this._listKnowledge({ limit: 50, maxPages: 2 }),
      ]);

      const info = baseData.infos?.[this.sharedKnowledgeBaseId] || {};
      const rootTitles = rootItems
        .map((item) => cleanText(item.title))
        .filter((title) => title && !looksLikeBinarySource(title, ''));
      const recommendedQuestions = Array.isArray(info.recommended_questions)
        ? info.recommended_questions.map(cleanText).filter(Boolean)
        : [];
      const corpusOverview = await this._buildCorpusOverview(rootItems);

      const snippet = [
        info.name ? `知识库名称：${cleanText(info.name)}` : '',
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
            title: cleanText(info.name) || '共享知识库概览',
            snippet: truncateText(snippet, this.maxSourceContentLength),
          }
        : null;
      return this.profileCache;
    } catch {
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
      (item) => item?.media_type === 99 && RAW_FOLDER_TITLE_PATTERN.test(cleanText(item.title)),
    );

    if (rawFolders.length === 0) {
      return '';
    }

    const folderSummaries = await Promise.all(
      rawFolders.slice(0, 6).map(async (folder) => {
        try {
          const items = await this._listKnowledge({
            folderId: folder.media_id,
            limit: 50,
            maxPages: 3,
          });
          const titles = items.map((item) => cleanText(item.title)).filter(Boolean);
          return {
            title: cleanText(folder.title),
            count: items.length,
            titles: titles.slice(0, 12),
          };
        } catch {
          return {
            title: cleanText(folder.title),
            count: 0,
            titles: [],
          };
        }
      }),
    );

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
    if (source.snippet || !source.mediaId) {
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
        return { ...source, snippet: content };
      }

      if (mediaInfo.url_info?.url && /^https?:\/\//i.test(mediaInfo.url_info.url)) {
        if (looksLikePdfSource(source.title, mediaInfo.url_info.url)) {
          const content = await this._fetchReadablePdf(mediaInfo.url_info);
          if (content) {
            return { ...source, snippet: content };
          }
          return source;
        }

        if (!looksLikeBinarySource(source.title, mediaInfo.url_info.url)) {
          const content = await this._fetchReadableUrl(mediaInfo.url_info);
          if (content) {
            return { ...source, snippet: content };
          }
        }
      }
    } catch {
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

function looksLikeBinarySource(title, url) {
  return /\.(pdf|docx?|pptx?|xlsx?|zip|png|jpe?g|webp|gif|mp3|m4a|wav|aac)(\s|\?|#|$)/i.test(
    `${title || ''} ${url || ''}`,
  );
}

function looksLikePdfSource(title, url) {
  return /\.pdf(\s|\?|#|$)/i.test(`${title || ''} ${url || ''}`);
}

function sanitizePublicSource(source) {
  return {
    index: source.index,
    title: source.title,
    snippet: source.snippet,
  };
}

module.exports = {
  buildQueryCandidates,
  IMAClient,
  looksLikePdfSource,
  looksLikeBinarySource,
  normalizeKnowledgeResults,
};
