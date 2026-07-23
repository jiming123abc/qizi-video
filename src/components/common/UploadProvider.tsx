import React, { useState, useRef, useCallback, useEffect, createContext } from 'react';
import {
  uploadImage,
  uploadVideo,
  detectFileType,
  checkVideoBitrate,
} from '../../lib/ossUtils';
import type { UploadDecision } from '../../lib/ossUtils';
import type { FileCompressionInfo } from '../../hooks/useUpload';
import { UploadDialog } from './UploadDialog';
import { VideoCompressionDialog } from '../storyboard/VideoCompressionDialog';

// ================ 类型定义 ================

/** 上传场景配置 */
export interface UploadOptions {
  projectId: number;
  sceneId?: number | null;
  usage: string;                    // shot-reference, digital-asset, project-cover 等
  accept?: string;                  // 文件类型限制，如 "image/*", "video/*", "image/*,video/*"
  multiple?: boolean;               // 是否允许多选，默认 false
  maxFiles?: number;                // 多选时最大文件数，默认 10
  currentCount?: number;            // 当前已有的媒体数量，用于计算剩余可选数量
  createShot?: boolean;             // 是否创建分镜记录（仅视频），默认 false
  title?: string;                   // 媒体标题
}

/** 单个文件的上传结果 */
export interface UploadItemResult {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: 'image' | 'video';
  compressed: boolean;
  originalSizeKB?: number;
  compressedSizeKB?: number;
  mediaId?: number;
  ossKey?: string;
}

/** 上传中的文件状态 */
export interface UploadingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'pending' | 'detecting' | 'uploading' | 'done' | 'error' | 'cancelled' | 'retrying';
  message?: string;
  retryCount: number;
}

// ================ Context ================

interface UploadContextValue {
  /** 启动上传流程：弹出系统文件选择框，返回上传结果 */
  startUpload: (options: UploadOptions) => Promise<UploadItemResult[]>;
}

export const UploadContext = createContext<UploadContextValue>({
  startUpload: async () => [],
});

// ================ Provider ================

const MAX_CONCURRENT = 1; // 串行处理：逐个上传/压缩，避免并行引发的状态竞争问题
const MAX_RETRIES = 2;

export function UploadProvider({ children }: { children: React.ReactNode }) {
  // 对话框状态
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);

  // 压缩选择状态
  const [pendingCompressionVideo, setPendingCompressionVideo] = useState<File | null>(null);
  const [pendingCompressionDecision, setPendingCompressionDecision] = useState<UploadDecision | null>(null);
  const [pendingCompressionFiles, setPendingCompressionFiles] = useState<FileCompressionInfo[]>([]);

  // 阿里云配置
  const [aliyunConfigured, setAliyunConfigured] = useState(false);

  // Refs
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingValidFilesRef = useRef<File[]>([]);
  const pendingCompressionMethodRef = useRef<'server' | 'browser' | 'aliyun' | null>(null);
  const pendingCompressionIndicesRef = useRef<Set<number>>(new Set());
  const compressionDecisionPendingRef = useRef(false);
  const runUploadQueueRef = useRef<() => void>(() => {});
  const uploadCancelledRef = useRef(false);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const concurrentCountRef = useRef(0);
  const completionCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // 标记上传队列是否已启动（防止完成检测在队列启动前误判 allDone）
  const uploadsStartedRef = useRef(false);

  // 当前上传选项和回调
  const currentOptionsRef = useRef<UploadOptions | null>(null);
  const resolveRef = useRef<((results: UploadItemResult[]) => void) | null>(null);
  const uploadResultsRef = useRef<UploadItemResult[]>([]);
  // 同步追踪 uploadingFiles 状态，避免在 state updater 内执行副作用
  const uploadingFilesRef = useRef<UploadingFile[]>([]);

  // 是否所有上传已完成（用于显示确认/取消按钮）
  const [allDone, setAllDone] = useState(false);

  // 注意：uploadingFilesRef 通过手动同步维护（不使用 useEffect，避免异步渲染覆盖手动更新的 ref 值）
  // 关键同步点：startUpload、handleCompressionDecision、runUploadQueue、retryFailedFiles

  // 检测阿里云配置
  useEffect(() => {
    fetch('/api/aliyun/status')
      .then(res => res.json())
      .then(data => setAliyunConfigured(data.configured || false))
      .catch(() => {});
  }, []);

  // unmount 清理
  useEffect(() => {
    return () => {
      if (completionCheckRef.current) {
        clearInterval(completionCheckRef.current);
        completionCheckRef.current = null;
      }
      retryTimeoutsRef.current.forEach(t => clearTimeout(t));
      retryTimeoutsRef.current.clear();
    };
  }, []);

  // ================ 核心上传逻辑 ================

  const uploadSingleFile = useCallback(async (
    file: File,
    index: number,
    retry: number = 0,
    compressionMethod: 'none' | 'server' | 'browser' | 'aliyun' = 'none'
  ) => {
    if (uploadCancelledRef.current) {
      setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'cancelled', progress: 0, message: '已取消' } : uf));
      return;
    }

    const options = currentOptionsRef.current!;
    const detected = detectFileType(file);

    try {
      setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'uploading', progress: 5 } : uf));

      let result: { url: string; id?: number; filename?: string; ossKey?: string; compressedSizeKB?: number; originalSizeKB?: number; compressed: boolean };

      if (detected.type === 'image') {
        const r = await uploadImage(file, {
          projectId: options.projectId,
          sceneId: options.sceneId !== null && options.sceneId !== undefined ? options.sceneId : undefined,
          usage: options.usage,
          title: options.title || file.name,
          createShot: options.createShot,
          signal: uploadAbortControllerRef.current?.signal,
          onProgress: p => {
            setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, progress: p.progress, message: p.message } : uf));
          }
        });
        result = { url: r.url, id: r.id, filename: r.filename, ossKey: r.ossKey, compressedSizeKB: r.compressedSizeKB, originalSizeKB: r.originalSizeKB, compressed: r.compressed };
      } else {
        const r = await uploadVideo(file, {
          projectId: options.projectId,
          sceneId: options.sceneId !== null && options.sceneId !== undefined ? options.sceneId : undefined,
          usage: options.usage,
          title: options.title || file.name,
          createShot: options.createShot,
          compressionMethod,
          skipBitrateCheck: true,
          signal: uploadAbortControllerRef.current?.signal,
          onProgress: p => {
            setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, progress: p.progress, message: p.message } : uf));
          }
        });
        result = { url: r.url, id: r.id, filename: r.filename, ossKey: r.ossKey, compressedSizeKB: r.compressedSizeKB, originalSizeKB: r.originalSizeKB, compressed: r.compressed };
      }

      // 记录结果
      uploadResultsRef.current.push({
        id: `${Date.now()}-${index}`,
        url: result.url,
        filename: result.filename || file.name,
        size: file.size,
        type: detected.type as 'image' | 'video',
        compressed: result.compressed,
        originalSizeKB: result.originalSizeKB,
        compressedSizeKB: result.compressedSizeKB,
        mediaId: result.id,
        ossKey: result.ossKey,
      });

      // 同步更新 ref（防止 runUploadQueue 用过时数据覆盖已完成的状态）
      uploadingFilesRef.current = uploadingFilesRef.current.map((uf, idx) => idx === index ? { ...uf, progress: 100, status: 'done' as const, message: '完成' } : uf);
      setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf));
    } catch (e) {
      if (uploadCancelledRef.current) {
        uploadingFilesRef.current = uploadingFilesRef.current.map((uf, idx) => idx === index ? { ...uf, status: 'cancelled' as const, progress: 0, message: '已取消' } : uf);
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'cancelled', progress: 0, message: '已取消' } : uf));
        return;
      }
      console.error('上传失败:', file.name, e);

      if (retry < MAX_RETRIES) {
        const nextRetry = retry + 1;
        uploadingFilesRef.current = uploadingFilesRef.current.map((uf, idx) => idx === index ? { ...uf, retryCount: nextRetry, progress: 0, status: 'retrying' as const, message: `准备重试 ${nextRetry}/${MAX_RETRIES}` } : uf);
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, retryCount: nextRetry, progress: 0, status: 'retrying', message: `准备重试 ${nextRetry}/${MAX_RETRIES}` } : uf));
        const retryTimer = setTimeout(() => {
          retryTimeoutsRef.current.delete(retryTimer);
          uploadingFilesRef.current = uploadingFilesRef.current.map((uf, idx) => idx === index ? { ...uf, status: 'pending' as const, message: `重试 ${nextRetry}/${MAX_RETRIES}` } : uf);
          setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'pending', message: `重试 ${nextRetry}/${MAX_RETRIES}` } : uf));
          runUploadQueueRef.current();
        }, 1000 * nextRetry);
        retryTimeoutsRef.current.add(retryTimer);
        return;
      }

      uploadingFilesRef.current = uploadingFilesRef.current.map((uf, idx) => idx === index ? { ...uf, status: 'error' as const, message: (e as Error).message } : uf);
      setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'error', message: (e as Error).message } : uf));
    }
  }, []);

  const runUploadQueue = useCallback(() => {
    if (uploadCancelledRef.current) return;

    // 使用 ref 读取当前状态（避免在 state updater 内执行副作用，Strict Mode 下 updater 会被双重调用）
    const current = uploadingFilesRef.current;
    if (current.length === 0) return;

    const pendingFiles = pendingValidFilesRef.current.map((f, i) => ({ file: f, index: i }))
      .filter((_, i) => {
        const uf = current[i];
        return uf && uf.status === 'pending';
      });

    const canStart = MAX_CONCURRENT - concurrentCountRef.current;
    if (canStart <= 0 || pendingFiles.length === 0) return;

    const toStart = pendingFiles.slice(0, canStart);

    // 同步更新 ref（防止快速连续调用 runUploadQueue 时重复启动同一文件）
    const updatedFiles = current.map((uf, idx) => {
      if (toStart.some(p => p.index === idx)) {
        return { ...uf, status: 'uploading' as const, progress: 5, message: '准备上传...' };
      }
      return uf;
    });
    uploadingFilesRef.current = updatedFiles;
    setUploadingFiles(updatedFiles);

    // 在 state updater 外部启动上传（避免 Strict Mode 双重调用导致重复上传）
    toStart.forEach(({ file, index }) => {
      concurrentCountRef.current++;
      const needsCompression = pendingCompressionIndicesRef.current.has(index);
      const method = needsCompression ? (pendingCompressionMethodRef.current || 'server') : 'none';
      const uf = current[index];
      const retryCount = uf ? uf.retryCount : 0;
      uploadSingleFile(file, index, retryCount, method).then(() => {
        concurrentCountRef.current--;
        runUploadQueueRef.current();
        // 即时完成检测（使用 state updater 读取最新状态，因为 uploadSingleFile 刚设置了 done 但 ref 可能未同步）
        setUploadingFiles(prev => {
          const isAllDone = prev.length > 0 && uploadsStartedRef.current &&
            prev.every(f => f.status === 'done' || f.status === 'error' || f.status === 'cancelled');
          if (isAllDone && !compressionDecisionPendingRef.current && concurrentCountRef.current === 0) {
            if (completionCheckRef.current) {
              clearInterval(completionCheckRef.current);
              completionCheckRef.current = null;
            }
            setAllDone(true);
          }
          return prev;
        });
      });
    });
  }, [uploadSingleFile]);

  runUploadQueueRef.current = runUploadQueue;

  // 完成检测
  const setupCompletionCheck = useCallback(() => {
    if (completionCheckRef.current) {
      clearInterval(completionCheckRef.current);
    }
    const checkComplete = setInterval(() => {
      setUploadingFiles(current => {
        const isAllDone = current.length > 0 && uploadsStartedRef.current && current.every(f => f.status === 'done' || f.status === 'error' || f.status === 'cancelled');
        if (isAllDone && !compressionDecisionPendingRef.current && concurrentCountRef.current === 0) {
          if (completionCheckRef.current) {
            clearInterval(completionCheckRef.current);
            completionCheckRef.current = null;
          }
          setAllDone(true);
        }
        return current;
      });
    }, 500);
    completionCheckRef.current = checkComplete;
  }, []);

  // ================ 压缩选择处理 ================

  const handleCompressionDecision = useCallback(async (method: 'server' | 'browser' | 'aliyun' | 'cancel') => {
    if (method === 'cancel') {
      // 取消压缩 = 取消整个上传
      setPendingCompressionFiles([]);
      setPendingCompressionDecision(null);
      setPendingCompressionVideo(null);
      compressionDecisionPendingRef.current = false;
      pendingCompressionMethodRef.current = null;
      pendingCompressionIndicesRef.current = new Set();

      // 标记所有文件为已取消
      setUploadingFiles(prev => prev.map(uf => ({ ...uf, status: 'cancelled' as const, message: '已取消' })));
      setAllDone(true);
      return;
    }

    pendingCompressionMethodRef.current = method;
    pendingCompressionIndicesRef.current = new Set(pendingCompressionFiles.map(c => c.index));
    compressionDecisionPendingRef.current = false;
    // 标记上传已启动（必须在队列调用之前设置，防止完成检测误判）
    uploadsStartedRef.current = true;

    // 同步更新 ref（确保 setTimeout 中 runUploadQueue 读取到正确状态）
    // 将所有文件设为 pending（包括不需要压缩的文件），确保所有文件都能被队列启动
    const updatedFiles = uploadingFilesRef.current.map((uf, idx) => {
      const needsCompress = pendingCompressionFiles.some(c => c.index === idx);
      if (needsCompress) {
        return { ...uf, status: 'pending' as const, progress: 0, message: '准备压缩上传...' };
      }
      // 非压缩文件也确保设为 pending（可能之前是 detecting 状态）
      if (uf.status === 'detecting' || uf.status === 'pending') {
        return { ...uf, status: 'pending' as const, progress: 0, message: '准备上传...' };
      }
      return uf;
    });
    uploadingFilesRef.current = updatedFiles;
    setUploadingFiles(updatedFiles);

    setPendingCompressionFiles([]);
    setPendingCompressionDecision(null);
    setPendingCompressionVideo(null);

    // 创建新的 AbortController
    uploadAbortControllerRef.current = new AbortController();
    // 延迟启动上传队列，确保 setUploadingFiles 的状态更新已刷新
    // 避免 runUploadQueue 读取到旧状态（文件仍为 detecting）导致无法启动上传
    setTimeout(() => {
      setupCompletionCheck();
      runUploadQueueRef.current();
    }, 0);
  }, [pendingCompressionFiles, setupCompletionCheck]);

  // ================ 确认/取消 ================

  const handleConfirm = useCallback(() => {
    const results = uploadResultsRef.current;
    resolveRef.current?.(results);
    cleanup();
  }, []);

  const handleCancelDialog = useCallback(() => {
    // 取消上传
    uploadCancelledRef.current = true;
    if (uploadAbortControllerRef.current) {
      uploadAbortControllerRef.current.abort();
      uploadAbortControllerRef.current = null;
    }
    // 返回空结果
    resolveRef.current?.([]);
    cleanup();
  }, []);

  function cleanup() {
    setIsDialogOpen(false);
    setUploadingFiles([]);
    uploadingFilesRef.current = [];
    setPendingCompressionFiles([]);
    setPendingCompressionDecision(null);
    setPendingCompressionVideo(null);
    setAllDone(false);
    uploadResultsRef.current = [];
    uploadCancelledRef.current = false;
    concurrentCountRef.current = 0;
    uploadsStartedRef.current = false;
    compressionDecisionPendingRef.current = false;
    pendingCompressionMethodRef.current = null;
    pendingCompressionIndicesRef.current = new Set();
    uploadAbortControllerRef.current = null;
    currentOptionsRef.current = null;
    resolveRef.current = null;
    if (completionCheckRef.current) {
      clearInterval(completionCheckRef.current);
      completionCheckRef.current = null;
    }
    retryTimeoutsRef.current.forEach(t => clearTimeout(t));
    retryTimeoutsRef.current.clear();
  }

  // ================ 重试失败项 ================

  const retryFailedFiles = useCallback(() => {
    // 同步更新 ref（runUploadQueue 依赖 ref 读取最新状态）
    const updated = uploadingFilesRef.current.map(uf => {
      if (uf.status === 'error') {
        return { ...uf, status: 'pending' as const, progress: 0, retryCount: 0, message: '等待重试...' };
      }
      return uf;
    });
    uploadingFilesRef.current = updated;
    setUploadingFiles(updated);

    uploadCancelledRef.current = false;
    setAllDone(false);
    runUploadQueueRef.current();
    setupCompletionCheck();
  }, [setupCompletionCheck]);

  // ================ startUpload 入口 ================

  const startUpload = useCallback((options: UploadOptions): Promise<UploadItemResult[]> => {
    return new Promise<UploadItemResult[]>((resolve) => {
      // 保存选项和回调
      currentOptionsRef.current = options;
      resolveRef.current = resolve;
      uploadResultsRef.current = [];
      uploadCancelledRef.current = false;
      setAllDone(false);

      // 创建隐藏的 file input
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = options.accept || 'image/*,video/*';
      input.multiple = options.multiple ?? false;
      input.style.display = 'none';

      input.onchange = async (e) => {
        const target = e.target as HTMLInputElement;
        if (!target.files || target.files.length === 0) {
          resolve([]);
          return;
        }

        let files = Array.from(target.files);

        // 过滤不支持的文件
        const valid = files.filter(f => {
          const d = detectFileType(f);
          return d.supported;
        });

        if (valid.length === 0) {
          resolve([]);
          return;
        }

        // 检查数量限制（currentCount + 选中文件数 > maxFiles）
        const currentCount = options.currentCount ?? 0;
        const maxAllowed = options.maxFiles ?? Number.MAX_SAFE_INTEGER;
        const remaining = maxAllowed - currentCount;

        if (remaining <= 0) {
          window.alert(`已达到最大数量限制（${maxAllowed}个），无法继续添加。`);
          resolve([]);
          return;
        }

        if (valid.length > remaining) {
          window.alert(`已达到数量限制，最多还能添加 ${remaining} 个文件，但您选择了 ${valid.length} 个文件。`);
          resolve([]);
          return;
        }

        // 多选时限制最大文件数（已经在上面检查过了）
        if (options.multiple && options.maxFiles && valid.length > options.maxFiles) {
          files = valid.slice(0, options.maxFiles);
        }

        // 打开上传对话框
        setIsDialogOpen(true);

        // 初始化上传文件列表
        const initial: UploadingFile[] = valid.map(f => ({
          id: `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
          name: f.name,
          size: f.size,
          progress: 0,
          status: 'pending',
          retryCount: 0,
        }));
        setUploadingFiles(initial);
        // 同步更新 ref，确保 runUploadQueue 能立即读取到最新文件列表
        uploadingFilesRef.current = initial;
        pendingValidFilesRef.current = valid;
        concurrentCountRef.current = 0;
        pendingCompressionMethodRef.current = null;
        pendingCompressionIndicesRef.current = new Set();
        compressionDecisionPendingRef.current = false;
        uploadAbortControllerRef.current = new AbortController();

        // 完成检测
        setupCompletionCheck();

        // 检测视频码率
        const videos = valid.map((f, i) => ({ file: f, index: i }))
          .filter(({ file }) => detectFileType(file).type === 'video');

        if (videos.length > 0) {
          setUploadingFiles(prev => prev.map((uf, idx) => {
            const isVideo = videos.some(v => v.index === idx);
            return isVideo ? { ...uf, status: 'detecting' as const, progress: 10, message: '检测视频信息...' } : uf;
          }));

          // 串行检测视频码率（estimateVideoBitrate 使用全局共享 video 元素，不能并行）
          const decisions: { file: File; index: number; decision: import('../../lib/ossUtils').UploadDecision | null }[] = [];
          for (const { file, index } of videos) {
            try {
              const decision = await checkVideoBitrate(file);
              decisions.push({ file, index, decision });
            } catch (e) {
              console.error('检测视频失败:', file.name, e);
              decisions.push({ file, index, decision: null });
            }
          }

          const needCompression = decisions.filter(d => d.decision?.decision === 'must_compress');

          if (needCompression.length > 0) {
            const compressionFiles = needCompression as FileCompressionInfo[];
            setPendingCompressionFiles(compressionFiles);
            setPendingCompressionDecision(compressionFiles[0].decision);
            setPendingCompressionVideo(compressionFiles[0].file);
            compressionDecisionPendingRef.current = true;

            // 同步更新 ref：将所有文件设为 pending（检测已完成）
            const updatedFiles = uploadingFilesRef.current.map((uf, idx) => {
              const needsCompress = needCompression.some(c => c.index === idx);
              if (needsCompress) {
                return { ...uf, status: 'pending' as const, progress: 0, message: '等待压缩方式选择' };
              }
              return { ...uf, status: 'pending' as const, progress: 0, message: '等待中' };
            });
            uploadingFilesRef.current = updatedFiles;
            setUploadingFiles(updatedFiles);

            uploadAbortControllerRef.current = null;
            return;
          }
        }

        // 不需要压缩，直接开始上传
        uploadsStartedRef.current = true;
        // 视频检测完成后，将文件状态设为 pending 并同步 ref
        if (videos.length > 0) {
          const updatedFiles = uploadingFilesRef.current.map((uf, idx) => {
            const isVideo = videos.some(v => v.index === idx);
            return isVideo ? { ...uf, status: 'pending' as const, progress: 0, message: '' } : uf;
          });
          uploadingFilesRef.current = updatedFiles;
          setUploadingFiles(updatedFiles);
        }
        runUploadQueueRef.current();
      };

      // 触发文件选择
      document.body.appendChild(input);
      input.click();
      // 清理 DOM 元素
      setTimeout(() => {
        if (input.parentNode) {
          input.parentNode.removeChild(input);
        }
      }, 1000);
    });
  }, [setupCompletionCheck]);

  return (
    <UploadContext.Provider value={{ startUpload }}>
      {children}
      <UploadDialog
        isOpen={isDialogOpen}
        uploadingFiles={uploadingFiles}
        allDone={allDone}
        onConfirm={handleConfirm}
        onCancel={handleCancelDialog}
        onRetryFailed={retryFailedFiles}
      />
      <VideoCompressionDialog
        isOpen={pendingCompressionVideo !== null}
        onClose={() => handleCompressionDecision('cancel')}
        file={pendingCompressionVideo}
        decision={pendingCompressionDecision}
        compressionFiles={pendingCompressionFiles}
        aliyunConfigured={aliyunConfigured}
        onSelect={handleCompressionDecision}
      />
    </UploadContext.Provider>
  );
}
