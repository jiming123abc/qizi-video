/**
 * AI 客户端封装
 * 支持 GeekAI 和 SiliconFlow 双平台，带降级链
 * 
 * API Base URLs:
 * - GeekAI: https://geekai.co/api/v1
 * - SiliconFlow: https://api.siliconflow.cn/v1
 */

const { settings, aiUsage } = require('./database');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

// ========== 常量定义 ==========
const GEEKAI_BASE = 'https://geekai.co/api/v1';
const SILICONFLOW_BASE = 'https://api.siliconflow.cn/v1';

// 模型费用（单位：元）
const MODEL_PRICES = {
  // 文本模型：元/千tokens
  'deepseek-flash': { input: 0.001, output: 0.002 },
  'doubao-seed-2.1-lite': { input: 0.0004, output: 0.00135 },
  'mimo-v2.6-pro': { input: 0.0024, output: 0.0048 },
  'gpt-6-luna': { input: 0.000075, output: 0.000375 },
  'claude-sonnet-5-5': { input: 0.0015, output: 0.0075 },

  // 生图模型：元/张
  'gpt-image-2.5-flare': { per_image_medium: 0.077 },
  'doubao-seedream-5.0-flash': { per_image_standard: 0.096 },
  'nano-banana-2-lite': { per_image_standard: 0.125 },
};

// ========== 辅助函数 ==========

/**
 * P4-5 扩展：所有 AI 任务的统一友好错误提示
 * 按 HTTP 状态码/错误类型分类，引导用户排查
 */
function friendlyAiError(err) {
  const msg = (err && err.message) || '';
  if (msg.includes('视频下载失败') || msg.includes('下载视频失败')) return msg;
  if (msg.includes('ffmpeg') || msg.includes('场景检测失败')) return '视频处理失败：' + msg;
  if (msg.includes('HTTP 429')) return 'AI 服务繁忙（请求过多），请稍后重试';
  if (msg.includes('HTTP 401') || msg.includes('HTTP 403')) return 'AI 服务鉴权失败，请检查 API Key 配置';
  if (msg.includes('HTTP 400')) return '请求参数错误：' + msg;
  if (msg.includes('timeout') || msg.includes('aborted')) return 'AI 响应超时（>120s），请简化输入或稍后重试';
  if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) return '网络连接异常，请检查网络后重试';
  return msg || '未知错误';
}

/**
 * P4-5 扩展：判断错误是否可重试（仅 5xx/超时/连接重置，4xx 不重试）
 */
function isRetryableError(err) {
  const msg = (err && err.message) || '';
  return msg.includes('HTTP 5') || msg.includes('timeout') || msg.includes('aborted')
    || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed');
}

/**
 * 获取 API Key
 * 优先从 settings.ai_platforms 查找（统一管理），回退到旧字段和环境变量
 */
function getApiKey(provider, settings) {
  // 优先从 ai_platforms 查找
  if (settings && settings.ai_platforms && Array.isArray(settings.ai_platforms)) {
    const platform = settings.ai_platforms.find(p => p.id === provider);
    if (platform && platform.apiKey && !platform.apiKey.includes('****')) {
      return platform.apiKey;
    }
  }
  // 回退到旧字段 + 环境变量（迁移兼容）
  if (provider === 'siliconflow') {
    return settings.siliconflow_api_key || process.env.SILICONFLOW_API_KEY;
  }
  if (provider === 'geekai') {
    return settings.geekai_api_key || process.env.GEEKAI_API_KEY;
  }
  return null;
}

/**
 * 获取 Base URL
 * 优先从 settings.ai_platforms 查找，回退到硬编码常量
 */
function getBaseUrl(provider, settings) {
  if (settings && settings.ai_platforms && Array.isArray(settings.ai_platforms)) {
    const platform = settings.ai_platforms.find(p => p.id === provider);
    if (platform && platform.baseUrl) {
      return platform.baseUrl;
    }
  }
  // 回退到硬编码（迁移兼容）
  return provider === 'siliconflow' ? SILICONFLOW_BASE : GEEKAI_BASE;
}

/**
 * 计算费用
 */
function calculateCost(type, model, usage, prices = MODEL_PRICES) {
  const modelPrices = prices[model];
  if (!modelPrices) return 0;
  
  if (type === 'image') {
    // 根据质量档位找价格
    const quality = usage.quality || 'standard';
    return modelPrices[quality] || Object.values(modelPrices)[0] || 0;
  }
  
  if (type === 'chat') {
    const inputCost = (usage.promptTokens || 0) * (modelPrices.input || 0) / 1000;
    const outputCost = (usage.completionTokens || 0) * (modelPrices.output || 0) / 1000;
    return inputCost + outputCost;
  }
  
  return 0;
}

/**
 * 记录 AI 使用日志
 */
async function recordUsage(log, settings) {
  try {
    const prices = settings.model_prices || MODEL_PRICES;
    const estimatedCost = calculateCost(log.type, log.model, log, prices);
    
    await aiUsage.record({
      taskId: log.taskId || null,
      type: log.type,
      model: log.model,
      provider: log.provider,
      promptTokens: log.promptTokens || 0,
      completionTokens: log.completionTokens || 0,
      totalTokens: log.totalTokens || 0,
      imageCount: log.type === 'image' ? (log.imageCount || 1) : 0,
      estimatedCost
    });
    
    return estimatedCost;
  } catch (err) {
    console.error('[aiClient] 记录使用日志失败:', err.message);
    return 0;
  }
}

// ========== 核心 API 函数 ==========

/**
 * 调用文本模型（带降级链）
 */
async function callChatWithFallback(messages, fallbackChain, settings, options = {}) {
  for (const item of fallbackChain) {
    const { model, provider } = item;
    const baseUrl = getBaseUrl(provider, settings);
    const apiKey = getApiKey(provider, settings);
    
    if (!apiKey) {
      console.warn(`[aiClient] ${provider} API Key 未配置，跳过模型 ${model}`);
      continue;
    }
    
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature || 0.3,
          max_tokens: options.max_tokens || 8192,
          stream: false,
          ...(options.json ? { response_format: { type: "json_object" } } : {})
        }),
        signal: AbortSignal.timeout(options.timeoutMs || 120000)
      });
      
      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errBody}`);
      }
      
      const data = await response.json();
      const usage = data.usage || {};
      
      // 记录费用
      await recordUsage({
        type: 'chat',
        model,
        provider,
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || usage.totalTokens || 0,
        taskId: options.taskId
      }, settings);
      
      return {
        model,
        provider,
        content: data.choices[0].message.content,
        usage
      };
    } catch (err) {
      console.warn(`[aiClient] ${provider}/${model} 调用失败: ${err.message}`);
      continue;
    }
  }
  
  throw new Error('所有文本模型均调用失败');
}

/**
 * 画图模型参数适配（极客智坊 OpenAI 兼容接口，规则参考 https://docs.geekai.co/cn/docs/image）
 * 不同模型族支持的参数差异较大：
 * - gpt-image-2.5 系列：size 任意（宽高为16倍数、像素 655360~8294400），quality=low/medium/high/xhigh/max
 * - doubao-seedream-5.0 系列：不支持 quality/n/aspect_ratio，size 用 2K/3K/4K 档像素值
 * - nano-banana 系列：不支持 quality/size/watermark，用 aspect_ratio 控制比例
 */

// 从 '1024x576' / '16:9' 等格式解析宽高比
function getImageAspectRatio(size) {
  if (typeof size !== 'string') return '1:1';
  const arMatch = size.match(/^\s*(\d+)\s*[:：]\s*(\d+)\s*$/);
  if (arMatch) return `${parseInt(arMatch[1])}:${parseInt(arMatch[2])}`;
  const m = size.match(/(\d+)\s*[x×X]\s*(\d+)/);
  if (!m) return '1:1';
  const w = parseInt(m[1]);
  const h = parseInt(m[2]);
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

// 在支持的宽高比中挑选与目标最接近的
function closestAspectRatio(target, allowed) {
  if (allowed.includes(target)) return target;
  const [tw, th] = target.split(':').map(Number);
  const tv = tw / th;
  return allowed.reduce((best, ratio) => {
    const [rw, rh] = ratio.split(':').map(Number);
    const [bw, bh] = best.split(':').map(Number);
    return Math.abs(rw / rh - tv) < Math.abs(bw / bh - tv) ? ratio : best;
  }, allowed[0]);
}

// GPT-Image-2.5（Flare/Sunburst）：宽高须为 16 的倍数，总像素不低于 655360
const GPT_IMAGE_25_SIZE_MAP = {
  '16:9': '1280x720',
  '9:16': '720x1280',
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '4:3': '1280x960',
  '3:4': '960x1280',
};

// Doubao-Seedream-5.0 系列：2K 分辨率档像素值
const SEEDREAM_5_SIZE_MAP = {
  '16:9': '2848x1600',
  '9:16': '1600x2848',
  '1:1': '2048x2048',
  '3:2': '2496x1664',
  '2:3': '1664x2496',
  '4:3': '2304x1728',
  '3:4': '1728x2304',
  '21:9': '3136x1344',
};

const NANO_BANANA_RATIOS = ['1:1', '2:3', '3:2', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9', '9:21'];

const GPT_IMAGE_25_QUALITY_MAP = {
  standard: 'medium',
  medium: 'medium',
  hd: 'high',
  high: 'high',
  ultra: 'xhigh',
  low: 'low',
};

/**
 * 按模型族构建 /images/generations 请求体
 * @param {string[]} [refImages] 参考图（data URL 或远程 URL），可选
 */
function buildImageRequestBody(model, prompt, quality, size, refImages) {
  const modelName = (model || '').toLowerCase();
  const ratio = getImageAspectRatio(size || '1024x576');
  const body = { model, prompt, response_format: 'url' };

  if (modelName.startsWith('gpt-image-2.5') || modelName.startsWith('gpt-image-2-5')) {
    body.size = GPT_IMAGE_25_SIZE_MAP[closestAspectRatio(ratio, Object.keys(GPT_IMAGE_25_SIZE_MAP))] || '1024x1024';
    body.quality = GPT_IMAGE_25_QUALITY_MAP[quality] || 'medium';
    body.n = 1;
    body.watermark = false;
  } else if (modelName.startsWith('doubao-seedream-5')) {
    // 5.0 系列不支持 quality/n/aspect_ratio；默认 2K 档
    body.size = SEEDREAM_5_SIZE_MAP[closestAspectRatio(ratio, Object.keys(SEEDREAM_5_SIZE_MAP))] || '2048x2048';
    body.output_format = 'png';
    body.watermark = false;
  } else if (modelName.startsWith('nano-banana')) {
    // Nano Banana 系列仅支持 aspect_ratio（lite 仅 1K 输出）
    body.aspect_ratio = closestAspectRatio(ratio, NANO_BANANA_RATIOS);
  } else {
    // 其它模型：OpenAI 兼容通用参数
    body.size = size || '1024x576';
    body.quality = quality || 'standard';
    body.watermark = false;
    body.n = 1;
  }

  if (refImages) {
    const list = (Array.isArray(refImages) ? refImages : [refImages]).filter(Boolean);
    if (list.length > 0) {
      // 单图 string、多图 string[]（极客智坊画图 API 手册约定）
      body.image = list.length === 1 ? list[0] : list;
    }
  }

  return body;
}

/**
 * 调用文生图 API
 */
async function callImageGen(model, prompt, quality, size, baseUrl, apiKey) {
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(buildImageRequestBody(model, prompt, quality, size)),
    signal: AbortSignal.timeout(120000)
  });
  
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`HTTP ${response.status}: ${errBody}`);
  }
  
  const data = await response.json();
  
  // 兼容多种返回格式
  if (data.data?.[0]?.url) return { url: data.data[0].url };
  if (data.data?.[0]?.b64_json) return { b64_json: data.data[0].b64_json };
  if (data.url) return { url: data.url };
  if (data.output?.url) return { url: data.output.url };
  if (data.images?.[0]?.url) return { url: data.images[0].url };
  if (typeof data.images?.[0] === 'string') return { url: data.images[0] };
  if (data.data?.[0] && typeof data.data[0] === 'string') return { url: data.data[0] };
  if (data.image_url) return { url: data.image_url };
  if (data.result?.image_url) return { url: data.result.image_url };
  
  console.warn(`[aiClient] ${model} 返回数据格式不匹配，原始响应:`, JSON.stringify(data).substring(0, 500));
  throw new Error('返回数据格式异常，无法提取图片URL');
}

/**
 * 调用图生图 API（支持单张或多张参考图）
 * @param {string|string[]} refImageUrls - 参考图 URL（单张或数组）
 */
async function callImageGenWithRef(model, prompt, refImageUrls, quality, size, baseUrl, apiKey) {
  // 归一化为数组
  const urls = Array.isArray(refImageUrls) ? refImageUrls : [refImageUrls];

  // 下载所有参考图转为 base64
  const base64Images = [];
  for (const url of urls) {
    try {
      const refResponse = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (refResponse.ok) {
        const buffer = await refResponse.arrayBuffer();
        const mimeType = (refResponse.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
        base64Images.push(`data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`);
      }
    } catch (e) {
      console.warn(`[aiClient] 下载参考图失败: ${e.message}`);
    }
  }

  if (base64Images.length === 0) {
    console.warn('[aiClient] 所有参考图下载失败，将使用文生图');
    return callImageGen(model, prompt, quality, size, baseUrl, apiKey);
  }

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(buildImageRequestBody(model, prompt, quality, size, base64Images)),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.warn(`[aiClient] ${model} 图生图模式失败 (HTTP ${response.status})，降级到文生图: ${errBody.substring(0, 200)}`);
    // 降级时使用带重试版本的 callImageGenWithRetry，确保文生图也有重试机会
    return callImageGenWithRetry(model, prompt, quality, size, baseUrl, apiKey);
  }
  
  const data = await response.json();
  
  // 兼容多种返回格式 - 与 callImageGen 保持一致
  if (data.data?.[0]?.url) return { url: data.data[0].url };
  if (data.data?.[0]?.b64_json) return { b64_json: data.data[0].b64_json };
  if (data.url) return { url: data.url };
  if (data.output?.url) return { url: data.output.url };
  if (data.images?.[0]?.url) return { url: data.images[0].url };
  if (typeof data.images?.[0] === 'string') return { url: data.images[0] };
  if (data.data?.[0] && typeof data.data[0] === 'string') return { url: data.data[0] };
  if (data.image_url) return { url: data.image_url };
  if (data.result?.image_url) return { url: data.result.image_url };
  
  console.warn(`[aiClient] ${model} 图生图返回数据格式不匹配，原始响应:`, JSON.stringify(data).substring(0, 500));
  throw new Error('返回数据格式异常，无法提取图片URL');
}

/**
 * 调用图像生成（带降级链和场景图支持）
 * @deprecated 已废弃 - 请使用 callImageGen 或 callImageGenWithRef 直接调用
 * 该函数保留用于兼容性，但不再推荐使用
 */
async function callImageWithFallback(prompt, fallbackChain, settings, options = {}) {
  const { sceneImageUrl, size = '1024x576', taskId } = options;
  
  console.log(`[aiClient] 开始图片生成，降级链共 ${fallbackChain.length} 个模型，场景图: ${sceneImageUrl ? '有' : '无'}`);
  
  for (let i = 0; i < fallbackChain.length; i++) {
    const item = fallbackChain[i];
    const { model, quality = 'standard', provider } = item;
    const baseUrl = getBaseUrl(provider, settings);
    const apiKey = getApiKey(provider, settings);
    
    if (!apiKey) {
      console.warn(`[aiClient] ${provider} API Key 未配置，跳过模型 ${model}`);
      continue;
    }
    
    console.log(`[aiClient] [${i + 1}/${fallbackChain.length}] 尝试模型 ${provider}/${model} (quality=${quality}, 图生图=${sceneImageUrl ? '是' : '否'})`);
    
    try {
      let result;
      
      if (sceneImageUrl) {
        result = await callImageGenWithRef(model, prompt, sceneImageUrl, quality, size, baseUrl, apiKey);
      } else {
        result = await callImageGen(model, prompt, quality, size, baseUrl, apiKey);
      }
      
      console.log(`[aiClient] 模型 ${model} 生成成功`);
      
      await recordUsage({
        type: 'image',
        model,
        provider,
        quality,
        imageCount: 1,
        taskId
      }, settings);
      
      return { model, provider, url: result.url, b64_json: result.b64_json };
    } catch (err) {
      console.warn(`[aiClient] 模型 ${provider}/${model} 生成失败: ${err.message}`);
      continue;
    }
  }
  
  throw new Error('所有图片模型均调用失败');
}

/**
 * 分析场景图片，提取场景特征描述
 */
async function analyzeSceneImage(imageUrl, settings, taskId) {
  // 下载图片
  let base64Image = null;
  try {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      // 从 Content-Type 头获取实际 MIME 类型，回退到 image/jpeg
      const mimeType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      base64Image = `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
    }
  } catch (e) {
    console.warn('[aiClient] 下载场景图失败:', e.message);
    return '';
  }
  
  if (!base64Image) return '';
  
  // 图片分析需要视觉模型：优先取标记 supportsVision 的模型，避免在无视觉能力的模型上空跑一次失败调用
  const fullChain = settings.llm_fallback_chain || [
    { model: 'doubao-seed-2.1-lite', provider: 'geekai', supportsVision: true }
  ];
  const visionChain = fullChain.filter(m => m.supportsVision);
  const defaultChain = visionChain.length > 0 ? visionChain : fullChain;
  
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '请分析这张图片，提取以下信息用于生成类似的参考图：\n1. 场景类型（室内/室外、具体场所如咖啡馆/办公室/街道等）\n2. 光线条件（自然光/人工光、光线方向、亮度）\n3. 色调和风格\n4. 主要视觉元素\n\n请用简洁的中文描述，50字以内。'
        },
        {
          type: 'image_url',
          image_url: { url: base64Image }
        }
      ]
    }
  ];
  
  try {
    const result = await callChatWithFallback(messages, defaultChain, settings, {
      temperature: 0.3,
      max_tokens: 200,
      taskId
    });
    return result.content.trim();
  } catch (e) {
    console.warn('[aiClient] 场景分析失败:', e.message);
    return '';
  }
}

// ========== 便捷函数 ==========

/**
 * 解析拍摄脚本生成分镜
 *
 * 已改为分批生成（见 shotBatcher.js）：先出紧凑大纲确定分镜总数，
 * 再按每批 15 个补全完整字段，支持 100~200+ 分镜不被 max_tokens 截断。
 */
async function parseScript(scriptContent, mode, settings, taskId, options = {}) {
  // 函数内 require 避免与 shotBatcher <-> aiClient 的循环依赖问题
  const { generateShotsBatched } = require('./shotBatcher');
  return generateShotsBatched(scriptContent, mode, settings, taskId, options);
}

/**
 * P5-1：直接调用 LLM（指定 provider/model，不走降级链）
 * 用于新增的 5 个 AI 函数（analyzeScriptType / generateVideoCopy / generateSceneDivision /
 * generateStoryboardScript / generateShootingScript），统一封装重试逻辑。
 * @param {string} systemPrompt - 系统提示
 * @param {string} userContent - 用户输入内容
 * @param {object} settings - 设置
 * @param {string} taskId - 任务ID
 * @param {object} options - { provider, model, json: 是否返回JSON, max_tokens, temperature }
 * @returns {Promise<string>} 返回 LLM 文本内容（JSON 模式下返回原始 JSON 字符串，由调用方解析）
 */
async function callLLMDirect(systemPrompt, userContent, settings, taskId, options = {}) {
  const provider = options.provider || 'geekai';
  const model = options.model || 'deepseek-flash';
  const useJson = options.json === true;
  // 推理模型（如 deepseek-flash）的推理 token 与可见输出共享 max_tokens 预算，
  // 复杂文档下推理可能消耗数千 token，上限过小时正文会在中途被截断
  const MAX_TOKENS_CAP = 16384;
  let maxTokens = Math.min(options.max_tokens || 8192, MAX_TOKENS_CAP);
  const temperature = options.temperature ?? 0.3;

  const baseUrl = getBaseUrl(provider, settings);
  const apiKey = getApiKey(provider, settings);

  if (!apiKey) {
    throw new Error(`${provider} API Key 未配置，请检查环境变量或数据库设置`);
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  console.log(`[aiClient] 使用模型 ${provider}/${model} 调用 LLM（json=${useJson}, max_tokens=${maxTokens}）`);

  // 单次请求（messages / maxTokens 可变，供"扩权重试"与"续写"复用）
  const requestOnce = async (reqMessages, reqMaxTokens) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: reqMessages,
        temperature,
        max_tokens: reqMaxTokens,
        stream: false,
        ...(useJson ? { response_format: { type: "json_object" } } : {})
      }),
      signal: AbortSignal.timeout(120000)
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`HTTP ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    const usage = data.usage || {};

    await recordUsage({
      type: 'chat',
      model,
      provider,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || usage.totalTokens || 0,
      taskId
    }, settings);

    const choice = data.choices[0] || {};
    return {
      model,
      provider,
      content: choice.message?.content || '',
      finishReason: choice.finish_reason,
      usage
    };
  };

  // 网络层重试（仅对 5xx/超时/连接重置重试 1 次，4xx 不重试）
  const withRetry = async (reqMessages, reqMaxTokens) => {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await requestOnce(reqMessages, reqMaxTokens);
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && isRetryableError(err)) {
          console.warn(`[aiClient] ${provider}/${model} 调用失败（${err.message}），1 秒后重试...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };

  let result = await withRetry(messages, maxTokens);
  let content = result.content;

  // 输出因 max_tokens 被截断时的补救
  if (result.finishReason === 'length') {
    if (useJson) {
      // JSON 无法拼接：提升到最大 token 上限整体重试一次
      if (maxTokens < MAX_TOKENS_CAP) {
        maxTokens = MAX_TOKENS_CAP;
        console.warn(`[aiClient] JSON 输出被 max_tokens 截断，提升至 ${maxTokens} 后整体重试`);
        result = await withRetry(messages, maxTokens);
        content = result.content;
      }
      if (result.finishReason === 'length') {
        throw new Error('AI 输出超出长度上限（可能分镜数量过多），请缩短文档、减少分镜数量后重试');
      }
    } else {
      // 极端情况下推理 token 吃光预算、可见正文为空：先扩到最大上限整体重试
      if (!content.trim() && maxTokens < MAX_TOKENS_CAP) {
        maxTokens = MAX_TOKENS_CAP;
        console.warn(`[aiClient] 推理 token 占满预算导致正文为空，提升至 ${maxTokens} 后整体重试`);
        result = await withRetry(messages, maxTokens);
        content = result.content;
      }
      // 纯文本：在多轮对话中要求模型从截断处续写，最多续写 2 次并拼接
      const convo = [
        ...messages,
        { role: 'assistant', content }
      ];
      let rounds = 0;
      while (result.finishReason === 'length' && rounds < 2) {
        rounds += 1;
        console.warn(`[aiClient] 文本输出被 max_tokens 截断，进行第 ${rounds} 次续写`);
        convo.push({
          role: 'user',
          content: '上一条内容在输出中途被截断。请直接从截断处继续输出，不要重复已有内容，不要添加任何说明、开场白或结束语。'
        });
        result = await withRetry(convo, maxTokens);
        content += result.content;
        convo.push({ role: 'assistant', content: result.content });
      }
      if (result.finishReason === 'length') {
        throw new Error('AI 生成内容过长，多次续写后仍未完成，请缩短文档或缩小视频时长后重试');
      }
    }
  }

  return {
    model,
    provider,
    content,
    finishReason: result.finishReason,
    usage: result.usage
  };
}

/**
 * P5-1 路径分流：AI 判断文档是否含分镜/场次信息，并评估文档是否可生成分镜
 * 用于 processScriptParse 中 stage='auto' 时的路径分流（A1/A2/B/D）
 * @returns {Promise<{hasStoryboard: boolean, hasScene: boolean, canGenerate: boolean, reason: string, suggestion: string}>}
 */
async function analyzeScriptType(scriptContent, settings, taskId, options = {}) {
  const systemPrompt = `你是一个影视脚本分析师。请分析用户提供的文档，判断其是否包含分镜信息或场次信息，并评估文档是否可用于生成分镜。

【判断标准】
- 含分镜信息：文档中有明确的"镜头"、"分镜"、"画面"、"景别"等分镜级别描述
- 含场次信息：文档中有明确的"第一场/第二场"、"场景一/场景二"、"INT./EXT."、"内景/外景"等场次划分
- 可生成（canGenerate=true）：文档内容与视频制作相关（如解说词、旁白、策划案、产品介绍、故事大纲、企业宣传、广告创意等），即使不含分镜信息也可由 AI 生成分镜
- 不可生成（canGenerate=false）：文档内容与视频制作完全无关（如技术手册、合同条款、纯数据表格等），或内容过于简短/混乱无法提取有效信息（如<50字的无关文本、乱码等）

【返回JSON格式】
{
  "hasStoryboard": true/false,
  "hasScene": true/false,
  "canGenerate": true/false,
  "reason": "判断理由（30字内）",
  "suggestion": "当 canGenerate=false 时给出建议（50字内），canGenerate=true 时为空字符串"
}`;

  const result = await callLLMDirect(systemPrompt, scriptContent, settings, taskId, {
    ...options,
    json: true,
    max_tokens: 500,
    temperature: 0
  });

  try {
    return JSON.parse(result.content);
  } catch (e) {
    console.error('[aiClient] analyzeScriptType JSON 解析失败:', e.message, '原始内容:', result.content.substring(0, 500));
    // 解析失败时保守处理：当作可生成处理，避免阻断用户流程
    return {
      hasStoryboard: false,
      hasScene: false,
      canGenerate: true,
      reason: '类型判断解析失败，按可生成处理',
      suggestion: ''
    };
  }
}

/**
 * P5-1 路径C：根据制片意图生成视频文案，供用户确认后进入分镜生成流程
 * @returns {Promise<{content: string}>} 视频文案文本
 */
async function generateVideoCopy(intent, settings, taskId, options = {}) {
  const systemPrompt = `你是一个专业的视频文案策划。用户将提供制片意图，请你根据意图创作一份视频文案。

【生成原则】
1. 文案应包含完整的视频叙事结构（开场、主体、结尾）
2. 包含旁白/解说词内容
3. 符合用户提到的视频类型和时长要求
4. 语言生动、有感染力，符合视频文案特点
5. 如果用户未明确时长，按 2-3 分钟视频长度创作

【输出格式】（纯文本，便于用户阅读和编辑）
视频文案

[标题]

[开场部分]
旁白：...

[主体部分]
旁白：...

[结尾部分]
旁白：...

预估时长：[X分钟]`;

  const result = await callLLMDirect(systemPrompt, intent, settings, taskId, {
    ...options,
    json: false,
    max_tokens: 8192,
    temperature: 0.7
  });
  return { content: result.content };
}

/**
 * P5-1 路径A2：已含分镜但不含场次的文档，AI 生成场次划分供用户确认
 * @returns {Promise<{content: string}>} 场次划分文本
 */
async function generateSceneDivision(scriptContent, settings, taskId, options = {}) {
  const systemPrompt = `你是一个专业的影视拍摄统筹。用户提供的文档已包含分镜信息但未划分场次，请你根据分镜内容生成场次划分。

【场次划分原则】
1. 根据场景/地点/时间变化划分场次，遵循"宜少不宜多"原则
2. 同一地点、同一时间段连续拍摄的分镜归为同一场次
3. 为每场次命名（如"办公室-日"、"街道-夜"），名称简洁明确
4. 保留原分镜的序号，标注每个分镜属于哪一场次
5. 不要修改原分镜的内容描述，只做场次归集

【输出格式】（纯文本，便于用户阅读和确认）
场次划分方案

【第1场 场景名称】
- 镜头1：[原分镜简述]
- 镜头3：[原分镜简述]

【第2场 场景名称】
- 镜头2：[原分镜简述]
- 镜头4：[原分镜简述]

...`;

  const result = await callLLMDirect(systemPrompt, scriptContent, settings, taskId, {
    ...options,
    json: false,
    max_tokens: 8192,
    temperature: 0.3
  });
  return { content: result.content };
}

/**
 * P5-1 路径B/C 阶段1：根据视频文案/旁白/策划案生成分镜脚本（按时间顺序，无场次）
 * @returns {Promise<{content: string}>} 分镜脚本文本
 */
async function generateStoryboardScript(scriptContent, settings, taskId, options = {}) {
  const systemPrompt = `你是一个专业的视频导演。用户将提供视频文案/旁白/策划案，请你创作一份分镜脚本。

【生成原则】
1. 遵循视频的时间先后顺序
2. 单个分镜内不涉及镜头切换（一个分镜对应一个连续画面）
3. 不需要包含场次划分、拍摄地点等拍摄信息（这些在后续拍摄脚本中生成）
4. 每个分镜包含：序号、画面内容描述、旁白/台词、预估时长
5. 根据文案内容合理划分分镜数量，每个分镜对应一个独立的画面

【输出格式】（纯文本，便于用户阅读和编辑）
分镜脚本

镜头1：[画面内容描述]
旁白：[旁白内容]
时长：[X秒]

镜头2：[画面内容描述]
旁白：[旁白内容]
时长：[X秒]

...`;

  const result = await callLLMDirect(systemPrompt, scriptContent, settings, taskId, {
    ...options,
    json: false,
    max_tokens: 16384,
    temperature: 0.5
  });
  return { content: result.content };
}

/**
 * P5-1 路径B/C 阶段2：根据确认的分镜脚本生成拍摄脚本（含场次，按场次组织）
 * @returns {Promise<{content: string}>} 拍摄脚本文本
 */
async function generateShootingScript(scriptContent, settings, taskId, options = {}) {
  const systemPrompt = `你是一个专业的影视拍摄统筹。用户已确认分镜脚本，请你生成拍摄脚本。

【生成原则】
1. 根据场景/地点/时间划分场次，同一场次的分镜聚集在一起
2. 可以打乱原分镜的时间顺序，按场次组织
3. 每个分镜补齐拍摄信息：景别、镜头运动、拍摄角度、灯光、道具、服饰、地点、建议焦段
4. 保留原分镜的序号（便于追溯），但按场次重新排列
5. 单个分镜内不涉及镜头切换

【输出格式】（纯文本，便于用户阅读和下载）
拍摄脚本

【第一场 场景名称 - 拍摄地点】
镜头[原序号]：[画面内容] | 景别：[X] | 镜头运动：[X] | 角度：[X] | 焦段：[X] | 灯光：[X] | 道具：[X] | 服饰：[X] | 时长：[X秒]

【第二场 ...】
...`;

  const result = await callLLMDirect(systemPrompt, scriptContent, settings, taskId, {
    ...options,
    json: false,
    max_tokens: 16384,
    temperature: 0.4
  });
  return { content: result.content };
}

/**
 * P5-1 最终生成分镜数据：根据拍摄脚本/已含分镜的文档生成规范的分镜列表
 * 复用原 parseScript 的 prompt（含 14 个字段 + 数字资产）
 * @param {string} scriptContent - 拍摄脚本或已含分镜的文档内容
 * @param {string} mode - 兼容旧参数（shooting_script/storyboard_script/script/其他）
 * @param {object} settings
 * @param {string} taskId
 * @param {object} options - { provider, model, autoAssignScene }
 */
async function generateFinalShots(scriptContent, mode, settings, taskId, options = {}) {
  // 复用 parseScript 的完整 prompt 和逻辑（mode='script' 走"已含分镜"分支）
  return await parseScript(scriptContent, mode || 'script', settings, taskId, options);
}

/**
 * 估算任务费用
 */
async function estimateCost(type, settings) {
  const prices = settings.model_prices || MODEL_PRICES;
  
  if (type === 'chat') {
    const model = settings.llm_model || 'deepseek-flash';
    const modelPrices = prices[model] || prices['deepseek-flash'] || { input: 0.001, output: 0.002 };
    // 假设平均每次调用消耗 1000 input + 500 output tokens
    return (modelPrices.input * 1) + (modelPrices.output * 0.5);
  }
  
  if (type === 'image') {
    const model = settings.image_model || 'gpt-image-2.5-flare';
    const quality = settings.image_quality || 'medium';
    return prices[model]?.['per_image_' + quality] || prices[model]?.[quality] || 0.08;
  }
  
  return 0;
}

/**
 * 从视频中提取第一帧作为图片
 */
async function extractVideoFrame(videoUrl, time = 0) {
  // P3-6：增加 30s 超时保护，避免 ffmpeg 卡死导致 AI 分析任务挂起
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('提取视频帧超时（30s）'));
    }, 30000);

    ffmpeg(videoUrl)
      .seek(time)
      .frames(1)
      .format('image2pipe')
      .videoCodec('mjpeg')
      .on('data', (chunk) => {
        chunks.push(chunk);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const buffer = Buffer.concat(chunks);
        console.log(`[aiClient] 提取视频帧成功，buffer大小: ${buffer.length} bytes`);
        if (buffer.length < 100) {
          reject(new Error('提取的视频帧数据过小'));
          return;
        }
        const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
        console.log(`[aiClient] base64长度: ${base64.length} characters`);
        resolve(base64);
      })
      .on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        console.error('[aiClient] 提取视频帧失败:', err.message);
        reject(err);
      })
      .pipe();
  });
}

/**
 * 分析分镜画面图片，返回场景信息
 * 用于分镜卡片「AI分析」功能，调用支持视觉的 LLM
 */
async function analyzeShotImage(mediaUrl, mediaType, provider, model, settings) {
  const apiKey = getApiKey(provider, settings);
  const baseUrl = getBaseUrl(provider, settings);

  if (!apiKey) {
    throw new Error(`${provider} API Key 未配置，请在设置中配置`);
  }

  let base64Image = null;
  try {
    if (mediaType === 'video') {
      base64Image = await extractVideoFrame(mediaUrl);
    } else {
      const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(30000) });
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        // 从 Content-Type 头获取实际 MIME 类型，回退到 image/jpeg
        const mimeType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
        base64Image = `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
      }
    }
  } catch (e) {
    console.warn('[aiClient] 下载/提取画面失败:', e.message);
  }

  if (!base64Image) {
    throw new Error('无法获取画面图片');
  }

  const prompt = `分析这张影视画面，提取以下信息并以JSON格式返回（不要markdown代码块，直接返回纯JSON）：
{
  "sceneContent": "画面内容描述（简洁中文）",
  "location": "拍摄地点（如：咖啡馆、街道、办公室）",
  "actors": "出场演员/角色（无则留空）",
  "costume": "演员服饰（无则留空）",
  "props": "可见道具（无则留空）",
  "shotType": "景别，必须从以下选择：大远景、远景、全景、中景、中近景、近景、特写、大特写",
  "focalLength": "建议焦段（格式为数字mm，如35mm、50mm、85mm，不要返回描述词）",
  "shotAngle": "拍摄角度，必须从以下选择：平拍、俯拍、仰拍、正拍、侧拍、反打、鸟瞰、主观视角、客观视角",
  "lighting": "灯光描述（如：自然光、暖色调、侧光）",
  "cameraMovement": "镜头运动，必须从以下选择：固定、推、拉、摇、移、跟、升降、旋转、环绕、变焦、手持、甩",
  "aiImagePrompt": "基于画面内容生成英文AI图像生成提示词，包含场景、人物、服饰、道具、光线、构图等关键要素，用于复现该画面"
}
注意：不要返回estimatedDuration（时长）、notes（备注）、narration（旁白）字段，单帧画面无法可靠判断这些信息。只返回JSON，不要其他文字。`;

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: base64Image } }
      ]
    }
  ];

  console.log(`[aiClient] 使用 ${provider}/${model} 分析分镜画面`);

  // P4-5 扩展（问题 C）：抽出单次调用，外层包重试逻辑（仅对 5xx/超时/ECONNRESET 重试 1 次，4xx 不重试）
  const callOnce = async () => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 8192,
        stream: false,
        response_format: { type: "json_object" }
      }),
      signal: AbortSignal.timeout(120000)
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`HTTP ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    const usage = data.usage || {};
    const content = data.choices[0].message.content;

    // 记录费用
    await recordUsage({
      type: 'chat',
      model,
      provider,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || usage.totalTokens || 0
    }, settings);

    // 解析 JSON 内容
    let result;
    try {
      // 去除可能的 markdown 代码块标记
      const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      result = JSON.parse(cleanContent);
    } catch (e) {
      console.warn('[aiClient] 解析分析结果JSON失败，返回原始内容:', content.substring(0, 200));
      throw new Error('分析结果格式异常，无法解析');
    }

    return result;
  };

  try {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callOnce();
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && isRetryableError(err)) {
          console.warn(`[aiClient] ${provider}/${model} 分析画面失败（${err.message}），1 秒后重试...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } catch (err) {
    console.error(`[aiClient] 分析分镜画面失败: ${err.message}`);
    throw err;
  }
}

/**
 * P4-5 扩展：带重试的文生图（仅对 5xx/超时/ECONNRESET 重试 1 次，4xx 不重试）
 * 与 parseScript 一致策略，不做多模型降级链（图片生成成本高）
 */
async function callImageGenWithRetry(model, prompt, quality, size, baseUrl, apiKey) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callImageGen(model, prompt, quality, size, baseUrl, apiKey);
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isRetryableError(err)) {
        console.warn(`[aiClient] ${model} 文生图失败（${err.message}），1 秒后重试...`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * P4-5 扩展：带重试的图生图（仅对 5xx/超时/ECONNRESET 重试 1 次，4xx 不重试）
 */
async function callImageGenWithRefWithRetry(model, prompt, refImageUrls, quality, size, baseUrl, apiKey) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callImageGenWithRef(model, prompt, refImageUrls, quality, size, baseUrl, apiKey);
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isRetryableError(err)) {
        console.warn(`[aiClient] ${model} 图生图失败（${err.message}），1 秒后重试...`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

module.exports = {
  callChatWithFallback,
  callImageWithFallback,
  callImageGen,
  callImageGenWithRef,
  callImageGenWithRetry,
  callImageGenWithRefWithRetry,
  analyzeSceneImage,
  analyzeShotImage,
  parseScript,
  // P5-1 新增：AI 自动生成分镜相关函数
  callLLMDirect,
  analyzeScriptType,
  generateVideoCopy,
  generateSceneDivision,
  generateStoryboardScript,
  generateShootingScript,
  generateFinalShots,
  estimateCost,
  calculateCost,
  recordUsage,
  friendlyAiError,
  isRetryableError,
  getApiKey,
  getBaseUrl,
  MODEL_PRICES
};
