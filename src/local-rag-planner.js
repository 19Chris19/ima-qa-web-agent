const { cleanText } = require('./evidence-pack');

const DEFAULT_QUERY_LIMIT = 12;

const DOMAIN_TERMS = {
  capture: [
    '重叠率',
    '重叠度',
    '重合率',
    'overlap',
    '航向重叠',
    '旁向重叠',
    '飞行高度',
    '航线',
    '视角多样性',
    '多高度环绕',
    '照片数量',
  ],
  training: [
    '显存',
    'VRAM',
    '高斯点数',
    '迭代',
    'loss',
    'NaN',
    '空三',
    'SfM',
    'mask',
    '遮罩',
    'LOD',
    '分块训练',
  ],
  tools: [
    'PostShot',
    'BSD',
    'LichtFeld Studio',
    'LFS',
    'Metashape',
    'RealityScan',
    'SuperSplat',
    '知天下',
    'Spark',
  ],
  counter: ['失败', '空洞', '重影', '断裂', '组件', '爆显存', '模糊', '卡顿', '接缝', '冰雕状'],
};

const FOCUS_HINT_PATTERNS = {
  mesh_printing: /Kiri|高斯转\s*mesh|网格化|可打印|3D打印|打印机|球谐函数|颜色不正确/i,
  material_reflection: /透明|反光|玻璃|金属|高光|材质|交叉偏振|偏振镜|灰扑扑|展柜|噪点/i,
  four_d: /4DGS|4D高斯|时间维度|动态场景|人体|演唱会|舞台|子弹时间|摄像机阵列/i,
  large_scene: /巨型|大场景|园区|城市街区|空地融合|无人机.{0,12}地面|地面.{0,12}无人机|分块训练|分批训练|LOD|流式加载|数千张|十万张/i,
  opacity_color: /不透明度|opacity|颜色|color|密度|density|致密化|边缘|渲染精度|高斯点数量|过滤掉无效的高斯点/i,
  software_io: /Metashape|PostShot|BSD|导入|空三|数据导入|高斯训练|ply|COLMAP|sparse|cameras|images/i,
  panorama_training: /全景|单镜头|双镜头|Insta360|拼接|抽帧|鱼眼|画质|像素质量|涂抹/i,
};

function planLocalRagQuery(question, options = {}) {
  const text = cleanText(question);
  const plannerType = classifyQuestion(text);
  const queryLimit = options.queryLimit || DEFAULT_QUERY_LIMIT;
  const queries = [];
  const push = (...values) => {
    for (const value of values) {
      const query = cleanText(value);
      if (query && !queries.includes(query)) {
        queries.push(query);
      }
    }
  };

  push(text);

  if (plannerType === 'parameter_setting') {
    push(
      `${text} 阈值 范围 参数`,
      `${text} 成功案例`,
      `${text} 失败 边界 反例`,
    );
  }
  if (plannerType === 'troubleshooting') {
    push(
      `${text} 原因 解决方法`,
      `${text} 失败案例 排查`,
      `${text} 参数 采集 数据质量`,
    );
  }
  if (plannerType === 'tool_comparison') {
    push(
      `${text} 优缺点 差异`,
      `${text} 格式 性能 限制`,
      `${text} 用户案例`,
    );
  }
  if (plannerType === 'application_solution') {
    push(
      `${text} 场景 流程 设备`,
      `${text} 成本 交付 限制`,
      `${text} 案例 方案`,
    );
  }
  if (plannerType === 'concept_explanation') {
    push(
      `${text} 定义 原理`,
      `${text} 流程 应用`,
      `${text} 边界 误解`,
    );
  }

  addDomainExpansions(text, push);

  return {
    plannerType,
    queries: queries.slice(0, queryLimit),
    domainHints: collectDomainHints(text),
    focusHints: collectFocusHints(text),
  };
}

function classifyQuestion(text) {
  if (/重叠率|重叠度|重合率|overlap|参数|设置|阈值|多少|范围|比例|飞行路径|航线|调整|不透明度|opacity|颜色|color|密度|density|致密化/i.test(text)) {
    return 'parameter_setting';
  }
  if (/失败|报错|错误|NaN|发散|空洞|噪点|爆显存|卡顿|模糊|接缝|冰雕|排查|解决|怎么办/.test(text)) {
    return 'troubleshooting';
  }
  if (/对比|区别|差异|优缺点|哪个|推荐|PostShot|BSD|LFS|Metashape|RealityScan|SuperSplat|知天下|Spark/i.test(text)) {
    return 'tool_comparison';
  }
  if (/应用|场景|方案|工作流|创业|商单|定价|网站|小程序|VR|AR|数字孪生|文物|电商|游戏|转换|网格|Mesh|3D打印|打印|透明|反光|玻璃|金属|巨型|园区|城市街区|大场景|4DGS|4D高斯/i.test(text)) {
    return 'application_solution';
  }
  return 'concept_explanation';
}

function addDomainExpansions(text, push) {
  if (/无人机|航拍|重叠率|重叠度|重合率|overlap|飞行路径|航线/.test(text)) {
    push(
      '无人机航拍 3DGS 重叠率',
      '重叠率 重叠度 重合率 overlap',
      '航向重叠 旁向重叠 怎么设置',
      '3DGS 航拍 采集参数 航线 飞行高度',
      '无人机 拍摄 重叠度 航向 旁向',
      '3DGS 重建失败 重影 空洞 数据质量',
      '视角多样性 多高度环绕 照片数量 显存',
    );
  }
  if (/PostShot|BSD|LichtFeld|LFS|RealityScan|软件|训练速度|显存占用|效果|渲染平台|ply/i.test(text)) {
    push(
      'PostShot BSD 对比 细节 效果',
      'PostShot BSD LichtFeld LFS RealityScan 训练速度 显存',
      'PostShot BSD ply SuperSplat 知天下 渲染差异',
      '软件 对比 效果 画质 色彩 错误 splat',
    );
  }
  if (/显存|VRAM|高斯点数|点数|迭代|训练/.test(text)) {
    push(
      '显存 VRAM 高斯点数',
      '降低分辨率 限制高斯点数',
      '训练参数 迭代 最大高斯点数',
      '爆显存 失败案例 解决方法',
      '空三准确度 高斯点数 分辨率 迭代次数 优先级',
    );
  }
  if (/Metashape|PostShot|BSD|导入|空三|数据转换/i.test(text)) {
    push('Metashape 空三 导入 PostShot BSD', 'BSD Studio 数据导入 空三 高斯训练', 'ply colmap cameras images sparse 导入');
  }
  if (/遮罩|mask/i.test(text)) {
    push('遮罩 Mask 动态物体', '自动遮罩 手动遮罩 背景干扰');
  }
  if (/LOD|流式|加载/.test(text)) {
    push('LOD 流式加载 大场景', '多层次细节 在线浏览 优化');
  }
  if (/Mesh|网格|3D打印|打印|转换/i.test(text)) {
    push('高斯转mesh Kiri 3D打印', '网格化 可打印 高斯模型', '高斯 球谐函数 颜色 3D打印');
  }
  if (/透明|反光|玻璃|金属|高光|材质/i.test(text)) {
    push('透明 反光 玻璃 金属 3DGS', '交叉偏振镜 反光 材质 高光', '玻璃 展柜 噪点 SuperSplat 删除');
  }
  if (/4DGS|4D高斯|动态|演唱会|人体|舞台/i.test(text)) {
    push('4DGS 时间维度 动态场景', '4D 高斯 人体 演唱会 舞台', '动态高斯 子弹时间 摄像机阵列');
  }
  if (/巨型|园区|城市街区|大场景|空地融合|专业级/i.test(text)) {
    push('大场景 园区 城市街区 空地融合', '无人机 地面照片 空地融合 对齐', '分块训练 LOD 流式加载 大场景', '数千张 分批训练 BSD 分块');
  }
  if (/不透明度|opacity|颜色|color|密度|density|致密化|边缘|渲染质量/i.test(text)) {
    push('不透明度 opacity 颜色 color 密度 density', '高斯点 边缘 渲染精度 致密化', 'SuperSplat 不透明度 颜色 高斯点');
  }
  if (/知天下|SuperSplat|Spark|LichtFeld|LFS|PostShot|BSD|Metashape|RealityScan/i.test(text)) {
    push(...DOMAIN_TERMS.tools.filter((term) => text.toLowerCase().includes(term.toLowerCase())));
  }
}

function collectDomainHints(text) {
  return Object.fromEntries(
    Object.entries(DOMAIN_TERMS).map(([group, terms]) => [
      group,
      terms.filter((term) => text.toLowerCase().includes(term.toLowerCase())),
    ]),
  );
}

function collectFocusHints(text) {
  const hints = [];
  const push = (hint) => {
    if (!hints.includes(hint)) {
      hints.push(hint);
    }
  };

  if (/PostShot|BSD|LichtFeld|LFS|RealityScan|软件|训练速度|显存占用|渲染平台|ply/i.test(text)) {
    push('tool_comparison');
  }
  if (/Mesh|网格|3D打印|打印|Kiri|转换/i.test(text)) {
    push('mesh_printing');
  }
  if (/透明|反光|玻璃|金属|高光|材质|偏振/i.test(text)) {
    push('material_reflection');
  }
  if (/4DGS|4D高斯|动态|演唱会|人体|舞台|时间维度/i.test(text)) {
    push('four_d');
  }
  if (/巨型|园区|城市街区|大场景|空地融合|专业级|分块|LOD|流式/i.test(text)) {
    push('large_scene');
  }
  if (/不透明度|opacity|颜色|color|密度|density|致密化|边缘|渲染质量/i.test(text)) {
    push('opacity_color');
  }
  if (/Metashape|PostShot|BSD|导入|空三|数据转换/i.test(text)) {
    push('software_io');
  }
  if (/全景|单镜头|双镜头|Insta360|拼接|抽帧|鱼眼/i.test(text)) {
    push('panorama_training');
  }
  return hints;
}

function extractSecondPassTerms(candidates, plan, options = {}) {
  const text = candidates
    .slice(0, options.maxSeedCandidates || 24)
    .map((candidate) => `${candidate.title || ''} ${candidate.snippet || ''}`)
    .join('\n');
  const terms = [];
  const push = (...values) => {
    for (const value of values) {
      const term = cleanText(value);
      if (term && !terms.includes(term)) {
        terms.push(term);
      }
    }
  };

  for (const term of [
    ...DOMAIN_TERMS.capture,
    ...DOMAIN_TERMS.training,
    ...DOMAIN_TERMS.tools,
    ...DOMAIN_TERMS.counter,
    '80%',
    '70%',
    '75%',
    '85%',
    '60%',
    '1500张',
    '2000张',
  ]) {
    if (text.toLowerCase().includes(term.toLowerCase())) {
      push(term);
    }
  }

  if (plan?.plannerType === 'parameter_setting') {
    push('成功案例', '失败边界', '反例观点', '视角多样性');
  }
  if (plan?.plannerType === 'troubleshooting') {
    push('原因', '解决方法', '失败案例');
  }

  return terms.slice(0, options.maxTerms || 8);
}

function buildSecondPassQueries(question, terms, plan, options = {}) {
  const queries = [];
  const push = (...values) => {
    for (const value of values) {
      const query = cleanText(value);
      if (query && !queries.includes(query)) {
        queries.push(query);
      }
    }
  };

  const base = cleanText(question);
  for (const term of terms) {
    push(`${base} ${term}`);
  }
  if (plan?.plannerType === 'parameter_setting') {
    push(`${base} 阈值 下限 上限`, `${base} 成功 失败 边界`, `${base} 反例 观点`);
  }

  return queries.slice(0, options.maxQueries || 8);
}

function disambiguateCandidates(question, candidates) {
  const text = cleanText(question);
  const kept = [];
  const discarded = [];
  for (const candidate of candidates) {
    if (isAmbiguousOverlapHit(text, candidate)) {
      discarded.push({ ...candidate, discardReason: 'ambiguous_overlap' });
      continue;
    }
    kept.push(candidate);
  }
  return { kept, discarded };
}

function isAmbiguousOverlapHit(question, candidate) {
  if (!/航拍|无人机|重叠率|重叠度|重合率|overlap|航向|旁向/.test(question)) {
    return false;
  }
  const text = `${candidate.title || ''} ${candidate.snippet || ''}`;
  if (!/重叠|overlap/i.test(text)) {
    return false;
  }
  if (/航拍|无人机|航线|航向|旁向|飞行|高度|照片|采集|SfM|空三|3DGS|高斯|重建|视角/.test(text)) {
    return false;
  }
  return /网格|重叠面|画面重叠|图像重叠|雷达|UI|界面|按钮|贴图|材质/.test(text);
}

function selectCoverageCandidates(candidates, plan, options = {}) {
  const maxSources = options.maxSources || 18;
  const selected = [];
  const selectedIds = new Set();
  const coverage = createCoverage();

  const sorted = [...candidates].sort((a, b) => scoreCoveragePriority(b, plan) - scoreCoveragePriority(a, plan));
  const bucketPredicates = coveragePredicates(plan);
  for (const predicate of bucketPredicates) {
    const candidate = sorted.find((item) => !selectedIds.has(item.id) && predicate(item));
    if (candidate) {
      addSelected(candidate);
    }
  }
  for (const candidate of sorted) {
    if (selected.length >= maxSources) {
      break;
    }
    if (selectedIds.has(candidate.id)) {
      continue;
    }
    if (tooManyFromSameDayGroup(selected, candidate)) {
      continue;
    }
    addSelected(candidate);
  }

  for (const candidate of selected) {
    updateCoverage(coverage, candidate);
  }

  return { selected, coverage };

  function addSelected(candidate) {
    selected.push(candidate);
    selectedIds.add(candidate.id);
  }
}

function coveragePredicates(plan) {
  return [
    (candidate) => plan?.plannerType === 'parameter_setting' && hasStrongParameterThreshold(candidate),
    (candidate) => hasFocusHintEvidence(candidate, plan),
    (candidate) => hasDirectAnswer(candidate),
    (candidate) => hasSuccessCase(candidate),
    (candidate) => hasFailureBoundary(candidate),
    (candidate) => hasCounterpoint(candidate),
    (candidate) => plan?.plannerType === 'parameter_setting' && /阈值|范围|参数|%|下限|上限|多少/.test(candidate.snippet || ''),
  ];
}

function scoreCoveragePriority(candidate, plan) {
  const snippet = candidate.snippet || '';
  let score = candidate.score || 0;

  if (plan?.plannerType === 'parameter_setting') {
    if (hasStrongParameterThreshold(candidate)) {
      score += 40;
    }
    if (/75\s*[-~—–至到]\s*85|75\s*%|75％|85\s*%|85％/.test(snippet)) {
      score += 16;
    }
    if (/60\s*%?.{0,16}(下限|再低|对不上|失败)|下限.{0,16}60/.test(snippet)) {
      score += 14;
    }
    if (/GSD|分辨率|飞行高度|航线/.test(snippet)) {
      score += 6;
    }
    if (/视角多样性|多高度|环绕|多角度/.test(snippet)) {
      score += 10;
    }
    if (/照片数|照片数量|张|显存|VRAM|爆显存/.test(snippet)) {
      score += 6;
    }
  }
  score += scoreFocusHintPriority(candidate, plan);

  if (isNoisyShareCandidate(candidate)) {
    score -= 12;
  }
  return score;
}

function scoreFocusHintPriority(candidate, plan) {
  let score = 0;
  const snippet = candidate.snippet || '';
  const hints = Array.isArray(plan?.focusHints) ? plan.focusHints : [];

  if (hints.includes('tool_comparison')) {
    const toolCount = countRegexMatches(snippet, /PostShot|BSD|LichtFeld|LFS|RealityScan|SuperSplat|知天下/gi);
    if (toolCount >= 2) {
      score += 30;
    } else if (toolCount >= 1) {
      score += 10;
    }
    if (/对比|差异|细节最好|错误\s*splat|效果|画质|色彩|速度|显存|训练|渲染平台/.test(snippet)) {
      score += 14;
    }
  }

  for (const [hint, pattern] of Object.entries(FOCUS_HINT_PATTERNS)) {
    if (hints.includes(hint) && pattern.test(snippet)) {
      score += 70;
    }
  }
  return score;
}

function hasFocusHintEvidence(candidate, plan) {
  return scoreFocusHintPriority(candidate, plan) >= 24;
}

function countRegexMatches(text, pattern) {
  return (String(text || '').match(pattern) || []).length;
}

function hasStrongParameterThreshold(candidate) {
  const snippet = candidate.snippet || '';
  return (
    /航向.{0,24}(80\s*%|80％|≥\s*80|>=\s*80)|(80\s*%|80％|≥\s*80|>=\s*80).{0,24}航向/.test(snippet)
    || /旁向.{0,24}(70\s*%|70％|≥\s*70|>=\s*70)|(70\s*%|70％|≥\s*70|>=\s*70).{0,24}旁向/.test(snippet)
  );
}

function isNoisyShareCandidate(candidate) {
  return /【ima知识库】|群聊知识AI答疑|卡片解析|mp\.weixin\.qq\.com|\[音乐\]|IMA知识库|腾讯ima/i.test(candidate.snippet || '');
}

function tooManyFromSameDayGroup(selected, candidate) {
  const key = `${candidate.group || ''}/${candidate.date || ''}`;
  const count = selected.filter((item) => `${item.group || ''}/${item.date || ''}` === key).length;
  return count >= 3;
}

function createCoverage() {
  return {
    groups: [],
    dates: [],
    hasDirectAnswer: false,
    hasSuccessCase: false,
    hasFailureBoundary: false,
    hasCounterpoint: false,
  };
}

function updateCoverage(coverage, candidate) {
  addCoverageValue(coverage.groups, candidate.group);
  addCoverageValue(coverage.dates, candidate.date);
  coverage.hasDirectAnswer ||= hasDirectAnswer(candidate);
  coverage.hasSuccessCase ||= hasSuccessCase(candidate);
  coverage.hasFailureBoundary ||= hasFailureBoundary(candidate);
  coverage.hasCounterpoint ||= hasCounterpoint(candidate);
}

function addCoverageValue(values, value) {
  const text = cleanText(value);
  if (text && !values.includes(text)) {
    values.push(text);
  }
}

function hasDirectAnswer(candidate) {
  return /建议|推荐|阈值|设置|可以|需要|至少|不超过|保持|≥|<=|>=|%|下限|上限|解决/.test(candidate.snippet || '');
}

function hasSuccessCase(candidate) {
  return /成功|稳定|成片|效果好|可以|验证|跑通|解决|恢复/.test(candidate.snippet || '');
}

function hasFailureBoundary(candidate) {
  return /失败|下限|再低|对不上|空洞|重影|断裂|爆显存|NaN|发散|卡顿|模糊|问题|难处理/.test(candidate.snippet || '');
}

function hasCounterpoint(candidate) {
  return /不是.*而是|关键不是|不一定|别|不要|反而|过高|越.*越/.test(candidate.snippet || '');
}

module.exports = {
  DEFAULT_QUERY_LIMIT,
  DOMAIN_TERMS,
  buildSecondPassQueries,
  classifyQuestion,
  disambiguateCandidates,
  extractSecondPassTerms,
  hasStrongParameterThreshold,
  planLocalRagQuery,
  scoreCoveragePriority,
  selectCoverageCandidates,
};
