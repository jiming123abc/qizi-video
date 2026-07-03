/**
 * AI 客户端封装
 * 支持 GeekAI 和 SiliconFlow 双平台，带降级链
 * 
 * API Base URLs:
 * - GeekAI: https://geekai.co/api/v1
 * - SiliconFlow: https://api.siliconflow.cn/v1
 */

const { video2Settings, video2AiUsage } = require('./database');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

// ========== 常量定义 ==========
const GEEKAI_BASE = 'https://geekai.co/api/v1';
const SILICONFLOW_BASE = 'https://api.siliconflow.cn/v1';

// 模型费用（单位：元）
const MODEL_PRICES = {
  // 文本模型：元/千tokens
  'deepseek-chat': { input: 0.001, output: 0.002 },
  'gpt-4o-mini': { input: 0.01, output: 0.03 },
  'glm-4-flash': { input: 0, output: 0 },
  
  // 生图模型：元/张
  'gpt-image-2': { medium: 0.08 },
  'z-image-turbo': { standard: 0.02 },
  'nano-banana-2': { standard: 0.05 },
  'cogview-4': { standard: 0.05 },
};

// ========== 辅助函数 ==========

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
    
    await video2AiUsage.record({
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
 * 调用文生图 API
 */
async function callImageGen(model, prompt, quality, size, baseUrl, apiKey) {
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt,
      size: size || '1024x576',
      quality: quality || 'standard',
      watermark: false,
      n: 1,
      response_format: 'url'
    }),
    signal: AbortSignal.timeout(60000)
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
 * 调用图生图 API（如果有场景参考图）
 */
async function callImageGenWithRef(model, prompt, refImageUrl, quality, size, baseUrl, apiKey) {
  // 下载参考图片作为 base64
  let refImageBase64 = null;
  try {
    const refResponse = await fetch(refImageUrl);
    if (refResponse.ok) {
      const buffer = await refResponse.arrayBuffer();
      refImageBase64 = `data:image/jpeg;base64,${Buffer.from(buffer).toString('base64')}`;
    }
  } catch (e) {
    console.warn('[aiClient] 下载参考图失败，将使用文生图:', e.message);
    return callImageGen(model, prompt, quality, size, baseUrl, apiKey);
  }
  
  if (!refImageBase64) {
    return callImageGen(model, prompt, quality, size, baseUrl, apiKey);
  }
  
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt,
      size: size || '1024x576',
      quality: quality || 'standard',
      watermark: false,
      n: 1,
      response_format: 'url',
      image: refImageBase64
    }),
    signal: AbortSignal.timeout(60000)
  });
  
  if (!response.ok) {
    const errBody = await response.text();
    console.warn(`[aiClient] ${model} 图生图模式失败 (HTTP ${response.status})，降级到文生图: ${errBody.substring(0, 200)}`);
    return callImageGen(model, prompt, quality, size, baseUrl, apiKey);
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
    const { model, quality = 'standard', provider, supportsImageRef } = item;
    const baseUrl = getBaseUrl(provider, settings);
    const apiKey = getApiKey(provider, settings);
    
    if (!apiKey) {
      console.warn(`[aiClient] ${provider} API Key 未配置，跳过模型 ${model}`);
      continue;
    }
    
    console.log(`[aiClient] [${i + 1}/${fallbackChain.length}] 尝试模型 ${provider}/${model} (quality=${quality}, 图生图=${sceneImageUrl && supportsImageRef ? '是' : '否'})`);
    
    try {
      let result;
      
      if (sceneImageUrl && supportsImageRef) {
        result = await callImageGenWithRef(model, prompt, sceneImageUrl, quality, size, baseUrl, apiKey);
      } else if (sceneImageUrl && !supportsImageRef) {
        const sceneDesc = await analyzeSceneImage(sceneImageUrl, settings, taskId);
        const enhancedPrompt = `${sceneDesc}, ${prompt}`;
        result = await callImageGen(model, enhancedPrompt, quality, size, baseUrl, apiKey);
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
    const response = await fetch(imageUrl);
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      base64Image = `data:image/jpeg;base64,${Buffer.from(buffer).toString('base64')}`;
    }
  } catch (e) {
    console.warn('[aiClient] 下载场景图失败:', e.message);
    return '';
  }
  
  if (!base64Image) return '';
  
  // 获取默认的文本模型
  const defaultChain = settings.llm_fallback_chain || [
    { model: 'deepseek-chat', provider: 'geekai' }
  ];
  
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
 */
async function parseScript(scriptContent, mode, settings, taskId, options = {}) {
  const autoAssignScene = options.autoAssignScene !== false;
  const provider = options.provider || 'geekai';
  const model = options.model || 'deepseek-chat';

  let systemPrompt = '';

  if (mode === 'shooting_script' || mode === 'storyboard_script' || mode === 'script') {
    systemPrompt = `你是一个专业的影视分镜脚本分析师。
根据用户提供的拍摄脚本或分镜脚本，将其拆解为分镜列表。

【分镜粒度原则 - 重要】
1. 每个分镜**不包含镜头切换**，即一个分镜只对应一个连续的画面
2. 如果用户上传的是分镜脚本或拍摄脚本，**严格遵循脚本中标注的分镜数量**，不要合并或拆分
3. 文档中缺少的信息项根据上下文自动补全（如景别、镜头运动等）

对每个分镜提取以下信息：
- sceneContent: 画面内容描述
- actors: 出场演员/角色
- costume: 演员服饰/服装
- props: 需要的道具
- location: 拍摄地点
- focalLength: 建议的镜头焦段
- narration: 旁白或台词
- cameraMovement: 镜头运动方式（必须从以下选择：固定、推、拉、摇、移、跟、升降、旋转、环绕、变焦、手持、甩）
- shotType: 景别（必须从以下选择：大远景、远景、全景、中景、中近景、近景、特写、大特写）
- shotAngle: 拍摄角度（必须从以下选择：平拍、俯拍、仰拍、正拍、侧拍、反打、鸟瞰、主观视角、客观视角）
- lighting: 灯光要求
- notes: 其他备注
- estimatedDuration: 预估时长（秒数）
- aiImagePrompt: 英文的AI图像生成提示词
- hasShotCut: 布尔值，该分镜是否包含镜头切换（如脚本中描述"镜头从A切到B"）
- isStockOrEffect: 布尔值，该分镜是否为素材镜头或特效镜头（不需要实际拍摄，如"空镜素材"、"转场特效"、"字幕动画"等）
${autoAssignScene ? `- sceneName: 所属场次名称
  【场次划分规则】
  1. 如果脚本中有明确的场次划分标记（如"第一场/第二场"、"场景一/场景二"、"第1幕/第2幕"、"INT./EXT."、"内景/外景"等），必须严格按照脚本中的划分来，一个场次都不能合并或省略，场次名称使用脚本中的原始名称
  2. 如果脚本中没有明确的场次划分标记，则根据场景/地点/时间变化自动划分，遵循"宜少不宜多"原则` : ''}

【数字资产提取 - 重要】
除分镜列表外，还需要提取以下数字资产信息（用于后续生成参考图）：
- mainActors: 主要角色数组，每项包含 { name: 角色名称, imagePrompt: 英文AI生图提示词 }
- keyProps: 关键道具数组，每项包含 { name: 道具名称, imagePrompt: 英文AI生图提示词 }
- mainScenes: 主要场景数组，每项包含 { name: 场景名称, imagePrompt: 英文AI生图提示词 }

请以JSON对象格式返回，包含两个字段：
{
  "shots": [分镜数组],
  "digitalAssets": {
    "mainActors": [角色数组],
    "keyProps": [道具数组],
    "mainScenes": [场景数组]
  }
}`;
  } else {
    systemPrompt = `你是一个专业的视频导演和分镜师。
用户将提供视频文案/旁白/策划案，请你先创作一份拍摄脚本，然后将其拆解为分镜列表。

【分镜粒度原则 - 重要】
1. 每个分镜**不包含镜头切换**，即一个分镜只对应一个连续的画面
2. 根据文案内容合理划分分镜数量，每个分镜对应一个独立的画面
3. 文档中缺少的信息项根据上下文自动补全

对每个分镜提取以下信息：
- sceneContent: 画面内容描述
- actors: 出场演员/角色
- costume: 演员服饰/服装
- props: 需要的道具
- location: 拍摄地点
- focalLength: 建议的镜头焦段
- narration: 旁白或台词
- cameraMovement: 镜头运动方式（必须从以下选择：固定、推、拉、摇、移、跟、升降、旋转、环绕、变焦、手持、甩）
- shotType: 景别（必须从以下选择：大远景、远景、全景、中景、中近景、近景、特写、大特写）
- shotAngle: 拍摄角度（必须从以下选择：平拍、俯拍、仰拍、正拍、侧拍、反打、鸟瞰、主观视角、客观视角）
- lighting: 灯光要求
- notes: 其他备注
- estimatedDuration: 预估时长（秒数）
- aiImagePrompt: 英文的AI图像生成提示词
- hasShotCut: 布尔值，该分镜是否包含镜头切换（如描述中涉及画面切换）
- isStockOrEffect: 布尔值，该分镜是否为素材镜头或特效镜头（不需要实际拍摄，如"空镜素材"、"转场特效"、"字幕动画"等）
${autoAssignScene ? `- sceneName: 所属场次名称
  【场次划分规则】
  1. 根据场景/地点/时间变化自动划分场次，遵循"宜少不宜多"原则` : ''}

【数字资产提取 - 重要】
除分镜列表外，还需要提取以下数字资产信息（用于后续生成参考图）：
- mainActors: 主要角色数组，每项包含 { name: 角色名称, imagePrompt: 英文AI生图提示词 }
- keyProps: 关键道具数组，每项包含 { name: 道具名称, imagePrompt: 英文AI生图提示词 }
- mainScenes: 主要场景数组，每项包含 { name: 场景名称, imagePrompt: 英文AI生图提示词 }

请以JSON对象格式返回，包含两个字段：
{
  "shots": [分镜数组],
  "digitalAssets": {
    "mainActors": [角色数组],
    "keyProps": [道具数组],
    "mainScenes": [场景数组]
  }
}`;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: scriptContent }
  ];

  // 直接使用传入的 provider/model，不使用降级链
  const baseUrl = getBaseUrl(provider, settings);
  const apiKey = getApiKey(provider, settings);

  if (!apiKey) {
    throw new Error(`${provider} API Key 未配置，请检查环境变量或数据库设置`);
  }

  console.log(`[aiClient] 使用模型 ${provider}/${model} 解析脚本`);

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

    // 记录费用
    await recordUsage({
      type: 'chat',
      model,
      provider,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || usage.totalTokens || 0,
      taskId
    }, settings);

    return {
      model,
      provider,
      content: data.choices[0].message.content,
      usage
    };
  } catch (err) {
    console.error(`[aiClient] ${provider}/${model} 调用失败: ${err.message}`);
    throw err;
  }
}

/**
 * 估算任务费用
 */
async function estimateCost(type, settings) {
  const prices = settings.model_prices || MODEL_PRICES;
  
  if (type === 'chat') {
    const model = settings.llm_model || 'deepseek-chat';
    const modelPrices = prices[model] || prices['deepseek-chat'];
    // 假设平均每次调用消耗 1000 input + 500 output tokens
    return (modelPrices.input * 1) + (modelPrices.output * 0.5);
  }
  
  if (type === 'image') {
    const model = settings.image_model || 'gpt-image-2';
    const quality = settings.image_quality || 'medium';
    return prices[model]?.[quality] || 0.08;
  }
  
  return 0;
}

/**
 * 从视频中提取第一帧作为图片
 */
async function extractVideoFrame(videoUrl, time = 0) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    ffmpeg(videoUrl)
      .seek(time)
      .frames(1)
      .format('image2pipe')
      .videoCodec('mjpeg')
      .on('data', (chunk) => {
        chunks.push(chunk);
      })
      .on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
        resolve(base64);
      })
      .on('error', (err) => {
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
      const response = await fetch(mediaUrl);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        base64Image = `data:image/jpeg;base64,${Buffer.from(buffer).toString('base64')}`;
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
  "focalLength": "建议焦段（如：35mm、50mm、85mm）",
  "shotAngle": "拍摄角度，必须从以下选择：平拍、俯拍、仰拍、正拍、侧拍、反打、鸟瞰、主观视角、客观视角",
  "lighting": "灯光描述（如：自然光、暖色调、侧光）",
  "cameraMovement": "镜头运动，必须从以下选择：固定、推、拉、摇、移、跟、升降、旋转、环绕、变焦、手持、甩"
}
只返回JSON，不要其他文字。`;

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
  } catch (err) {
    console.error(`[aiClient] 分析分镜画面失败: ${err.message}`);
    throw err;
  }
}

module.exports = {
  callChatWithFallback,
  callImageWithFallback,
  callImageGen,
  callImageGenWithRef,
  analyzeSceneImage,
  analyzeShotImage,
  parseScript,
  estimateCost,
  calculateCost,
  recordUsage,
  getApiKey,
  getBaseUrl,
  MODEL_PRICES
};
