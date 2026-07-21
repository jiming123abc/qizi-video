const crypto = require('crypto');

const VIDEORECOG_ENDPOINT = 'https://videorecog.cn-shanghai.aliyuncs.com/';
const VIDEORECOG_VERSION = '2020-03-20';
const VIDEORECOG_REGION = 'cn-shanghai';

const MPS_ENDPOINT = 'https://mts.cn-beijing.aliyuncs.com/';
const MPS_REGION = 'cn-beijing';
const MPS_VERSION = '2014-06-18';

function getAliyunCredentials() {
  return {
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID || process.env.ALIYUN_ACCESS_KEY_ID_DEV || process.env.OSS_ACCESS_KEY_ID || process.env.OSS_ACCESS_KEY_ID_DEV,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET || process.env.ALIYUN_ACCESS_KEY_SECRET_DEV || process.env.OSS_ACCESS_KEY_SECRET || process.env.OSS_ACCESS_KEY_SECRET_DEV,
    ossBucket: process.env.OSS_BUCKET || process.env.OSS_BUCKET_DEV,
    ossRegion: process.env.OSS_REGION || process.env.OSS_REGION_DEV,
    mpsPipelineId: process.env.MPS_PIPELINE_ID || process.env.MPS_PIPELINE_ID_DEV || ''
  };
}

function isAliyunConfigured() {
  const creds = getAliyunCredentials();
  return !!(creds.accessKeyId && creds.accessKeySecret && 
    creds.accessKeyId !== '你的OSS AccessKey ID' &&
    creds.accessKeySecret !== '你的OSS AccessKey Secret');
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function generateSignature(accessKeySecret, method, params) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalizedQueryString = sortedKeys.map(key => {
    return `${percentEncode(key)}=${percentEncode(params[key])}`;
  }).join('&');
  
  const stringToSign = `${method.toUpperCase()}&${percentEncode('/')}&${percentEncode(canonicalizedQueryString)}`;
  
  const signature = crypto
    .createHmac('sha1', accessKeySecret + '&')
    .update(stringToSign)
    .digest('base64');
  
  return signature;
}

async function callAliyunApi(action, params = {}, endpoint = VIDEORECOG_ENDPOINT) {
  const creds = getAliyunCredentials();
  if (!creds.accessKeyId || !creds.accessKeySecret) {
    throw new Error('阿里云 AccessKey 未配置');
  }

  const method = 'GET';
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const commonParams = {
    Action: action,
    Format: 'JSON',
    AccessKeyId: creds.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomBytes(8).toString('hex'),
    Timestamp: timestamp
  };

  // MPS API 需要 Version 参数
  if (endpoint === VIDEORECOG_ENDPOINT) {
    commonParams.Version = VIDEORECOG_VERSION;
  } else if (endpoint === MPS_ENDPOINT) {
    commonParams.Version = MPS_VERSION;
  }

  const allParams = { ...commonParams, ...params };
  const signature = generateSignature(creds.accessKeySecret, method, allParams);
  const finalParams = { ...allParams, Signature: signature };

  const queryString = Object.keys(finalParams).sort().map(key => {
    return `${percentEncode(key)}=${percentEncode(finalParams[key])}`;
  }).join('&');

  const url = `${endpoint}?${queryString}`;

  // 打印调试日志（敏感信息脱敏）
  if (endpoint === MPS_ENDPOINT) {
    const maskedParams = { ...finalParams };
    if (maskedParams.AccessKeyId) {
      maskedParams.AccessKeyId = maskedParams.AccessKeyId.substring(0, 4) + '***';
    }
    if (maskedParams.Signature) {
      maskedParams.Signature = '***';
    }
    console.log('[MPS] 调用 API:', action);
    console.log('[MPS] 请求参数（脱敏）:', JSON.stringify(maskedParams, null, 2));
    console.log('[MPS] URL 长度:', url.length);
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    // P3-5：HTTP 错误时必须抛错，不能仅依赖 result.Code
    if (!response.ok) {
      if (result.Code && result.Message) {
        throw new Error(`阿里云 API 错误: ${result.Code} - ${result.Message}`);
      }
      throw new Error(`阿里云 API HTTP 错误: ${response.status} ${response.statusText}`);
    }
    if (result.Code) {
      throw new Error(`阿里云 API 错误: ${result.Code} - ${result.Message || '未知错误'}`);
    }

    return result;
  } catch (error) {
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error(`网络错误，无法连接阿里云 API: ${error.message}`);
    }
    throw error;
  }
}

async function submitSplitVideoTask(videoUrl, options = {}) {
  const params = {
    VideoUrl: videoUrl
  };

  if (options.MinTime) params.MinTime = options.MinTime;
  if (options.MaxTime) params.MaxTime = options.MaxTime;
  if (options.Template) params.Template = options.Template;

  const result = await callAliyunApi('SplitVideoParts', params, VIDEORECOG_ENDPOINT);
  const data = result.Data || {};
  if (!data.JobId) {
    throw new Error('阿里云拆条任务提交失败：未返回 JobId');
  }
  return {
    requestId: result.RequestId,
    jobId: data.JobId,
    message: result.Message
  };
}

async function getSplitVideoResult(jobId) {
  const params = {
    JobId: jobId,
    Async: 'true'
  };

  const result = await callAliyunApi('GetAsyncJobResult', params, VIDEORECOG_ENDPOINT);

  const data = result.Data || {};
  const status = data.Status;

  let parsedResult = null;
  if (data.Result) {
    try {
      parsedResult = typeof data.Result === 'string'
        ? JSON.parse(data.Result)
        : data.Result;
    } catch (e) {
      parsedResult = data.Result;
    }
  }

  return {
    status: status,
    jobId: data.JobId,
    result: parsedResult,
    error: data.ErrorCode ? `${data.ErrorCode}: ${data.ErrorMessage}` : null
  };
}

async function splitVideo(videoUrl, options = {}) {
  const { jobId } = await submitSplitVideoTask(videoUrl, options);
  
  const maxWait = 10 * 60 * 1000;
  const pollInterval = 3000;
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWait) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    
    const result = await getSplitVideoResult(jobId);
    
    if (result.status === 'PROCESS_SUCCESS') {
      return parseSplitResult(result.result);
    }
    
    if (result.status === 'PROCESS_FAILED') {
      throw new Error(`视频拆条失败: ${result.error}`);
    }
  }
  
  throw new Error('视频拆条超时');
}

function parseSplitResult(result) {
  const shots = [];
  const themeSegments = [];

  if (result.Elements && Array.isArray(result.Elements)) {
    result.Elements.forEach((elem, index) => {
      shots.push({
        index: index + 1,
        beginTime: parseFloat(elem.BeginTime) || 0,
        endTime: parseFloat(elem.EndTime) || 0,
        type: 'shot',
        theme: ''
      });
    });
  }

  if (result.SplitVideoPartResults && Array.isArray(result.SplitVideoPartResults)) {
    result.SplitVideoPartResults.forEach((part, index) => {
      const segment = {
        index: index + 1,
        beginTime: parseFloat(part.BeginTime) || 0,
        endTime: parseFloat(part.EndTime) || 0,
        type: 'theme',
        theme: part.Theme || '',
        by: part.By || ''
      };
      themeSegments.push(segment);
      shots.push(segment);
    });
  }

  shots.sort((a, b) => a.beginTime - b.beginTime);

  return {
    shots: shots,
    shotCount: result.Elements ? result.Elements.length : 0,
    themeCount: result.SplitVideoPartResults ? result.SplitVideoPartResults.length : 0,
    themeSegments: themeSegments
  };
}

// ========== MPS 视频转码相关函数 ==========

/**
 * 获取 OSS 配置信息（用于 MPS 输出）
 */
function getOSSConfig() {
  const creds = getAliyunCredentials();
  const bucket = creds.ossBucket || process.env.OSS_BUCKET_DEV;
  const region = creds.ossRegion || process.env.OSS_REGION_DEV || 'oss-cn-beijing';

  // MPS API 的 Location 字段要求使用完整 region（带 oss- 前缀，如 oss-cn-beijing）
  return {
    bucket,
    location: region,
    region
  };
}

/**
 * 根据分辨率确定目标码率
 * @param {number} width 视频宽度
 * @param {number} height 视频高度
 * @returns {number} 目标码率（kbps）
 */
// 根据分辨率动态调整目标码率配置（默认值，可由外部配置覆盖）
const DEFAULT_BITRATE_CONFIG = {
  '1080p': 3000,  // 1080p 及以上
  '720p': 2000,    // 720p
  '480p': 1000     // 480p 及以下
};

// P2-3：注入 index.js 的 getTargetBitrate 函数，统一码率来源（读取数据库设置）
let _getTargetBitrateFn = null;
function setBitrateProvider(fn) {
  _getTargetBitrateFn = fn;
}

function getResolutionFromMaxRes(maxRes) {
  // 注意：此函数接收的 maxRes 应为短边（min(width, height)），与前端 getResolutionTier 一致
  if (maxRes >= 1080) return '1080p';
  if (maxRes >= 720) return '720p';
  if (maxRes >= 480) return '480p';
  return '480p';
}

// 根据分辨率和外部传入的码率配置确定目标码率
// P2-3：优先使用注入的 getTargetBitrate（读数据库），回退到 DEFAULT_BITRATE_CONFIG
async function determineBitrate(width, height, bitrateConfig = null) {
  // 分辨率判断使用短边（与前端 getResolutionTier 一致）
  const shortSide = Math.min(width || 0, height || 0) || Math.max(width || 0, height || 0);
  // 如果外部提供了静态配置，使用外部配置
  if (bitrateConfig) {
    const resolution = getResolutionFromMaxRes(shortSide);
    return bitrateConfig[resolution] || DEFAULT_BITRATE_CONFIG['480p'];
  }
  // 优先使用注入的数据库读取函数
  if (_getTargetBitrateFn) {
    try {
      return await _getTargetBitrateFn(width, height);
    } catch (e) {
      console.warn('[aliyunVideo] 注入的 getTargetBitrate 调用失败，回退默认值:', e.message);
    }
  }
  // 最终回退：使用默认配置
  const resolution = getResolutionFromMaxRes(shortSide);
  return DEFAULT_BITRATE_CONFIG[resolution] || DEFAULT_BITRATE_CONFIG['480p'];
}

// 统一的码率阈值判断：原始码率 > 目标码率时需要压缩
function shouldCompress(originalBitrateKbps, targetBitrateKbps) {
  return originalBitrateKbps > targetBitrateKbps;
}

/**
 * 生成转码输出 OSS URL
 * @param {string} inputObject 输入视频 OSS key
 * @param {string} templateId 转码模板 ID
 * @returns {string} 输出 OSS URL
 */
function generateOutputObject(inputObject, templateId) {
  // 从输入路径提取文件名（不含扩展名）
  const baseName = inputObject.replace(/\.[^.]+$/, '');
  // 输出文件名格式：原文件名_transcode_模板ID.mp4
  return `${baseName}_transcode_${templateId}.mp4`;
}

/**
 * 提交转码任务到阿里云 MPS
 * @param {string} videoUrl 视频 OSS URL
 * @param {object} options 转码选项
 * @returns {object} { jobId, requestId }
 */
async function submitTranscodeTask(videoUrl, options = {}) {
  const creds = getAliyunCredentials();
  const ossConfig = getOSSConfig();

  if (!creds.accessKeyId || !creds.accessKeySecret) {
    throw new Error('阿里云 AccessKey 未配置');
  }

  if (!ossConfig.bucket) {
    throw new Error('OSS Bucket 未配置');
  }

  // 从 URL 提取 OSS object key
  let inputObject = '';
  try {
    const urlObj = new URL(videoUrl);
    inputObject = decodeURIComponent(urlObj.pathname.replace(/^\//, ''));
  } catch (e) {
    // 如果不是完整 URL，尝试直接作为 key
    inputObject = videoUrl.replace(/^https?:\/\/[^\/]+\//, '');
  }

  // 确定目标码率
  const targetBitrate = options.targetBitrate || await determineBitrate(options.width || 1920, options.height || 1080);

  // 生成输出 object key
  const outputObject = options.outputObject || generateOutputObject(inputObject, 'custom');

  // 构建转码配置（JSON 格式）
  // P3-5：移除无效的 Inputs 字段（实际 Input 通过 params.Input 单独传递）
  // 注意：所有数值参数必须转为字符串，Codec 使用小写，与 MPS API 文档一致
  const transcodingConfig = {
    Outputs: [{
      OutputObject: outputObject,
      Container: {
        Format: 'mp4'
      },
      Video: {
        Codec: 'H.264',
        Bitrate: String(targetBitrate),
        // 与浏览器端压缩参数对齐（ABR 模式，无 CRF）：实际码率尽量接近目标码率
        Maxrate: String(targetBitrate),
        Bufsize: String(targetBitrate * 2),
        Width: String(options.width || 1280),
        Height: String(options.height || 720),
        Fps: String(30),
        Profile: 'High',
        Level: '4.1'
      },
      Audio: {
        Codec: 'aac',
        Bitrate: String(128),
        SampleRate: String(44100),
        Channels: String(2)
      }
    }],
    PipelineId: options.pipelineId || creds.mpsPipelineId || ''
  };

  // P3-5：未配置 PipelineId 时抛出明确错误，而非仅 warn 后继续（会导致 MPS 调用失败）
  if (!transcodingConfig.PipelineId) {
    console.error('[MPS] PipelineId 配置检查失败:');
    console.error('[MPS]   options.pipelineId:', options.pipelineId || '(未传入)');
    console.error('[MPS]   process.env.MPS_PIPELINE_ID:', process.env.MPS_PIPELINE_ID || '(未设置)');
    console.error('[MPS]   process.env.MPS_PIPELINE_ID_DEV:', process.env.MPS_PIPELINE_ID_DEV || '(未设置)');
    console.error('[MPS]   getAliyunCredentials().mpsPipelineId:', creds.mpsPipelineId || '(空)');
    throw new Error('未配置 MPS_PIPELINE_ID，请在 .env 文件中设置该环境变量');
  }

  const params = {
    Input: JSON.stringify({
      Location: ossConfig.location,
      Bucket: ossConfig.bucket,
      Object: percentEncode(inputObject)
    }),
    OutputBucket: ossConfig.bucket,
    OutputLocation: ossConfig.location,
    Outputs: JSON.stringify(transcodingConfig.Outputs.map(o => ({
      ...o,
      OutputObject: percentEncode(o.OutputObject)
    }))),
    PipelineId: transcodingConfig.PipelineId || ''
  };

  try {
    console.log('[MPS] ========== 提交转码任务 ==========');
    console.log('[MPS] Input（JSON 内部 Object 已编码）:', JSON.stringify({
      Location: ossConfig.location,
      Bucket: ossConfig.bucket,
      Object: percentEncode(inputObject)
    }));
    console.log('[MPS] Outputs（JSON 内部 OutputObject 已编码）:', JSON.stringify(transcodingConfig.Outputs.map(o => ({
      ...o,
      OutputObject: percentEncode(o.OutputObject)
    }))));
    console.log('[MPS] 原始 inputObject:', inputObject);
    console.log('[MPS] 原始 outputObject:', outputObject);
    console.log('[MPS] 编码后 inputObject:', percentEncode(inputObject));
    console.log('[MPS] 编码后 outputObject:', percentEncode(outputObject));
    console.log('[MPS] PipelineId:', transcodingConfig.PipelineId);
    console.log('[MPS] MPS Endpoint:', MPS_ENDPOINT);
    console.log('[MPS] ================================');

    const result = await callAliyunApi('SubmitJobs', params, MPS_ENDPOINT);

    console.log('[MPS] 提交转码任务响应:', JSON.stringify(result));

    if (result.JobResultList && result.JobResultList.JobResult) {
      const jobResult = result.JobResultList.JobResult[0];
      if (jobResult.Code && jobResult.Code !== 'Success') {
        throw new Error(`转码任务提交失败: ${jobResult.Code} - ${jobResult.Message}`);
      }

      return {
        jobId: jobResult.Job.JobId,
        requestId: result.RequestId,
        outputObject: outputObject
      };
    }

    throw new Error('转码任务提交返回格式异常');
  } catch (error) {
    console.error('[MPS] 提交转码任务失败:', error.message);
    console.error('[MPS] 失败详情:', error.stack || error);
    throw error;
  }
}

/**
 * 查询转码任务状态和结果
 * @param {string} jobId 转码任务 ID
 * @returns {object} { status, progress, outputUrl, error }
 */
async function getTranscodeResult(jobId) {
  const creds = getAliyunCredentials();
  const ossConfig = getOSSConfig();

  if (!creds.accessKeyId || !creds.accessKeySecret) {
    throw new Error('阿里云 AccessKey 未配置');
  }

  const params = {
    JobIds: jobId
  };

  try {
    const result = await callAliyunApi('QueryJobList', params, MPS_ENDPOINT);

    console.log('[MPS] QueryJobList 原始响应:', JSON.stringify(result));

    if (result.JobList && result.JobList.Job) {
      const job = result.JobList.Job[0];

      // MPS 任务状态映射
      let status = 'pending';
      if (job.State === 'Submitted') {
        status = 'pending';
      } else if (job.State === 'Transcoding') {
        status = 'processing';
      } else if (job.State === 'TranscodeSuccess') {
        status = 'done';
      } else if (job.State === 'TranscodeFail') {
        status = 'error';
      }

      let outputUrl = null;
      let error = null;

      if (job.State === 'TranscodeSuccess' && job.Output) {
        const output = job.Output;
        // MPS QueryJobList 返回的输出文件信息在 Output.OutputFile 下（含 Object/Bucket/Location）
        const outputFile = output.OutputFile || {};
        const outputObject = outputFile.Object;
        console.log('[MPS] 转码成功，OutputFile:', JSON.stringify(outputFile));
        console.log('[MPS] outputObject (原始):', outputObject);
        if (outputObject) {
          // 优先使用 OutputFile 中返回的 Bucket/Location 构造 URL（跨区域转码场景更准确）
          const outBucket = outputFile.Bucket || ossConfig.bucket;
          const outLocation = outputFile.Location || ossConfig.location;
          outputUrl = `https://${outBucket}.${outLocation}.aliyuncs.com/${outputObject}`;
          console.log('[MPS] 构造的 outputUrl:', outputUrl);
        }
      }

      if (job.State === 'TranscodeFail') {
        error = job.Code ? `${job.Code}: ${job.Message}` : '转码失败';
        console.error('[MPS] 转码失败:', error);
        console.error('[MPS] 失败详情 Job:', JSON.stringify(job));
      }

      return {
        status,
        progress: job.Percent || 0,
        outputUrl,
        outputObject: job.Output?.OutputFile?.Object,
        error
      };
    }

    throw new Error('转码任务查询返回格式异常');
  } catch (error) {
    console.error('[MPS] 查询转码任务失败:', error.message);
    throw error;
  }
}

module.exports = {
  getAliyunCredentials,
  isAliyunConfigured,
  submitSplitVideoTask,
  getSplitVideoResult,
  splitVideo,
  parseSplitResult,
  callAliyunApi,
  // MPS 转码相关
  submitTranscodeTask,
  getTranscodeResult,
  determineBitrate,
  getOSSConfig,
  // 统一码率配置
  DEFAULT_BITRATE_CONFIG,
  getResolutionFromMaxRes,
  shouldCompress,
  // P2-3：注入码率来源
  setBitrateProvider
};
