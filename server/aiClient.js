/**
 * AI 客户端封装
 * 支持 GeekAI 和 SiliconFlow 双平台，带降级链
 * 
 * API Base URLs:
 * - GeekAI: https://geekai.co/api/v1
 * - SiliconFlow: https://api.siliconflow.cn/v1
 */

const { video2Settings, video2AiUsage } = require('./database');

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
 */
function getApiKey(provider, settings) {
  if (provider === 'siliconflow') {
    return settings.siliconflow_api_key || process.env.SILICONFLOW_API_KEY;
  }
  return settings.geekai_api_key || process.env.GEEKAI_API_KEY;
}

/**
 * 获取 Base URL
 */
function getBaseUrl(provider) {
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
    const baseUrl = getBaseUrl(provider);
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
 */
async function callImageWithFallback(prompt, fallbackChain, settings, options = {}) {
  const { sceneImageUrl, size = '1024x576', taskId } = options;
  
  console.log(`[aiClient] 开始图片生成，降级链共 ${fallbackChain.length} 个模型，场景图: ${sceneImageUrl ? '有' : '无'}`);
  
  for (let i = 0; i < fallbackChain.length; i++) {
    const item = fallbackChain[i];
    const { model, quality = 'standard', provider, supportsImageRef } = item;
    const baseUrl = getBaseUrl(provider);
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
  let systemPrompt = '';
  
  if (mode === 'shooting_script' || mode === 'storyboard_script') {
    systemPrompt = `你是一个专业的影视分镜脚本分析师。
根据用户提供的拍摄脚本，将其拆解为分镜列表。
对每个分镜提取以下信息（如脚本中未提及则留空）：
- sceneContent: 画面内容描述
- actors: 出场演员/角色
- props: 需要的道具
- location: 拍摄地点
- focalLength: 建议的镜头焦段
- narration: 旁白或台词
- cameraMovement: 镜头运动方式
- shotType: 景别（远景/全景/中景/近景/特写）
- shotAngle: 拍摄角度
- lighting: 灯光要求
- notes: 其他备注
- estimatedDuration: 预估时长（秒数）
- aiImagePrompt: 英文的AI图像生成提示词
${autoAssignScene ? `- sceneName: 所属场次名称
  【重要规则】
  1. 如果脚本中有明确的场次划分标记（如"第一场/第二场"、"场景一/场景二"、"第1幕/第2幕"、"INT./EXT."、"内景/外景"等），必须严格按照脚本中的划分来，一个场次都不能合并或省略，场次名称使用脚本中的原始名称
  2. 如果脚本中没有明确的场次划分标记，则根据场景/地点/时间变化自动划分，此时遵循"宜少不宜多"原则，相同场景的分镜归为同一场次` : ''}

请以JSON数组格式返回，每个元素对应一个分镜。`;
  } else {
    systemPrompt = `你是一个专业的视频导演和分镜师。
用户将提供视频文案/旁白/策划案，请你先创作一份拍摄脚本，然后将其拆解为分镜列表。
对每个分镜提取以下信息：
- sceneContent: 画面内容描述
- actors: 出场演员/角色
- props: 需要的道具
- location: 拍摄地点
- focalLength: 建议的镜头焦段
- narration: 旁白或台词
- cameraMovement: 镜头运动方式
- shotType: 景别（远景/全景/中景/近景/特写）
- shotAngle: 拍摄角度
- lighting: 灯光要求
- notes: 其他备注
- estimatedDuration: 预估时长（秒数）
- aiImagePrompt: 英文的AI图像生成提示词
${autoAssignScene ? `- sceneName: 所属场次名称
  【重要规则】
  1. 如果脚本中有明确的场次划分标记（如"第一场/第二场"、"场景一/场景二"、"第1幕/第2幕"、"INT./EXT."、"内景/外景"等），必须严格按照脚本中的划分来，一个场次都不能合并或省略，场次名称使用脚本中的原始名称
  2. 如果脚本中没有明确的场次划分标记，则根据场景/地点/时间变化自动划分，此时遵循"宜少不宜多"原则，相同场景的分镜归为同一场次` : ''}

请以JSON数组格式返回。`;
  }
  
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: scriptContent }
  ];
  
  const chain = settings.llm_fallback_chain || [
    { model: 'deepseek-chat', provider: 'geekai', cost: 'low' },
    { model: 'gpt-4o-mini', provider: 'geekai', cost: 'low' },
    { model: 'glm-4-flash', provider: 'geekai', cost: 'free' }
  ];
  
  const result = await callChatWithFallback(messages, chain, settings, {
    temperature: 0.3,
    max_tokens: 8192,
    json: true,
    taskId
  });
  
  return result;
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

module.exports = {
  callChatWithFallback,
  callImageWithFallback,
  callImageGen,
  analyzeSceneImage,
  parseScript,
  estimateCost,
  calculateCost,
  MODEL_PRICES
};
