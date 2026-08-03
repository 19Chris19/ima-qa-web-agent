function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  if (!maxLength || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
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

    const mediaId = extractMediaId(item);
    const title = extractTitle(item);
    const snippet = truncateText(extractSnippet(item), maxSnippetLength);
    const dedupeKey = [mediaId || title, snippet || extractPositionKey(item)].filter(Boolean).join('\n');

    if (!dedupeKey || seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    sources.push({
      index: sources.length + 1,
      mediaId,
      title,
      snippet,
    });

    if (sources.length >= maxSources) {
      break;
    }
  }

  return sources;
}

function buildEvidencePack(candidates, options = {}) {
  const maxSources = options.maxSources || 6;
  const maxSnippetLength = options.maxSnippetLength || 900;
  const maxEvidenceLength = options.maxEvidenceLength || options.maxSourceContentLength || 1800;
  const merged = [];
  const seen = new Map();
  let candidateCount = 0;

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const source = normalizeEvidenceCandidate(candidate, {
      maxSnippetLength: Math.max(maxSnippetLength, maxEvidenceLength),
    });
    if (!source) {
      continue;
    }
    candidateCount += 1;

    const dedupeKey = source.mediaId || source.title;
    const existing = seen.get(dedupeKey);
    if (existing) {
      existing.snippet = mergeSnippet(existing.snippet, source.snippet, maxEvidenceLength);
      for (const query of source.matchedQueries) {
        if (!existing.matchedQueries.includes(query)) {
          existing.matchedQueries.push(query);
        }
      }
      if (source.evidenceType === 'profile') {
        existing.evidenceType = mergeEvidenceType(existing.evidenceType, source.evidenceType);
      } else if (source.evidenceType === 'enriched') {
        existing.evidenceType = mergeEvidenceType(existing.evidenceType, source.evidenceType);
      }
      continue;
    }

    const evidence = {
      mediaId: source.mediaId,
      title: source.title,
      snippet: truncateText(source.snippet, maxEvidenceLength),
      matchedQueries: source.matchedQueries,
      evidenceType: source.evidenceType || 'search',
    };
    seen.set(dedupeKey, evidence);
    merged.push(evidence);
  }

  const evidence = merged
    .filter((source) => source.snippet)
    .slice(0, maxSources)
    .map((source, index) => ({ ...source, index: index + 1 }));

  return {
    evidence,
    sources: evidence.map(sanitizePublicSource),
    diagnostics: {
      candidateCount,
      sourceCount: evidence.length,
      profileIncluded: evidence.some((source) => source.evidenceType === 'profile'),
      queryVariantCount: [
        ...new Set(evidence.flatMap((source) => source.matchedQueries).filter(Boolean)),
      ].length,
      enrichedSourceCount: evidence.filter((source) => source.evidenceType === 'enriched').length,
      evidenceTypes: countEvidenceTypes(evidence),
      matchedQueries: [
        ...new Set(evidence.flatMap((source) => source.matchedQueries).filter(Boolean)),
      ],
    },
  };
}

function normalizeEvidenceCandidate(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const title = extractTitle(candidate);
  const snippet = truncateText(extractSnippet(candidate), options.maxSnippetLength || 900);
  const mediaId = extractMediaId(candidate);
  if (!title && !mediaId && !snippet) {
    return null;
  }

  return {
    mediaId,
    title,
    snippet,
    matchedQueries: normalizeMatchedQueries(candidate),
    evidenceType: cleanText(candidate.evidenceType),
  };
}

function normalizeMatchedQueries(candidate) {
  const queries = [];
  if (Array.isArray(candidate.matchedQueries)) {
    queries.push(...candidate.matchedQueries);
  }
  if (candidate.matchedQuery) {
    queries.push(candidate.matchedQuery);
  }
  return [...new Set(queries.map(cleanText).filter(Boolean))];
}

function extractMediaId(value) {
  return firstCleanValue(
    value?.mediaId,
    value?.media_id,
    value?.doc_id,
    value?.document_id,
    value?.file_id,
    value?.id,
    value?.media?.media_id,
    value?.media_info?.media_id,
  );
}

function extractTitle(value) {
  return (
    firstCleanValue(
      value?.title,
      value?.name,
      value?.media_title,
      value?.mediaName,
      value?.file_name,
      value?.filename,
      value?.document_name,
      value?.doc_name,
      value?.folder_name,
      value?.kb_name,
      value?.knowledge_base_name,
      value?.media?.title,
      value?.media?.name,
      value?.media_info?.title,
      value?.media_info?.name,
      value?.url_info?.title,
    ) || '未命名资料'
  );
}

function extractSnippet(value) {
  return firstCleanValue(
    value?.snippet,
    value?.highlight_content,
    value?.highlightContent,
    value?.summary,
    value?.description,
    value?.desc,
    value?.abstract,
    value?.content,
    value?.text,
    value?.plain_text,
    value?.markdown,
    value?.chunk_content,
    value?.chunkContent,
    value?.body,
    value?.answer,
    value?.media?.summary,
    value?.media?.description,
    value?.media_info?.summary,
    value?.media_info?.description,
  );
}

function firstCleanValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const text = value.map(cleanText).filter(Boolean).join('\n');
      if (text) {
        return text;
      }
      continue;
    }
    const text = cleanText(value);
    if (text) {
      return text;
    }
  }
  return '';
}

function extractPositionKey(value) {
  return firstCleanValue(
    value?.chunk_id,
    value?.chunkId,
    value?.offset,
    value?.start_offset,
    value?.end_offset,
    value?.position,
    value?.page,
  );
}

function mergeSnippet(current, next, maxLength) {
  const left = cleanText(current);
  const right = cleanText(next);
  if (!right || left.includes(right)) {
    return truncateText(left, maxLength);
  }
  if (!left) {
    return truncateText(right, maxLength);
  }
  return truncateText(`${left}\n${right}`, maxLength);
}

function mergeEvidenceType(current, next) {
  const left = cleanText(current) || 'search';
  const right = cleanText(next) || 'search';
  if (left === 'profile' || right === 'profile') {
    return 'profile';
  }
  if (left === 'enriched' || right === 'enriched') {
    return 'enriched';
  }
  return left;
}

function countEvidenceTypes(evidence) {
  return evidence.reduce((counts, source) => {
    const type = cleanText(source.evidenceType) || 'search';
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
}

function sanitizePublicSource(source) {
  return {
    index: source.index,
    title: source.title,
    snippet: source.snippet,
  };
}

module.exports = {
  buildEvidencePack,
  cleanText,
  normalizeKnowledgeResults,
  sanitizePublicSource,
  truncateText,
};
