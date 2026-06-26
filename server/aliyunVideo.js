const crypto = require('crypto');

const VIDEORECOG_ENDPOINT = 'https://videorecog.cn-shanghai.aliyuncs.com/';
const VIDEORECOG_VERSION = '2020-03-20';
const VIDEORECOG_REGION = 'cn-shanghai';

const MPS_ENDPOINT = 'https://mts.cn-shanghai.aliyuncs.com/';
const MPS_REGION = 'cn-shanghai';

function getAliyunCredentials() {
  return {
    accessKeyId: process.env.OSS_ACCESS_KEY_ID || process.env.OSS_ACCESS_KEY_ID_DEV,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || process.env.OSS_ACCESS_KEY_SECRET_DEV,
    ossBucket: process.env.OSS_BUCKET || process.env.OSS_BUCKET_DEV,
    ossRegion: process.env.OSS_REGION || process.env.OSS_REGION_DEV
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

  // MPS API 不需要 Version 参数，VIDEORECOG API 需要
  if (endpoint === VIDEORECOG_ENDPOINT) {
    commonParams.Version = VIDEORECOG_VERSION;
  }

  const allParams = { ...commonParams, ...params };
  const signature = generateSignature(creds.accessKeySecret, method, allParams);
  const finalParams = { ...allParams, Signature: signature };

  const queryString = Object.keys(finalParams).sort().map(key => {
    return `${percentEncode(key)}=${percentEncode(finalParams[key])}`;
  }).join('&');

  const url = `${endpoint}?${queryString}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (!response.ok || result.Code) {
      if (result.Code && result.Message) {
        throw new Error(`阿里云 API 错误: ${result.Code} - ${result.Message}`);
      }
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

  return {
    requestId: result.RequestId,
    jobId: result.RequestId,
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

  // OSS location 格式：region 去掉 "oss-" 前缀
  const location = region.replace(/^oss-/, '');

  return {
    bucket,
    location,
    region
  };
}

/**
 * 根据分辨率确定目标码率
 * @param {number} width 视频宽度
 * @param {number} height 视频高度
 * @returns {number} 目标码率（kbps）
 */
function determineBitrate(width, height) {
  const maxRes = Math.max(width, height);

  if (maxRes >= 1080) {
    return 3000; // 1080p: 3000kbps
  } else if (maxRes >= 720) {
    return 2000; // 720p: 2000kbps
  } else {
    return 1000; // 480p/更低: 1000kbps
  }
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
  const targetBitrate = options.targetBitrate || determineBitrate(options.width || 1920, options.height || 1080);

  // 生成输出 object key
  const outputObject = options.outputObject || generateOutputObject(inputObject, 'custom');

  // 构建转码配置（JSON 格式）
  const transcodingConfig = {
    Inputs: [{
      Input: {
        Object: inputObject,
        Location: ossConfig.location,
        Bucket: ossConfig.bucket
      }
    }],
    Outputs: [{
      OutputObject: outputObject,
      Container: {
        Format: 'mp4'
      },
      Video: {
        Codec: 'H.264',
        Bitrate: targetBitrate,
        Width: options.width || 1280,
        Height: options.height || 720,
        Fps: 30,
        Profile: 'High',
        Level: '4.1'
      },
      Audio: {
        Codec: 'AAC',
        Bitrate: 128,
        SampleRate: 44100,
        Channels: 2
      }
    }],
    PipelineId: options.pipelineId || process.env.MPS_PIPELINE_ID || ''
  };

  // 如果没有配置管道 ID，使用默认管道（需要用户在阿里云控制台创建）
  if (!transcodingConfig.PipelineId) {
    console.warn('[MPS] 未配置 MPS_PIPELINE_ID，请在环境变量中设置或手动指定');
  }

  const params = {
    Input: JSON.stringify({
      Location: ossConfig.location,
      Bucket: ossConfig.bucket,
      Object: inputObject
    }),
    OutputBucket: ossConfig.bucket,
    OutputLocation: ossConfig.location,
    Outputs: JSON.stringify(transcodingConfig.Outputs),
    PipelineId: transcodingConfig.PipelineId || ''
  };

  try {
    const result = await callAliyunApi('SubmitJobs', params, MPS_ENDPOINT);

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
        // 构建输出 OSS URL
        outputUrl = `https://${ossConfig.bucket}.${ossConfig.region}.aliyuncs.com/${output.OutputObject}`;
      }

      if (job.State === 'TranscodeFail') {
        error = job.Code ? `${job.Code}: ${job.Message}` : '转码失败';
      }

      return {
        status,
        progress: job.Percent || 0,
        outputUrl,
        outputObject: job.Output?.OutputObject,
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
  getOSSConfig
};
