import type { UploadTaskResult } from './types';

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

export function getVideoPoster(url: string, startTime?: number): string {
  if (url && (url.includes('aliyuncs.com') || url.includes('qiziwenhua.top'))) {
    const t = startTime !== undefined && startTime > 0 ? Math.round(startTime * 1000) : 1000;
    // 使用后端代理，避免前端直接请求 OSS 截图触发 ORB
    return `/api/oss-snapshot?url=${encodeURIComponent(url)}&t=${t}&w=800`;
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
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', credential.host);

    const formData = new FormData();
    formData.append('key', credential.key);
    formData.append('OSSAccessKeyId', credential.accessKeyId);
    formData.append('policy', credential.policy);
    formData.append('Signature', credential.signature); // 阿里云要求大写 S
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
        const fileUrl = `https://${credential.bucket}.${credential.region}.aliyuncs.com/${credential.key}`;
        resolve(fileUrl);
      } else {
        console.error('[uploadDirectToOss] HTTP 错误:', xhr.status, xhr.statusText, xhr.responseText);
        reject(new Error(`OSS 上传失败: HTTP ${xhr.status} ${xhr.statusText}`));
      }
    });

    xhr.addEventListener('error', (e) => {
      console.error('[uploadDirectToOss] 网络错误:', e, 'host:', credential.host);
      reject(new Error('网络错误'));
    });
    xhr.addEventListener('timeout', () => reject(new Error('上传超时')));

    // AbortSignal 支持
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        reject(new Error('上传已取消'));
        return;
      }
      signal.addEventListener('abort', () => {
        xhr.abort();
        reject(new Error('上传已取消'));
      });
    }

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
  compressionError?: string;
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
): Promise<UploadTaskResult> {
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
    const phase: UploadProgress['phase'] = task.progress < 50 ? 'compressing' : (task.progress < 100 ? 'uploading' : 'done');
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

// 浏览器端图片压缩：使用 Canvas API 统一转为 JPEG
// 失败时返回 null，由调用方回退到服务器压缩
async function compressImageInBrowser(
  file: File,
  maxSizeKB: number,
  onProgress?: (progress: number) => void
): Promise<File | null> {
  try {
    if (file.size <= maxSizeKB * 1024) return file;

    const img = await loadImage(file);
    onProgress?.(30);

    // Canvas 尺寸限制检查（保守值 4096）
    const MAX_CANVAS_DIM = 4096;
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    if (width > MAX_CANVAS_DIM || height > MAX_CANVAS_DIM) {
      const scale = MAX_CANVAS_DIM / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // 白色背景填充，避免 PNG 透明通道转 JPEG 后变黑
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    onProgress?.(60);

    // 统一转 JPEG，从高质量逐步降低
    let quality = 0.9;
    let bestBlob: Blob | null = null;
    while (quality > 0.1) {
      const blob = await new Promise<Blob | null>(resolve =>
        canvas.toBlob(resolve, 'image/jpeg', quality)
      );
      if (blob && (!bestBlob || blob.size < bestBlob.size)) {
        bestBlob = blob;
      }
      if (bestBlob && bestBlob.size <= maxSizeKB * 1024) break;
      quality -= 0.05;
    }

    if (!bestBlob || bestBlob.size >= file.size) return null;
    onProgress?.(90);

    return new File([bestBlob], file.name.replace(/\.\w+$/, '.jpg'), {
      type: 'image/jpeg',
    });
  } catch (e) {
    console.warn('[compressImageInBrowser] 浏览器压缩失败，将回退服务器:', e);
    return null;
  }
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(img.src);
      reject(e);
    };
    img.src = URL.createObjectURL(file);
  });
}

// 直传 OSS 并注册 DB 记录（供 uploadImage/uploadVideo 直传分支使用）
async function directUploadToOssAndRegister(
  file: File,
  type: 'image' | 'video',
  options: {
    projectId?: number;
    sceneId?: number;
    usage?: string;
    title?: string;
    createShot?: boolean;
    onProgress?: (p: UploadProgress) => void;
    signal?: AbortSignal;
  }
): Promise<{ url: string; id?: number; filename: string; ossKey: string }> {
  if (!options?.projectId) {
    throw new Error('缺少 projectId，无法直传 OSS');
  }

  // 1. 获取直传凭证
  options?.onProgress?.({ phase: 'uploading', progress: 40, message: '获取上传凭证...' });
  const credential = await getOssUploadCredential(
    options.projectId,
    file.name,
    type,
    options.usage
  );

  // 2. 直传到 OSS
  const fileUrl = await uploadDirectToOss(file, credential, p => {
    options?.onProgress?.(p);
  }, options?.signal);

  const ossKey = credential.key;

  // 3. 注册 DB 记录
  options?.onProgress?.({ phase: 'uploading', progress: 90, message: '注册记录...' });
  try {
    const regResp = await fetch(`${API_BASE_URL}/api/media/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: fileUrl,
        filename: file.name,
        size: file.size,
        type,
        usage: options.usage,
        projectId: options.projectId,
        sceneId: options.sceneId,
        createShot: options.createShot ? 1 : 0,
        title: options.title,
      }),
      signal: options?.signal,
    });

    if (!regResp.ok) {
      const errText = await regResp.text();
      throw new Error(`注册媒体记录失败: ${errText}`);
    }

    const regResult = await regResp.json();
    return { url: fileUrl, id: regResult.id, filename: file.name, ossKey };
  } catch (err) {
    // DB 注册失败：清理已上传的 OSS 文件
    try {
      await fetch(`${API_BASE_URL}/api/oss/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: fileUrl }),
      });
    } catch (cleanupErr) {
      console.error('[directUpload] 清理 OSS 文件失败:', cleanupErr);
    }
    throw err;
  }
}

// 图片上传（浏览器压缩优先，成功后直传 OSS；失败回退服务器压缩）
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

  const originalSizeKB = Math.round(file.size / 1024);
  options?.onProgress?.({ phase: 'uploading', progress: 5, message: '压缩图片中...' });

  // 浏览器端压缩优先：读取阈值，尝试在浏览器压缩
  let uploadFile = file;
  let browserCompressed = false;
  let needServerFallback = false;

  try {
    const settingsResp = await fetch('/api/settings');
    const settingsData = await settingsResp.json();
    const thresholdKB = settingsData?.data?.image_compress_threshold_kb
      ? parseInt(settingsData.data.image_compress_threshold_kb) : 300;

    if (file.size > thresholdKB * 1024) {
      const compressed = await compressImageInBrowser(file, thresholdKB, p => {
        options?.onProgress?.({ phase: 'uploading', progress: 5 + Math.round(p * 0.3), message: '浏览器压缩中...' });
      });
      if (compressed) {
        uploadFile = compressed;
        browserCompressed = true;
        console.log(`[uploadImage] 浏览器压缩: ${(file.size / 1024).toFixed(0)}KB → ${(compressed.size / 1024).toFixed(0)}KB`);
      } else {
        // 浏览器压缩失败，回退服务器
        needServerFallback = true;
      }
    }
  } catch (e) {
    console.warn('[uploadImage] 获取设置或浏览器压缩失败，回退服务器压缩:', e);
    needServerFallback = true;
  }

  // 浏览器压缩失败 → 回退服务器上传
  if (needServerFallback) {
    return uploadImageViaServer(uploadFile, options);
  }

  // 直传 OSS + 注册 DB
  try {
    const result = await directUploadToOssAndRegister(uploadFile, 'image', options);
    options?.onProgress?.({ phase: 'done', progress: 100, message: '上传完成' });
    return {
      url: result.url,
      compressed: browserCompressed,
      originalSizeKB,
      compressedSizeKB: Math.round(uploadFile.size / 1024),
      id: result.id,
      filename: result.filename,
      ossKey: result.ossKey,
    };
  } catch (err) {
    options?.onProgress?.({ phase: 'idle', progress: 0, message: '上传失败' });
    throw err;
  }
}

// 服务器上传回退（浏览器压缩失败时使用）
async function uploadImageViaServer(
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
  const formData = new FormData();
  formData.append('file', file);
  if (options?.projectId) formData.append('projectId', String(options.projectId));
  if (options?.sceneId) formData.append('sceneId', String(options.sceneId));
  if (options?.usage) formData.append('usage', options.usage);
  if (options?.title) formData.append('title', options.title);
  if (options?.createShot) formData.append('createShot', '1');

  try {
    options?.onProgress?.({ phase: 'uploading', progress: 40, message: '上传图片中...' });
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
      compressionFailed: !!result.compressionError,
      compressionError: result.compressionError,
      originalSizeKB: result.originalSizeKB,
      compressedSizeKB: result.compressedSizeKB,
      id: result.id,
      filename: result.filename,
      ossKey: result.ossKey
    };
  } catch (err) {
    options?.onProgress?.({ phase: 'idle', progress: 0, message: '上传失败' });
    throw err;
  }
}

// 视频上传（统一入口：直传 OSS 或走服务器，支持自动压缩）
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

  let decision: UploadDecision | null = null;

  // Step 1: 若未跳过码率检测，先检测码率
  if (!options?.skipBitrateCheck) {
    options?.onProgress?.({ phase: 'checking', progress: 2, message: '正在检测视频信息...' });
    decision = await checkVideoBitrate(file);

    // 码率符合要求 → 直传 OSS
    if (decision.decision === 'direct_upload') {
      const result = await directUploadToOssAndRegister(file, 'video', options);
      options?.onProgress?.({ phase: 'done', progress: 100, message: '上传完成' });
      return {
        url: result.url,
        compressed: false,
        originalSizeKB,
        compressedSizeKB: originalSizeKB,
        id: result.id,
        filename: result.filename,
        ossKey: result.ossKey,
        originalBitrate: decision.bitrateKbps ?? undefined,
        targetBitrate: decision.targetBitrateKbps,
        duration: decision.duration ?? undefined,
      };
    }

    // 码率超标但 method='none' → 终止上传
    if (decision.decision === 'must_compress' && method === 'none') {
      throw new Error('视频码率超标，请选择压缩方式');
    }
  }

  // Step 2: 根据 method 分支

  // method='none'（skipBitrateCheck=true，调用方已确认 direct_upload）
  if (method === 'none') {
    const result = await directUploadToOssAndRegister(file, 'video', options);
    options?.onProgress?.({ phase: 'done', progress: 100, message: '上传完成' });
    return {
      url: result.url,
      compressed: false,
      originalSizeKB,
      compressedSizeKB: originalSizeKB,
      id: result.id,
      filename: result.filename,
      ossKey: result.ossKey,
    };
  }

  // method='browser'：浏览器压缩后直传 OSS
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

    const compressedFile = compressResult.file;
    options?.onProgress?.({ phase: 'compressing', progress: 65, message: '压缩完成，正在上传...' });

    // 直传压缩后文件到 OSS + 注册 DB
    const result = await directUploadToOssAndRegister(compressedFile, 'video', options);
    options?.onProgress?.({ phase: 'done', progress: 100, message: '上传完成' });
    return {
      url: result.url,
      compressed: true,
      originalSizeKB,
      compressedSizeKB: Math.round(compressedFile.size / 1024),
      id: result.id,
      filename: result.filename,
      ossKey: result.ossKey,
      originalBitrate: decision?.bitrateKbps ?? undefined,
      targetBitrate: decision?.targetBitrateKbps,
      duration: decision?.duration ?? undefined,
    };
  }

  // method='aliyun'：直传原视频到 OSS → MPS 转码
  if (method === 'aliyun') {
    // 获取视频信息（若调用方未预检，此处补充检测）
    if (!decision) {
      options?.onProgress?.({ phase: 'checking', progress: 2, message: '正在检测视频信息...' });
      decision = await checkVideoBitrate(file);
    }

    const { getTargetBitrateAsync: getBitrateAsync } = await import('./videoCompressor');

    return await uploadVideoWithAliyunCompression(file, {
      projectId: options?.projectId,
      sceneId: options?.sceneId,
      usage: options?.usage,
      title: options?.title,
      createShot: options?.createShot,
      targetBitrate: options?.targetBitrate || await getBitrateAsync(decision.resolution || '480p'),
      signal: options?.signal,
      onProgress: (p) => {
        options?.onProgress?.({
          phase: p.phase,
          progress: 5 + p.progress * 0.95,
          message: p.message
        });
      }
    }, decision);
  }

  // method='server'：走服务器压缩上传（现有逻辑）
  const formData = new FormData();
  formData.append('file', file);
  if (options?.projectId) formData.append('projectId', String(options.projectId));
  if (options?.sceneId) formData.append('sceneId', String(options.sceneId));
  if (options?.usage) formData.append('usage', options.usage);
  if (options?.title) formData.append('title', options.title);
  if (options?.createShot) formData.append('createShot', '1');

  let uploadTaskId = '';
  try {
    options?.onProgress?.({ phase: 'uploading', progress: 70, message: '上传视频中...' });

    const taskResp = await fetch(
      `${API_BASE_URL}/api/upload/video?compress=true`,
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
          compressed: status.result.compressed || false,
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
        if (status.errorCode === 'COMPRESSION_FAILED') {
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

// 阿里云 MPS 转码压缩上传（原视频直传 OSS，不经过服务器）
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
  },
  decision?: UploadDecision
): Promise<UploadResult & { id?: number; filename?: string; ossKey?: string }> {
  // 0. 获取视频信息（若未传入则检测）
  const videoInfo = decision || await checkVideoBitrate(file);
  const originalSizeKB = Math.round(file.size / 1024);

  // videoUrl / ossKey 在 try 外声明，以便 catch 块中清理使用
  let videoUrl = '';
  let ossKey = '';

  try {
    // 1. 直传原视频到 OSS
    if (!options?.projectId) {
      throw new Error('缺少 projectId，无法直传 OSS');
    }

    options?.onProgress?.({ phase: 'uploading', progress: 0, message: '上传原视频到 OSS...' });

    const credential = await getOssUploadCredential(
      options.projectId,
      file.name,
      'video',
      options.usage
    );

    videoUrl = await uploadDirectToOss(file, credential, p => {
      options?.onProgress?.({
        phase: p.phase,
        progress: Math.min(19, Math.round(p.progress * 0.2)),
        message: p.message
      });
    }, options?.signal);

    ossKey = credential.key;

    // 2. 注册 DB 记录（必须在提交转码前注册，以便转码完成后后端更新记录）
    const regResp = await fetch(`${API_BASE_URL}/api/media/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: videoUrl,
        filename: file.name,
        size: file.size,
        type: 'video',
        usage: options.usage,
        projectId: options.projectId,
        sceneId: options.sceneId,
        createShot: options.createShot ? 1 : 0,
        title: options.title,
        isAwaitingTranscode: true,
      }),
      signal: options?.signal,
    });

    if (!regResp.ok) {
      const errText = await regResp.text();
      throw new Error(`注册媒体记录失败: ${errText}`);
    }

    options?.onProgress?.({ phase: 'compressing', progress: 20, message: '提交阿里云转码任务...' });

    // 3. 提交转码任务
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

    // 后端判定不需要压缩，返回原视频
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

    // 4. 轮询转码状态
    let attempts = 0;
    const maxAttempts = 300;

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
        options?.onProgress?.({ phase: 'done', progress: 100, message: '阿里云转码完成' });
        return {
          url: status.url || videoUrl,
          compressed: true,
          id: status.id,
          filename: status.filename || file.name,
          ossKey: status.ossKey || ossKey,
          originalSizeKB,
          compressedSizeKB: status.fileSize ? Math.round(status.fileSize / 1024) : undefined,
        };
      }

      if (status.status === 'failed' || status.status === 'error') {
        throw new Error('阿里云压缩失败：' + (status.error || '转码失败') + '。请尝试其他压缩方式，或者手动压缩后再上传！');
      }

      const progress = 20 + Math.min(status.progress || 0, 100) * 0.6;
      options?.onProgress?.({
        phase: 'compressing',
        progress: Math.round(progress),
        message: status.message || '阿里云转码中...'
      });

      attempts++;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error('阿里云压缩失败：转码超时。请尝试其他压缩方式，或者手动压缩后再上传！');
  } catch (err) {
    // 任何阶段失败：清理已直传的 OSS 文件和 DB 记录
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