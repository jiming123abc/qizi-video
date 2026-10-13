/**
 * shotBatcher：大批量分镜的分批生成机制
 *
 * 旧实现一次性让模型输出全部分镜 JSON：单个分镜完整字段（含英文 aiImagePrompt）
 * 约 400~700 tokens，分镜达到七八十个时输出就会触碰 max_tokens 上限被截断
 * （finish_reason=length），JSON 不完整导致整个任务失败。
 *
 * 本模块拆为三个阶段，使 100~200 个级别的分镜也能稳定生成：
 *   1) 大纲 outline：紧凑 JSON 先确定分镜总数 + 编号/标题/场次/一句话内容。
 *      每条仅 ~20 tokens，200 个分镜约 5k tokens；若仍超长则自动把脚本按段落
 *      二分，分段规划后合并并重新编号。
 *   2) 数字资产 digitalAssets：独立的小调用提取角色/道具/场景，失败不阻塞主流程。
 *   3) 明细分批 detail：每批 15 个分镜生成完整字段；单批被截断时自动对半拆分
 *      重试；极端情况下缺失的分镜用大纲占位，保证分镜数量与大纲一致、任务不失败。
 *
 * 返回结构与旧 parseScript 完全一致：
 *   { model, provider, content: JSON.stringify({ shots, digitalAssets }), finishReason, usage }
 */
const aiClient = require('./aiClient');

// 每批明细分镜数：15 × ~700 tokens ≈ 1 万 tokens，给推理模型的思考 token 留足预算
const SHOT_DETAIL_BATCH_SIZE = 15;
const DETAIL_MAX_TOKENS = 16384;
const OUTLINE_MAX_TOKENS = 16384;
const ASSETS_MAX_TOKENS = 16384;
const CALL_TIMEOUT_MS = 180000;

class OutputLengthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutputLengthError';
    this.code = 'length';
  }
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 从模型输出中提取第一个完整 JSON 对象（兼容 ```json 代码块包裹）
function extractFirstJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  let candidate = text.trim();
  const fenced = candidate.match(/```json\s*([\s\S]*?)\s*```/i) || candidate.match(/```\s*([\s\S]*?)\s*```/);
  if (fenced) candidate = fenced[1].trim();
  try { return JSON.parse(candidate); } catch (e) { /* 继续做花括号扫描 */ }

  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(candidate.substring(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

// 将长文本尽量均匀地切成 parts 段，优先在段落/句子边界断开，避免把一句话切成两半
function splitTextEvenly(text, parts) {
  const total = text.length;
  const result = [];
  let start = 0;
  for (let p = 0; p < parts; p++) {
    if (start >= total) break;
    if (p === parts - 1) {
      result.push(text.slice(start));
      break;
    }
    const targetLen = Math.ceil((total - start) / (parts - p));
    const ideal = start + targetLen;
    const winStart = start + Math.floor(targetLen * 0.6);
    const winEnd = Math.min(total, start + Math.floor(targetLen * 1.4));
    const window = text.slice(winStart, winEnd);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '。', '！', '？', '；', '.', '!', '?', ';', '，', ',', ' ']) {
      const idx = window.lastIndexOf(sep);
      if (idx !== -1) { cut = winStart + idx + sep.length; break; }
    }
    if (cut <= start || cut >= total) cut = ideal;
    result.push(text.slice(start, cut));
    start = cut;
  }
  return result.map(s => s.trim()).filter(Boolean);
}

// ---------------- Prompt 构造 ----------------

function buildOutlineSystemPrompt(mode, autoAssignScene) {
  const isScriptMode = mode === 'shooting_script' || mode === 'storyboard_script' || mode === 'script';
  const head = isScriptMode
    ? `你是一个专业的影视分镜脚本分析师。
用户将提供拍摄脚本或分镜脚本，你的任务是规划【分镜大纲】：为每个分镜分配编号、标题、所属场次和一句话画面概括。

【分镜粒度原则】
1. 每个分镜不包含镜头切换，一个分镜只对应一个连续画面
2. 严格遵循脚本中标注的分镜数量与顺序，不要合并、拆分或遗漏`
    : `你是一个专业的视频导演和分镜师。
用户将提供视频文案/旁白/策划案，你的任务是规划【分镜大纲】：先在脑中完成拍摄脚本创作，然后为每个分镜分配编号、标题、所属场次和一句话画面概括。

【分镜粒度原则】
1. 每个分镜不包含镜头切换，一个分镜只对应一个连续画面
2. 根据文案内容合理划分分镜数量与顺序，每个分镜对应一个独立画面`;

  const sceneRule = autoAssignScene
    ? `- sceneName: 所属场次名称
  【场次划分规则】
  1. 脚本中有明确场次标记（第一场/第二场、场景一、第1幕、INT./EXT.、内景/外景等）时必须严格沿用，一个场次都不能合并或省略，名称使用原始名称
  2. 没有明确标记时，根据场景/地点/时间变化自动划分，遵循"宜少不宜多"原则`
    : `- 不需要返回 sceneName 字段（用户已指定场次）`;

  return `${head}

【输出格式 - 极其重要】
只返回一个 JSON 对象，不要输出任何解释文字：
{"shots":[{"index":1,"title":"不超过15字的分镜标题","sceneName":"场次名称","brief":"不超过35字的一句话画面概括"}]}

要求：
- index 从 1 开始连续编号
- title 简短概括该镜头，brief 只写一句话画面，详细字段会在后续阶段补全，切勿写长文本
- 分镜数量较多时也必须全部列完，不得因为篇幅而省略
${sceneRule}`;
}

function buildDetailSystemPrompt(mode, autoAssignScene) {
  const isScriptMode = mode === 'shooting_script' || mode === 'storyboard_script' || mode === 'script';
  const head = isScriptMode
    ? '你是一个专业的影视分镜脚本分析师。根据【完整脚本】与已确认的【分镜大纲】，为指定编号的分镜补全全部拍摄字段。'
    : '你是一个专业的视频导演和分镜师。根据【完整文案】与已确认的【分镜大纲】，为指定编号的分镜补全全部拍摄字段。';

  return `${head}

【规则 - 极其重要】
1. 只生成本次指定编号范围内的分镜，编号（shotIndex）必须与大纲完全一致，不得新增、遗漏、合并或重新编号
2. 每个分镜的剧情必须与大纲中该编号的 title/brief 一致，你只负责补全拍摄细节，不得改变剧情内容或顺序
3. 每个分镜不包含镜头切换
4. 脚本/文案中缺少的信息，依据上下文与专业经验自动补全

对每个分镜提取以下字段：
- shotIndex: 分镜编号（必须与大纲编号一致的整数）
- title: 分镜标题
- sceneContent: 画面内容描述
- actors: 出场演员/角色
- costume: 演员服饰/服装
- props: 需要的道具
- location: 拍摄地点
- focalLength: 建议焦段（格式为"数字mm"，如"35mm"、"50mm"、"85mm"，不要返回"广角"等描述词）
- narration: 旁白或台词
- cameraMovement: 镜头运动方式（必须从以下选择：固定、推、拉、摇、移、跟、升降、旋转、环绕、变焦、手持、甩）
- shotType: 景别（必须从以下选择：大远景、远景、全景、中景、中近景、近景、特写、大特写）
- shotAngle: 拍摄角度（必须从以下选择：平拍、俯拍、仰拍、正拍、侧拍、反打、鸟瞰、主观视角、客观视角）
- lighting: 灯光要求
- notes: 其他备注
- estimatedDuration: 预估时长（纯数字秒数，如 5、8、12，不要带单位或范围）
- aiImagePrompt: 英文的AI图像生成提示词
- hasShotCut: 布尔值，该分镜是否包含镜头切换（如描述中涉及画面切换）
- isStockOrEffect: 布尔值，该分镜是否为素材镜头或特效镜头（不需要实际拍摄，如"空镜素材"、"转场特效"、"字幕动画"等）
${autoAssignScene
  ? '- sceneName: 必须直接使用大纲中该分镜给定的场次名称原文，不得改名、不得合并场次'
  : '- sceneName: 留空字符串'}

只返回 JSON 对象：{"shots":[ {上述字段的分镜对象} ]}，不要输出 digitalAssets 或任何解释文字。`;
}

function buildAssetsSystemPrompt(maxItems = 10, maxWords = 60) {
  return `你是一个专业的影视前期制片。
根据【完整脚本】与【分镜大纲】，提取全片可复用的数字资产，用于后续生成参考图。

要求：
1. 只提取跨多个分镜复用、形象需要保持一致的主要角色、关键道具、主要场景；只在单个镜头一闪而过的不要提取
2. 同名资产必须去重合并，每类不超过 ${maxItems} 项，宁精勿滥
3. imagePrompt 为英文 AI 生图提示词，控制在 ${maxWords} 个英文单词以内，抓准外观/材质/光线/风格关键特征即可，不要冗长

只返回 JSON 对象：
{
  "digitalAssets": {
    "mainActors": [{ "name": "角色名称", "imagePrompt": "英文提示词" }],
    "keyProps":   [{ "name": "道具名称", "imagePrompt": "英文提示词" }],
    "mainScenes":  [{ "name": "场景名称", "imagePrompt": "英文提示词" }]
  }
}
不要输出其他文字。`;
}

// ---------------- 主流程 ----------------

/**
 * @param {object} options { provider, model, autoAssignScene, batchSize, onProgress }
 *   onProgress({ phase, progress, label }) 用于驱动前端进度条
 */
async function generateShotsBatched(scriptContent, mode, settings, taskId, options = {}) {
  const autoAssignScene = options.autoAssignScene !== false;
  const provider = options.provider || 'geekai';
  const model = options.model || 'deepseek-flash';
  const batchSize = options.batchSize || SHOT_DETAIL_BATCH_SIZE;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const baseUrl = aiClient.getBaseUrl(provider, settings);
  const apiKey = aiClient.getApiKey(provider, settings);
  if (!apiKey) throw new Error(`${provider} API Key 未配置，请检查环境变量或数据库设置`);

  const emit = (progress, phase, label) => {
    if (onProgress) {
      try { onProgress({ progress: Math.max(0, Math.min(99, Math.round(progress))), phase, label }); } catch (e) { /* 忽略进度回调错误 */ }
    }
  };

  // ---- 底层：单次 JSON 调用（5xx/超时自动重试 1 次，记录费用，识别 length 截断）----
  const callJson = async (messages, { maxTokens, label }) => {
    const callOnce = async () => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3,
          max_tokens: maxTokens,
          stream: false,
          response_format: { type: 'json_object' }
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errBody.slice(0, 500)}`);
      }
      const data = await response.json();
      const usage = data.usage || {};
      await aiClient.recordUsage({
        type: 'chat',
        model,
        provider,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || usage.totalTokens || 0,
        taskId
      }, settings);

      const choice = (data.choices && data.choices[0]) || {};
      const content = choice.message && choice.message.content ? choice.message.content : '';
      if (choice.finish_reason === 'length') {
        throw new OutputLengthError(`${label}输出达到 max_tokens 上限被截断`);
      }
      const parsed = extractFirstJsonObject(content);
      if (!parsed) throw new Error(`${label}返回内容不是有效 JSON`);
      return { parsed, content, usage };
    };

    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callOnce();
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && aiClient.isRetryableError(err)) {
          console.warn(`[shotBatcher] ${provider}/${model} ${label}调用失败（${err.message}），1 秒后重试...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  };

  // ---- 阶段 1：分镜大纲（超长时自动二分脚本分段规划）----
  const normalizeOutline = (items) => items
    .map(it => ({
      title: String(it.title || '').slice(0, 50),
      sceneName: autoAssignScene ? String(it.sceneName || '').slice(0, 50) : '',
      brief: String(it.brief || it.sceneContent || it.title || '').slice(0, 300)
    }))
    .filter(it => (it.brief && it.brief.trim()) || (it.title && it.title.trim()));

  const buildOutline = async (scriptText, depth) => {
    emit(depth === 0 ? 15 : 15, 'outline', '正在规划分镜结构');
    const messages = [
      { role: 'system', content: buildOutlineSystemPrompt(mode, autoAssignScene) },
      { role: 'user', content: scriptText }
    ];
    try {
      const { parsed } = await callJson(messages, { maxTokens: OUTLINE_MAX_TOKENS, label: '分镜大纲' });
      const rawItems = Array.isArray(parsed.shots) ? parsed.shots : (Array.isArray(parsed) ? parsed : []);
      return normalizeOutline(rawItems);
    } catch (err) {
      if (err instanceof OutputLengthError && depth < 3) {
        const parts = splitTextEvenly(scriptText, 2);
        if (parts.length < 2) throw err;
        console.warn(`[shotBatcher] 大纲输出超长（depth=${depth}），将脚本拆为 ${parts.length} 段分别规划`);
        const subLists = [];
        for (const part of parts) {
          subLists.push(await buildOutline(part, depth + 1));
        }
        return normalizeOutline(subLists.flat());
      }
      throw err;
    }
  };

  console.log(`[shotBatcher] 使用模型 ${provider}/${model}，开始分批生成分镜（mode=${mode}）`);
  const outline = await buildOutline(scriptContent, 0);
  // 重新连续编号（分段规划合并后保证 index 连续）
  outline.forEach((it, i) => { it.index = i + 1; });

  if (outline.length === 0) {
    throw new Error('AI 未能从脚本中规划出任何分镜，请检查脚本内容是否与视频相关后重试');
  }
  console.log(`[shotBatcher] 大纲完成：共 ${outline.length} 个分镜`);

  // ---- 阶段 2：数字资产（失败不阻塞分镜生成）----
  let digitalAssets = { mainActors: [], keyProps: [], mainScenes: [] };
  try {
    emit(22, 'assets', '正在提取数字资产');
    const compactOutline = outline.map(o => ({ index: o.index, title: o.title, sceneName: o.sceneName, brief: o.brief }));
    const userContent = `【完整脚本】\n${scriptContent}\n\n【分镜大纲】\n${JSON.stringify(compactOutline)}`;
    const requestAssets = async (maxItems, maxWords) => {
      const { parsed } = await callJson([
        { role: 'system', content: buildAssetsSystemPrompt(maxItems, maxWords) },
        { role: 'user', content: userContent }
      ], { maxTokens: ASSETS_MAX_TOKENS, label: '数字资产' });
      const da = parsed.digitalAssets || {};
      return {
        mainActors: Array.isArray(da.mainActors) ? da.mainActors : [],
        keyProps: Array.isArray(da.keyProps) ? da.keyProps : [],
        mainScenes: Array.isArray(da.mainScenes) ? da.mainScenes : []
      };
    };
    try {
      digitalAssets = await requestAssets(10, 60);
    } catch (e) {
      // 脚本/大纲特别长导致资产提取仍被截断时，缩小到最核心的 5 项再试一次
      if (e instanceof OutputLengthError) {
        console.warn('[shotBatcher] 数字资产输出超长，缩小为每类最多 5 项重试');
        digitalAssets = await requestAssets(5, 40);
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.warn('[shotBatcher] 数字资产提取失败（不影响分镜生成）:', e.message);
  }

  // ---- 阶段 3：分批补全明细 ----
  // 大纲占位（某批缺失个别分镜、或单个分镜反复超限时使用，保证数量与大纲一致）
  const stubShot = (item) => ({
    shotIndex: item.index,
    shotType: '未知',
    title: item.title || (item.brief ? item.brief.substring(0, 20) : `镜头 ${item.index}`),
    sceneContent: item.brief || item.title || '',
    hasShotCut: false,
    isStockOrEffect: false,
    actors: '', props: '', costume: '', location: '',
    focalLength: '', narration: '', cameraMovement: '',
    shotAngle: '', lighting: '', notes: '',
    estimatedDuration: '', aiImagePrompt: '',
    sceneName: item.sceneName || ''
  });

  const finalizeShot = (item, d) => {
    d = d && typeof d === 'object' ? d : null;
    if (!d) return stubShot(item);
    // 模型偶尔会把 actors/props 等字段返回成数组，统一压成字符串，保证下游/数据库格式一致
    const text = (v) => {
      if (v === null || v === undefined) return '';
      if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object') ? (x.name || x.text || '') : String(x)).filter(Boolean).join('、');
      if (typeof v === 'object') return v.name || v.text || '';
      return String(v);
    };
    const numOrText = (v) => {
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'number') return String(v);
      const s = String(v).trim();
      // estimatedDuration 只保留数字部分（模型偶尔写 "5秒" / "5-8"）
      const m = s.match(/\d+(?:\.\d+)?/);
      return m ? m[0] : s;
    };
    return {
      shotIndex: item.index, // 以大纲编号为准，防止模型自行编号造成错位
      shotType: text(d.shotType) || '未知',
      title: text(d.title) || item.title || (item.brief ? item.brief.substring(0, 20) : `镜头 ${item.index}`),
      sceneContent: text(d.sceneContent) || item.brief || '',
      hasShotCut: !!d.hasShotCut,
      isStockOrEffect: !!d.isStockOrEffect,
      actors: text(d.actors),
      props: text(d.props),
      costume: text(d.costume),
      location: text(d.location),
      focalLength: text(d.focalLength),
      narration: text(d.narration),
      cameraMovement: text(d.cameraMovement),
      shotAngle: text(d.shotAngle),
      lighting: text(d.lighting),
      notes: text(d.notes),
      estimatedDuration: numOrText(d.estimatedDuration),
      aiImagePrompt: text(d.aiImagePrompt),
      sceneName: text(d.sceneName) || item.sceneName || ''
    };
  };

  const buildDetailBatch = async (items, depth) => {
    const startIdx = items[0].index;
    const endIdx = items[items.length - 1].index;
    const compactOutline = outline.map(o => ({ index: o.index, title: o.title, sceneName: o.sceneName, brief: o.brief }));
    const userContent = `【完整脚本】
${scriptContent}

【分镜大纲】（共 ${outline.length} 个分镜）
${JSON.stringify(compactOutline)}

【本次任务】
请只生成编号 ${startIdx}~${endIdx} 的共 ${items.length} 个分镜的完整字段。
严格要求：shotIndex 必须依次为 ${items.map(i => i.index).join('、')}；不得生成其他编号；按编号升序排列。`;

    try {
      const { parsed } = await callJson([
        { role: 'system', content: buildDetailSystemPrompt(mode, autoAssignScene) },
        { role: 'user', content: userContent }
      ], { maxTokens: DETAIL_MAX_TOKENS, label: `分镜明细 ${startIdx}-${endIdx}` });

      const gotList = Array.isArray(parsed.shots) ? parsed.shots : (Array.isArray(parsed) ? parsed : []);
      const gotMap = new Map();
      gotList.forEach(s => {
        const idx = Number(s && (s.shotIndex ?? s.index));
        if (Number.isInteger(idx) && !gotMap.has(idx)) gotMap.set(idx, s);
      });
      return items.map(item => finalizeShot(item, gotMap.get(item.index)));
    } catch (err) {
      if (err instanceof OutputLengthError && items.length > 1 && depth < 3) {
        const mid = Math.floor(items.length / 2);
        console.warn(`[shotBatcher] 批次 ${startIdx}-${endIdx} 输出超长，自动拆分为 ${startIdx}-${items[mid - 1].index} 与 ${items[mid].index}-${endIdx}`);
        const first = await buildDetailBatch(items.slice(0, mid), depth + 1);
        const second = await buildDetailBatch(items.slice(mid), depth + 1);
        return [...first, ...second];
      }
      if (err instanceof OutputLengthError) {
        console.warn(`[shotBatcher] 单个分镜 ${startIdx} 明细仍超限，使用大纲占位`);
        return items.map(stubShot);
      }
      throw err;
    }
  };

  const batches = chunkArray(outline, batchSize);
  const shots = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const items = batches[bi];
    const spanStart = 25;
    const spanEnd = 94;
    emit(spanStart + (spanEnd - spanStart) * (bi / batches.length), 'detail', `正在生成第 ${bi + 1}/${batches.length} 批分镜`);
    console.log(`[shotBatcher] 明细批次 ${bi + 1}/${batches.length}（编号 ${items[0].index}-${items[items.length - 1].index}）`);
    const part = await buildDetailBatch(items, 0);
    shots.push(...part);
  }
  shots.sort((a, b) => a.shotIndex - b.shotIndex);

  // 完整性兜底：理论上不会触发，确保最终数量始终等于大纲
  if (shots.length !== outline.length) {
    const byIndex = new Map(shots.map(s => [s.shotIndex, s]));
    const rebuilt = outline.map(item => byIndex.get(item.index) || stubShot(item));
    shots.length = 0;
    shots.push(...rebuilt);
  }

  emit(96, 'merge', '正在整理分镜数据');
  console.log(`[shotBatcher] 分批生成完成：共 ${shots.length} 个分镜，${batches.length} 个批次，数字资产 ${digitalAssets.mainActors.length}/${digitalAssets.keyProps.length}/${digitalAssets.mainScenes.length}`);

  return {
    model,
    provider,
    content: JSON.stringify({ shots, digitalAssets }),
    finishReason: 'stop',
    usage: { batches: batches.length }
  };
}

module.exports = { generateShotsBatched, splitTextEvenly, extractFirstJsonObject };
