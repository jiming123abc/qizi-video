declare global {
  interface Window {
    FFmpegWASM: {
      FFmpeg: new () => FFmpegWasmInstance;
    };
  }
}

interface FFmpegWasmInstance {
  load: (config?: { coreURL?: string; wasmURL?: string }) => Promise<void>;
  writeFile: (name: string, data: Uint8Array) => Promise<void>;
  readFile: (name: string) => Promise<Uint8Array>;
  deleteFile: (name: string) => Promise<void>;
  exec: (args: string[]) => Promise<number>;
  on: (event: string, callback: (data: any) => void) => void;
  terminate: () => void;
}

export type VideoBitrateInfo = {
  bitrateKbps: number | null;
  duration: number | null;
  width?: number;
  height?: number;
  resolution?: '1080p' | '720p' | '480p';
};

// 默认码率配置（作为备用）
const DEFAULT_BITRATE_CONFIG = {
  '1080p': 3000,  // 1080p 及以上
  '720p': 2000,    // 720p 及以上
  '480p': 1000     // 480p 及以上
};

// 缓存的码率配置（从 API 获取）
let cachedBitrateConfig: Record<string, number> | null = null;
let configFetchPromise: Promise<Record<string, number>> | null = null;

/**
 * 从 API 获取码率配置
 */
async function fetchBitrateConfig(): Promise<Record<string, number>> {
  if (cachedBitrateConfig) {
    return cachedBitrateConfig;
  }

  if (configFetchPromise) {
    return configFetchPromise;
  }

  configFetchPromise = (async () => {
    try {
      const API_BASE_URL = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL || '');
      const res = await fetch(`${API_BASE_URL}/api/video2/settings`);
      if (!res.ok) {
        console.warn('[videoCompressor] 获取码率配置失败，使用默认配置');
        return DEFAULT_BITRATE_CONFIG;
      }

      const data = await res.json();
      const config = {
        '1080p': data.video_target_bitrate_1080p || DEFAULT_BITRATE_CONFIG['1080p'],
        '720p': data.video_target_bitrate_720p || DEFAULT_BITRATE_CONFIG['720p'],
        '480p': data.video_target_bitrate_480p || DEFAULT_BITRATE_CONFIG['480p']
      };

      cachedBitrateConfig = config;
      return config;
    } catch (err) {
      console.warn('[videoCompressor] 获取码率配置失败，使用默认配置:', err);
      return DEFAULT_BITRATE_CONFIG;
    } finally {
      configFetchPromise = null;
    }
  })();

  return configFetchPromise;
}

const FFMPEG_BASE = '/ffmpeg';
const UMD_SCRIPT_URL = `${FFMPEG_BASE}/ffmpeg.umd.js`;
const CORE_JS_URL = `${FFMPEG_BASE}/ffmpeg-core.js`;
const CORE_WASM_URL = `${FFMPEG_BASE}/ffmpeg-core.wasm`;

let ffmpegWasmLoaded = false;
let ffmpegWasmLoading: Promise<boolean> | null = null;

/**
 * 根据分辨率阶梯判断获取分辨率类型
 * 规则：≥1080P 为 1080p，≥720P 为 720p，≥480P 为 480p
 */
export function getResolutionTier(height: number | undefined): '1080p' | '720p' | '480p' {
  if (!height) return '480p'; // 默认最低阶梯
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  return '480p';
}

/**
 * 根据分辨率阶梯获取目标码率（异步版本，从 API 获取）
 */
export async function getTargetBitrateAsync(resolution: '1080p' | '720p' | '480p'): Promise<number> {
  const config = await fetchBitrateConfig();
  return config[resolution] || DEFAULT_BITRATE_CONFIG[resolution];
}

/**
 * 根据分辨率阶梯获取目标码率（同步版本，使用缓存或默认值）
 * 注意：推荐使用异步版本 getTargetBitrateAsync
 */
export function getTargetBitrate(resolution: '1080p' | '720p' | '480p' | undefined): number {
  const res = resolution || '480p';
  // 如果缓存存在，使用缓存值；否则使用默认值
  if (cachedBitrateConfig && cachedBitrateConfig[res]) {
    return cachedBitrateConfig[res];
  }
  return DEFAULT_BITRATE_CONFIG[res];
}

/**
 * 判断是否需要压缩（异步版本，从 API 获取码率配置）
 */
export async function needsCompressionAsync(
  bitrateKbps: number,
  resolution: '1080p' | '720p' | '480p'
): Promise<boolean> {
  const targetBitrate = await getTargetBitrateAsync(resolution);
  return bitrateKbps > targetBitrate;
}

/**
 * 判断是否需要压缩（同步版本，使用缓存或默认值）
 */
export function needsCompression(
  bitrateKbps: number,
  resolution: '1080p' | '720p' | '480p' | undefined
): boolean {
  const targetBitrate = getTargetBitrate(resolution);
  return bitrateKbps > targetBitrate;
}

export async function estimateVideoBitrate(file: File): Promise<VideoBitrateInfo> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.style.display = 'none';
    const url = URL.createObjectURL(file);
    let resolved = false;

    const done = (bitrateKbps: number | null, duration: number | null, width?: number, height?: number) => {
      if (resolved) return;
      resolved = true;
      video.removeAttribute('src');
      video.load();
      document.body.removeChild(video);
      URL.revokeObjectURL(url);

      // 使用分辨率阶梯判断逻辑
      const resolution = getResolutionTier(height);

      resolve({ bitrateKbps, duration, width, height, resolution });
    };

    video.onloadedmetadata = () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (duration && duration > 0 && isFinite(duration)) {
        const fileSizeBits = file.size * 8;
        const bitrateKbps = Math.round(fileSizeBits / duration / 1000);
        done(bitrateKbps, duration, width, height);
      } else {
        done(null, null, width, height);
      }
    };

    video.onerror = () => {
      done(null, null);
    };

    document.body.appendChild(video);
    video.src = url;
  });
}

async function loadFFmpegUMD(): Promise<boolean> {
  if (ffmpegWasmLoaded) return true;
  if (ffmpegWasmLoading) return ffmpegWasmLoading;

  ffmpegWasmLoading = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = UMD_SCRIPT_URL;
    script.onload = () => {
      ffmpegWasmLoaded = true;
      resolve(true);
    };
    script.onerror = () => {
      ffmpegWasmLoading = null;
      resolve(false);
    };
    document.head.appendChild(script);
  });

  return ffmpegWasmLoading;
}

async function fetchAsBlobURL(url: string): Promise<string> {
  const response = await fetch(url);
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export async function compressVideoInBrowser(
  file: File,
  targetResolution?: '1080p' | '720p' | '480p',
  onProgress?: (stage: 'loading' | 'compressing', progress: number) => void
): Promise<{ success: true; file: File } | { success: false; message: string }> {
  try {
    onProgress?.('loading', 0);
    const umdLoaded = await loadFFmpegUMD();
    if (!umdLoaded || !window.FFmpegWASM) {
      return { success: false, message: 'FFmpeg 组件加载失败，请检查网络连接' };
    }

    onProgress?.('loading', 30);

    const { FFmpeg } = window.FFmpegWASM;
    const ffmpeg = new FFmpeg();

    ffmpeg.on('log', ({ message }: { message: string }) => {
      console.log('FFmpeg:', message);
    });

    ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      onProgress?.('compressing', progress * 100);
    });

    onProgress?.('loading', 50);
    await ffmpeg.load({
      coreURL: await fetchAsBlobURL(CORE_JS_URL),
      wasmURL: await fetchAsBlobURL(CORE_WASM_URL),
    });
    onProgress?.('loading', 100);
    onProgress?.('compressing', 0);

    // 根据目标分辨率获取目标码率（优先使用异步版本）
    const resolution = targetResolution || '480p';
    const targetBitrate = await getTargetBitrateAsync(resolution);
    const inputFileName = 'input' + getFileExtension(file.name);
    const outputFileName = 'output.mp4';

    await ffmpeg.writeFile(inputFileName, new Uint8Array(await file.arrayBuffer()));

    // 构建 ffmpeg 命令
    const ffmpegArgs = [
      '-i', inputFileName,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-b:v', `${targetBitrate}k`,
      '-maxrate', `${targetBitrate}k`,
      '-bufsize', `${targetBitrate * 2}k`,
      '-crf', '28',
      '-movflags', '+faststart',
      '-y',
      outputFileName,
    ];

    await ffmpeg.exec(ffmpegArgs);

    const data = await ffmpeg.readFile(outputFileName);
    const newFileName = file.name.replace(/\.[^.]+$/, '.mp4');
    const compressedFile = new File([data], newFileName, { type: 'video/mp4' });

    try {
      await ffmpeg.deleteFile(inputFileName);
      await ffmpeg.deleteFile(outputFileName);
      ffmpeg.terminate();
    } catch (e) { /* ignore */ }

    onProgress?.('compressing', 100);
    return { success: true, file: compressedFile };
  } catch (error) {
    console.error('浏览器压缩失败:', error);
    return { success: false, message: `压缩失败: ${(error as Error).message}` };
  }
}

function getFileExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || 'mp4';
  return '.' + ext;
}