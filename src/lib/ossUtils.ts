const FILE_SIZE_LIMITS = {
  image: 20 * 1024 * 1024,
  video: 1024 * 1024 * 1024
};

const CLOUDFLARE_MAX_MB = 95;

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const ALLOWED_MIME_TYPES = {
  image: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']
};

function validateFileSize(file: File, type: 'image' | 'video'): { valid: boolean; maxSizeMB: number } {
  const maxSize = FILE_SIZE_LIMITS[type];
  return {
    valid: file.size <= maxSize,
    maxSizeMB: maxSize / (1024 * 1024)
  };
}

function validateFileType(file: File, type: 'image' | 'video'): boolean {
  return ALLOWED_MIME_TYPES[type].includes(file.type);
}

const API_BASE_URL = import.meta.env.DEV
  ? ''
  : (import.meta.env.VITE_API_URL || '');

export function getVideoPoster(url: string): string {
  if (url && (url.includes('aliyuncs.com') || url.includes('qiziwenhua.top'))) {
    return url + '?x-oss-process=video/snapshot,t_1000,f_jpg,w_800,m_fast';
  }
  return '';
}

// ================ 签名 URL 缓存（1小时有效期） ================
const signUrlCache = new Map<string, { url: string; expires: number }>();

// 签名 URL 更新订阅（pub-sub，替代轮询）
const signUrlSubscribers = new Set<(urls: string[]) => void>();

/** 订阅签名 URL 缓存更新，返回取消订阅函数 */
export function subscribeSignUrlUpdate(cb: (urls: string[]) => void): () => void {
  signUrlSubscribers.add(cb);
  return () => { signUrlSubscribers.delete(cb); };
}

/** 通知订阅者指定 URL 的签名已更新 */
function notifySignUrlUpdate(updatedUrls: string[]): void {
  if (updatedUrls.length === 0) return;
  signUrlSubscribers.forEach(cb => {
    try { cb(updatedUrls); } catch (e) { /* 忽略订阅者错误 */ }
  });
}

export async function getSignedOssUrl(ossUrl: string): Promise<string> {
  if (!ossUrl) return ossUrl;
  if (ossUrl.startsWith('data:')) return ossUrl;
  if (ossUrl.startsWith('/uploads/')) return ossUrl;
  if (ossUrl.startsWith('/api/')) return ossUrl;

  // 检查缓存
  const cached = signUrlCache.get(ossUrl);
  if (cached && cached.expires > Date.now()) {
    return cached.url;
  }

  // 调用服务端签名接口
  const res = await fetch(
    `${API_BASE_URL}/api/oss-sign-url?url=${encodeURIComponent(ossUrl)}`
  );
  if (!res.ok) {
    console.error('[oss] 获取签名 URL 失败，使用原始 URL:', ossUrl);
    return ossUrl;
  }
  const { signedUrl } = await res.json();

  // 缓存 50 分钟（1小时有效期提前刷新）
  signUrlCache.set(ossUrl, { url: signedUrl, expires: Date.now() + 50 * 60 * 1000 });
  notifySignUrlUpdate([ossUrl]);
  return signedUrl;
}

// 批量获取签名 URL（分批请求，避免 GET URL 过长导致 414；失败批次自动重试）
export async function batchGetSignedUrls(urls: string[]): Promise<void> {
  // 过滤出需要签名的 URL（排除缓存命中和非 OSS URL）
  const toSign = urls.filter(u => {
    if (!u || u.startsWith('data:') || u.startsWith('/uploads/') || u.startsWith('/api/')) return false;
    const cached = signUrlCache.get(u);
    return !cached || cached.expires <= Date.now();
  });

  if (toSign.length === 0) return;

  // 分批处理，避免 GET 请求 query string 过长导致 414
  const BATCH_SIZE = 5;
  const MAX_RETRIES = 2;
  const now = Date.now();

  for (let i = 0; i < toSign.length; i += BATCH_SIZE) {
    const batch = toSign.slice(i, i + BATCH_SIZE);
    let success = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const params = batch.map(u => `urls=${encodeURIComponent(u)}`).join('&');
        const res = await fetch(`${API_BASE_URL}/api/oss-sign-urls?${params}`);
        if (!res.ok) {
          console.warn(`[oss] 批量签名请求失败 (batch ${i / BATCH_SIZE + 1}, attempt ${attempt + 1}):`, res.status, res.statusText);
          if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          break;
        }

        const { signedUrls } = await res.json();
        const updated: string[] = [];
        for (const [origUrl, signedUrl] of Object.entries(signedUrls)) {
          signUrlCache.set(origUrl, { url: signedUrl as string, expires: now + 50 * 60 * 1000 });
          updated.push(origUrl);
        }
        if (updated.length > 0) notifySignUrlUpdate(updated);
        success = true;
        break;
      } catch (e) {
        console.error(`[oss] 批量签名失败 (batch ${i / BATCH_SIZE + 1}, attempt ${attempt + 1}):`, e);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        break;
      }
    }

    if (!success) {
      console.warn(`[oss] 批量签名最终失败，跳过 batch ${i / BATCH_SIZE + 1}，共 ${batch.length} 个 URL`);
    }
  }
}

// 从缓存获取签名 URL（同步，立即返回）
export function getSignedUrlFromCache(ossUrl: string): string {
  if (!ossUrl) return ossUrl;
  if (ossUrl.startsWith('data:')) return ossUrl;
  if (ossUrl.startsWith('/uploads/')) return ossUrl;
  if (ossUrl.startsWith('/api/')) return ossUrl;

  const cached = signUrlCache.get(ossUrl);
  if (cached && cached.expires > Date.now()) {
    return cached.url;
  }
  return ossUrl; // 未缓存时返回原始 URL
}

// ================ OSS 直传凭证 ================
export interface OssUploadCredential {
  host: string;
  accessKeyId: string;
  policy: string;
  signature: string;
  key: string;
  bucket: string;
  region: string;
}

export async function getOssUploadCredential(
  projectId: number,
  filename: string,
  type: 'image' | 'video',
  usage?: string
): Promise<OssUploadCredential> {
  let url = `${API_BASE_URL}/api/oss-upload-credential?projectId=${projectId}&filename=${encodeURIComponent(filename)}&type=${type}`;
  if (usage) {
    url += `&usage=${usage}`;
  }
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '获取上传凭证失败' }));
    throw new Error(err.error || '获取上传凭证失败');
  }
  return res.json();
}

// 直传文件到 OSS（使用服务端生成的凭证）
export async function uploadDirectToOss(
  file: File,
  credential: OssUploadCredential,
  onProgress?: (progress: UploadProgress) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', credential.host);

    const formData = new FormData();
    formData.append('key', credential.key);
    formData.append('OSSAccessKeyId', credential.accessKeyId);
    formData.append('policy', credential.policy);
    formData.append('signature', credential.signature);
    formData.append('file', file);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        onProgress?.({ phase: 'uploading', progress: pct, message: `上传中... ${pct}%` });
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.({ phase: 'done', progress: 100, message: '上传完成' });
        // 返回 OSS 文件 URL
        const fileUrl = `https://${credential.bucket}.oss-${credential.region}.aliyuncs.com/${credential.key}`;
        resolve(fileUrl);
      } else {
        reject(new Error(`OSS 上传失败: HTTP ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('网络错误')));
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')));

    xhr.send(formData);
  });
}

export interface UploadProgress {
  phase: 'idle' | 'checking' | 'compressing' | 'uploading' | 'done';
  progress: number;
  message: string;
}

export interface UploadResult {
  url: string;
  compressed: boolean;
  compressionFailed?: boolean;
  originalSizeKB?: number;
  compressedSizeKB?: number;
  originalBitrate?: number;
  targetBitrate?: number;
  duration?: number;
}

export interface UploadError extends Error {
  ossError?: boolean;
  message: string;
}

export type UploadDecision = {
  decision: 'direct_upload' | 'must_compress';
  compressionMethod: 'server' | 'browser' | 'aliyun' | null;
  bitrateKbps: number | null;
  targetBitrateKbps: number;
  duration: number | null;
  resolution?: '1080p' | '720p' | '480p';
  width?: number;
  height?: number;
  fileSizeMB: string;
  fileSizeMBNum: number;
};
export async function checkVideoBitrate(file: File): Promise<UploadDecision> {
  const fileSizeMBNum = file.size / 1024 / 1024;
  const fileSizeMB = fileSizeMBNum.toFixed(2);

  const { estimateVideoBitrate, getTargetBitrateAsync, needsCompressionAsync } = await import('./videoCompressor');
  const result = await estimateVideoBitrate(file);

  // 使用异步版本从 API 获取目标码率
  const targetBitrateKbps = await getTargetBitrateAsync(result.resolution || '480p');

  // 使用异步版本判断是否需要压缩
  if (result.bitrateKbps === null || !await needsCompressionAsync(result.bitrateKbps, result.resolution || '480p')) {
    return {
      decision: 'direct_upload',
      compressionMethod: null,
      bitrateKbps: result.bitrateKbps,
      targetBitrateKbps,
      duration: result.duration,
      resolution: result.resolution,
      width: result.width,
      height: result.height,
      fileSizeMB,
      fileSizeMBNum,
    };
  }

  const compressionMethod: 'server' | 'browser' = fileSizeMBNum <= CLOUDFLARE_MAX_MB ? 'server' : 'browser';

  return {
    decision: 'must_compress',
    compressionMethod,
    bitrateKbps: result.bitrateKbps,
    targetBitrateKbps,
    duration: result.duration,
    resolution: result.resolution,
    width: result.width,
    height: result.height,
    fileSizeMB,
    fileSizeMBNum,
  };
}

// 轮询函数
async function pollTaskStatus(
  taskId: string,
  onProgress?: (progress: UploadProgress) => void
): Promise<any> {
  let attempts = 0;
  const maxAttempts = 360; // 最多10分钟 (360 * 2秒)

  while (attempts < maxAttempts) {
    const res = await fetch(`${API_BASE_URL}/api/upload/video/status/${taskId}`);
    if (!res.ok) {
      throw new Error('获取任务状态失败');
    }
    const task = await res.json();

    if (task.status === 'completed') {
      return task.result;
    }
    if (task.status === 'failed') {
      const err: UploadError = new Error(task.error || '任务失败');
      err.ossError = task.ossError === true;
      throw err;
    }

    // 更新进度
    const phase: any = task.progress < 50 ? 'compressing' : (task.progress < 100 ? 'uploading' : 'done');
    const progress = task.progress;
    const message = task.message || '处理中...';
    onProgress?.({ phase, progress, message });

    attempts++;
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒轮询一次
  }

  throw new Error('任务超时');
}

// 上传到服务器进行压缩（高码率视频，异步轮询模式）
export async function uploadVideoToServerWithCompression(
  file: File,
  onProgress?: (progress: UploadProgress) => void,
  forceLocal: boolean = false
): Promise<UploadResult> {
  if (!validateFileType(file, 'video')) {
    throw new Error('不支持的视频格式，请上传 MP4、WebM、OGG 或 MOV 格式');
  }

  const sizeValidation = validateFileSize(file, 'video');
  if (!sizeValidation.valid) {
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
    throw new Error(`视频大小不能超过 ${sizeValidation.maxSizeMB}MB，当前文件大小: ${fileSizeMB}MB`);
  }

  const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
  onProgress?.({ phase: 'compressing', progress: 0, message: `正在上传视频至服务器进行压缩 (${fileSizeMB}MB)...` });

  // 第一步：上传文件获取 taskId
  const formData = new FormData();
  formData.append('file', file);

  const url = new URL(`${API_BASE_URL}/api/upload/video`);
  url.searchParams.set('compress', 'true');
  if (forceLocal) {
    url.searchParams.set('forceLocal', 'true');
  }

  const uploadRes = await fetch(url.toString(), {
    method: 'POST',
    body: formData
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({ error: '上传失败' }));
    const uploadError: UploadError = new Error(err.message || err.error || '上传失败');
    uploadError.ossError = err.ossError === true;
    throw uploadError;
  }

  const { taskId } = await uploadRes.json();

  // 第二步：轮询任务状态
  onProgress?.({ phase: 'compressing', progress: 5, message: '文件上传完成，等待处理...' });
  const result = await pollTaskStatus(taskId, onProgress);

  const compressionFailed = result.compressionFailed === true;
  const compressed = result.compressed === true;

  if (compressionFailed) {
    onProgress?.({ phase: 'done', progress: 100, message: '压缩未成功，已上传原始视频' });
  } else if (compressed) {
    const origMB = (result.originalSizeKB / 1024).toFixed(2);
    const compMB = (result.compressedSizeKB / 1024).toFixed(2);
    onProgress?.({ phase: 'done', progress: 100, message: `视频压缩上传完成\n大小: ${origMB}MB -> ${compMB}MB` });
  } else {
    onProgress?.({ phase: 'done', progress: 100, message: `视频上传完成\n大小: ${fileSizeMB}MB（无需压缩）` });
  }

  return {
    url: result.url,
    compressed,
    compressionFailed,
    originalSizeKB: result.originalSizeKB,
    compressedSizeKB: result.compressedSizeKB,
  };
}

// ================ 上传函数 ================

// 图片上传到 images 文件夹（通过后端 API 自动压缩）
export async function uploadImage(
  file: File,
  options?: {
    projectId?: number;
    sceneId?: number;
    usage?: string;
    title?: string;
    createShot?: boolean;
    onProgress?: (p: UploadProgress) => void;
    signal?: AbortSignal;
  }
): Promise<UploadResult & { id?: number; filename?: string; ossKey?: string }> {
  // 前端大小校验（与后端一致：20MB 上限）
  const sizeValidation = validateFileSize(file, 'image');
  if (!sizeValidation.valid) {
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
    throw new Error(`图片大小不能超过 ${sizeValidation.maxSizeMB}MB，当前文件大小: ${fileSizeMB}MB`);
  }

  options?.onProgress?.({ phase: 'uploading', progress: 10, message: '上传图片中...' });

  const formData = new FormData();
  formData.append('file', file);
  if (options?.projectId) formData.append('projectId', String(options.projectId));
  if (options?.sceneId) formData.append('sceneId', String(options.sceneId));
  if (options?.usage) formData.append('usage', options.usage);
  if (options?.title) formData.append('title', options.title);
  if (options?.createShot) formData.append('createShot', '1');

  try {
    const response = await fetch(`${API_BASE_URL}/api/upload/image`, {
      method: 'POST',
      body: formData,
      signal: options?.signal
    });

    options?.onProgress?.({ phase: 'uploading', progress: 80, message: '处理中...' });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`上传失败: ${errText}`);
    }

    const result = await response.json();
    options?.onProgress?.({ phase: 'done', progress: 100, message: '上传完成' });
    return {
      url: result.url,
      compressed: result.compressed || false,
      id: result.id,
      filename: result.filename,
      ossKey: result.ossKey
    };
  } catch (err) {
    options?.onProgress?.({ phase: 'idle', progress: 0, message: '上传失败' });
    throw err;
  }
}

// 视频上传到 videos 文件夹（通过后端 API，支持自动压缩）
export async function uploadVideo(
  file: File,
  options?: {
    projectId?: number;
    sceneId?: number;
    usage?: string;
    title?: string;
    createShot?: boolean;
    compressionMethod?: 'server' | 'browser' | 'aliyun' | 'none';
    skipBitrateCheck?: boolean;
    onProgress?: (p: UploadProgress) => void;
    targetBitrate?: number;
    signal?: AbortSignal;
  }
): Promise<UploadResult & { id?: number; filename?: string; ossKey?: string }> {
  const method = options?.compressionMethod || 'none';
  const originalSizeKB = Math.round(file.size / 1024);

  let targetFile = file;
  let compressed = false;
  let decision: UploadDecision | null = null;

  if (!options?.skipBitrateCheck && method !== 'none') {
    options?.onProgress?.({ phase: 'checking', progress: 2, message: '正在检测视频信息...' });
    decision = await checkVideoBitrate(file);
  }

  if (method === 'browser') {
    options?.onProgress?.({ phase: 'compressing', progress: 5, message: '浏览器压缩中...' });
    const { compressVideoInBrowser } = await import('./videoCompressor');
    const compressResult = await compressVideoInBrowser(
      file,
      decision?.resolution,
      (stage: 'loading' | 'compressing', progress: number) => {
        const baseProgress = stage === 'loading' ? 5 + progress * 0.1 : 15 + progress * 0.5;
        options?.onProgress?.({
          phase: 'compressing',
          progress: Math.round(baseProgress),
          message: stage === 'loading' ? '正在加载压缩组件...' : '正在压缩视频...'
        });
      }
    );

    if (!compressResult.success) {
      throw new Error('浏览器压缩失败：' + (compressResult as { success: false; message: string }).message + '。请尝试其他压缩方式，或者手动压缩后再上传！');
    }

    targetFile = compressResult.file;
    compressed = true;
    options?.onProgress?.({ phase: 'compressing', progress: 65, message: '压缩完成，正在上传...' });
  }

  // 阿里云 MPS 转码压缩
  if (method === 'aliyun') {
    options?.onProgress?.({ phase: 'uploading', progress: 5, message: '上传视频到 OSS...' });

    // 获取视频分辨率信息
    const videoInfo = await checkVideoBitrate(file);
    const { getTargetBitrateAsync: getBitrateAsync } = await import('./videoCompressor');

    // 调用阿里云转码，使用异步版本获取目标码率
    const result = await uploadVideoWithAliyunCompression(file, {
      projectId: options?.projectId,
      sceneId: options?.sceneId,
      usage: options?.usage,
      title: options?.title,
      createShot: options?.createShot,
      targetBitrate: options?.targetBitrate || await getBitrateAsync(videoInfo.resolution || '480p'),
      signal: options?.signal,
      onProgress: (p) => {
        options?.onProgress?.({
          phase: p.phase,
          progress: 5 + p.progress * 0.95, // 映射到 5-100
          message: p.message
        });
      }
    });

    return {
      url: result.url,
      compressed: true,
      id: result.id,
      filename: result.filename,
      ossKey: result.ossKey,
      originalSizeKB,
      compressedSizeKB: result.compressedSizeKB,
      originalBitrate: videoInfo.bitrateKbps ?? undefined,
      targetBitrate: videoInfo.targetBitrateKbps,
      duration: videoInfo.duration ?? undefined,
    };
  }

  const formData = new FormData();
  formData.append('file', targetFile);
  if (options?.projectId) formData.append('projectId', String(options.projectId));
  if (options?.sceneId) formData.append('sceneId', String(options.sceneId));
  if (options?.usage) formData.append('usage', options.usage);
  if (options?.title) formData.append('title', options.title);
  if (options?.createShot) formData.append('createShot', '1');

  const useServerCompress = method === 'server';

  let uploadTaskId = '';
  try {
    options?.onProgress?.({ phase: 'uploading', progress: 70, message: '上传视频中...' });

    const taskResp = await fetch(
      `${API_BASE_URL}/api/upload/video${useServerCompress ? '?compress=true' : ''}`,
      { method: 'POST', body: formData, signal: options?.signal }
    );
    if (!taskResp.ok) throw new Error(`上传失败: HTTP ${taskResp.status}`);
    const taskRespData = await taskResp.json();
    uploadTaskId = taskRespData.taskId;
    options?.onProgress?.({ phase: 'uploading', progress: 75, message: '文件已提交，等待处理...' });

    let attempts = 0;
    const maxAttempts = 180;
    while (attempts < maxAttempts) {
      if (options?.signal?.aborted) throw new Error('上传已取消');
      await new Promise(r => setTimeout(r, 1000));
      const statusResp = await fetch(`${API_BASE_URL}/api/upload/status/${uploadTaskId}`, {
        signal: options?.signal
      });
      if (!statusResp.ok) throw new Error('状态查询失败');
      const status = await statusResp.json();

      if (status.status === 'done') {
        options?.onProgress?.({ phase: 'done', progress: 100, message: '上传完成' });
        return {
          url: status.result.url,
          compressed: compressed || status.result.compressed || false,
          id: status.result.id,
          filename: status.result.fileName,
          ossKey: status.result.ossKey,
          originalSizeKB,
          compressedSizeKB: status.result.fileSize ? Math.round(status.result.fileSize / 1024) : undefined,
          originalBitrate: decision?.bitrateKbps ?? undefined,
          targetBitrate: decision?.targetBitrateKbps,
          duration: decision?.duration ?? undefined,
        };
      }
      if (status.status === 'error') {
        // P3-7：使用结构化错误码判断压缩失败，避免依赖中文字符串匹配
        if (useServerCompress && status.errorCode === 'COMPRESSION_FAILED') {
          throw new Error('服务端压缩失败：' + (status.error || '压缩失败') + '。请尝试其他压缩方式，或者手动压缩后再上传！');
        }
        throw new Error(status.error || '上传失败');
      }
      const progress = Math.min(95, 75 + Math.floor((attempts / maxAttempts) * 20));
      options?.onProgress?.({
        phase: status.status === 'processing' ? 'compressing' : 'uploading',
        progress,
        message: status.message || '处理中...'
      });
      attempts++;
    }
    throw new Error('上传超时');
  } catch (err) {
    // 失败或取消时通知后端取消异步上传任务，避免遗留孤儿 OSS 文件 + DB 记录
    if (uploadTaskId) {
      try {
        await fetch(`${API_BASE_URL}/api/upload/cancel/${uploadTaskId}`, {
          method: 'POST'
        });
        console.log('[app] 已取消后端上传任务:', uploadTaskId);
      } catch (cancelErr) {
        console.error('[app] 取消后端上传任务失败:', cancelErr);
      }
    }
    options?.onProgress?.({ phase: 'idle', progress: 0, message: String(err) });
    throw err;
  }
}

// 阿里云 MPS 转码压缩上传
export async function uploadVideoWithAliyunCompression(
  file: File,
  options?: {
    projectId?: number;
    sceneId?: number;
    usage?: string;
    title?: string;
    createShot?: boolean;
    targetBitrate?: number;
    onProgress?: (p: UploadProgress) => void;
    signal?: AbortSignal;
  }
): Promise<UploadResult & { id?: number; filename?: string; ossKey?: string }> {
  // 0. 获取视频信息（码率、分辨率）用于后端码率阈值判断
  const { estimateVideoBitrate } = await import('./videoCompressor');
  const videoInfo = await estimateVideoBitrate(file);

  // 1. 先上传原视频到 OSS（临时存储）
  options?.onProgress?.({ phase: 'uploading', progress: 0, message: '上传原视频到 OSS...' });

  const formData = new FormData();
  formData.append('file', file);
  if (options?.projectId) formData.append('projectId', String(options.projectId));
  if (options?.sceneId) formData.append('sceneId', String(options.sceneId));
  if (options?.usage) formData.append('usage', options.usage);
  if (options?.title) formData.append('title', options.title);
  if (options?.createShot) formData.append('createShot', '1');

  // videoUrl / ossKey / uploadTaskId 在 try 外声明，以便 catch 块中清理使用
  let videoUrl = '';
  let ossKey = '';
  let uploadTaskId = '';

  try {
    const uploadResp = await fetch(`${API_BASE_URL}/api/upload/video`, {
      method: 'POST',
      body: formData,
      signal: options?.signal
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      throw new Error(`上传原视频失败: ${errText}`);
    }

    const uploadRespData = await uploadResp.json();
    uploadTaskId = uploadRespData.taskId;

    // 轮询等待上传完成
    let uploadAttempts = 0;
    const maxUploadAttempts = 180;

    while (uploadAttempts < maxUploadAttempts) {
      if (options?.signal?.aborted) throw new Error('上传已取消');
      await new Promise(r => setTimeout(r, 1000));
      const statusResp = await fetch(`${API_BASE_URL}/api/upload/status/${uploadTaskId}`, {
        signal: options?.signal
      });
      if (!statusResp.ok) throw new Error('上传状态查询失败');
      const status = await statusResp.json();

      if (status.status === 'done') {
        videoUrl = status.result.url;
        ossKey = status.result.ossKey;
        break;
      }
      if (status.status === 'error') {
        throw new Error(status.error || '上传失败');
      }
      const progress = Math.min(19, Math.floor((uploadAttempts / maxUploadAttempts) * 20));
      options?.onProgress?.({
        phase: 'uploading',
        progress,
        message: status.message || '上传中...'
      });
      uploadAttempts++;
    }

    if (!videoUrl) {
      throw new Error('上传超时');
    }

    options?.onProgress?.({ phase: 'compressing', progress: 20, message: '提交阿里云转码任务...' });

    // 2. 调用后端 /api/aliyun/transcode 提交转码任务
    const transcodeResp = await fetch(`${API_BASE_URL}/api/aliyun/transcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoUrl,
        ossKey,
        filename: file.name,
        targetBitrate: options?.targetBitrate,
        originalBitrate: videoInfo.bitrateKbps,
        width: videoInfo.width,
        height: videoInfo.height,
        projectId: options?.projectId,
        sceneId: options?.sceneId,
        usage: options?.usage,
        title: options?.title,
        createShot: options?.createShot ? 1 : 0
      }),
      signal: options?.signal
    });

    if (!transcodeResp.ok) {
      const errText = await transcodeResp.text();
      throw new Error(`提交转码任务失败: ${errText}`);
    }

    const { taskId, skipped, originalUrl } = await transcodeResp.json();

    // 如果后端判定不需要压缩，返回原视频
    if (skipped && originalUrl) {
      options?.onProgress?.({ phase: 'done', progress: 100, message: '视频码率符合要求，无需压缩' });
      return {
        url: originalUrl,
        compressed: false,
        originalBitrate: videoInfo.bitrateKbps ?? undefined,
        targetBitrate: videoInfo.bitrateKbps,
        duration: videoInfo.duration ?? undefined,
      };
    }

    // 3. 轮询 /api/aliyun/transcode/:taskId 查询状态
    let attempts = 0;
    const maxAttempts = 300; // 最大等待 10 分钟 (300 * 2秒)

    while (attempts < maxAttempts) {
      if (options?.signal?.aborted) throw new Error('转码已取消');
      const statusResp = await fetch(`${API_BASE_URL}/api/aliyun/transcode/${taskId}`, {
        signal: options?.signal
      });
      if (!statusResp.ok) {
        throw new Error('查询转码状态失败');
      }

      const status = await statusResp.json();

      if (status.status === 'completed' || status.status === 'done') {
        // 4. 转码完成，返回结果
        options?.onProgress?.({ phase: 'done', progress: 100, message: '阿里云转码完成' });

        return {
          url: status.url || videoUrl,
          compressed: true,
          id: status.id,
          filename: status.filename || file.name,
          ossKey: status.ossKey || ossKey,
          originalSizeKB: Math.round(file.size / 1024),
          compressedSizeKB: status.fileSize ? Math.round(status.fileSize / 1024) : undefined,
        };
      }

      if (status.status === 'failed' || status.status === 'error') {
        throw new Error('阿里云压缩失败：' + (status.error || '转码失败') + '。请尝试其他压缩方式，或者手动压缩后再上传！');
      }

      // 更新进度：20-80 映射到转码进度
      const progress = 20 + Math.min(status.progress || 0, 100) * 0.6;
      options?.onProgress?.({
        phase: 'compressing',
        progress: Math.round(progress),
        message: status.message || '阿里云转码中...'
      });

      attempts++;
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒轮询一次
    }

    throw new Error('阿里云压缩失败：转码超时。请尝试其他压缩方式，或者手动压缩后再上传！');
  } catch (err) {
    // 任何阶段失败（初始上传/转码提交/转码轮询/用户取消）：清理残留
    // 1. 如果初始上传已完成（videoUrl 已设置），清理转码相关 DB 记录和 OSS 文件
    if (videoUrl) {
      try {
        await fetch(`${API_BASE_URL}/api/aliyun/transcode-cleanup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoUrl })
        });
        console.log('[aliyun] 失败/取消，已清理原始视频:', videoUrl);
      } catch (cleanupErr) {
        console.error('[aliyun] 清理失败资源失败:', cleanupErr);
      }
    }
    // 2. 如果初始上传尚未完成（videoUrl 未设置但 uploadTaskId 已获取），取消后端异步上传任务
    //    避免后端异步任务完成后遗留孤儿 OSS 文件 + DB 记录
    if (uploadTaskId && !videoUrl) {
      try {
        await fetch(`${API_BASE_URL}/api/upload/cancel/${uploadTaskId}`, {
          method: 'POST'
        });
        console.log('[aliyun] 已取消后端上传任务:', uploadTaskId);
      } catch (cancelErr) {
        console.error('[aliyun] 取消后端上传任务失败:', cancelErr);
      }
    }
    throw err;
  }
}

// 文件类型检测：判断某个 File 是图片、视频，还是不支持
export function detectFileType(file: File): { supported: boolean; type: 'image' | 'video' | 'unknown'; mime: string } {
  const mime = file.type;
  if (ALLOWED_MIME_TYPES.image.includes(mime) || mime.startsWith('image/')) {
    return { supported: true, type: 'image', mime };
  }
  if (ALLOWED_MIME_TYPES.video.includes(mime) || mime.startsWith('video/')) {
    return { supported: true, type: 'video', mime };
  }
  return { supported: false, type: 'unknown', mime };
}