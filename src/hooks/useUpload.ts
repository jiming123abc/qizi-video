import { useState, useRef, useEffect, useCallback } from 'react';
import {
  uploadVideo2Image,
  uploadVideo2Video,
  uploadVideo2FromUrl,
  detectFileType,
  checkVideoBitrate,
} from '../lib/ossUtils';
import type { UploadDecision } from '../lib/ossUtils';

export interface UploadingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled' | 'pending';
  message?: string;
  retryCount: number;
}

export interface UseUploadOptions {
  projectId: number;
  currentSceneId: number | null;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onUploadComplete?: () => void;
  loadShots?: () => void | Promise<void>;
  loadStats?: () => void | Promise<void>;
  loadProject?: () => void | Promise<void>;
}

export function useUpload(options: UseUploadOptions) {
  const { projectId, currentSceneId, showToast, onUploadComplete, loadShots, loadStats, loadProject } = options;

  const [uploadTab, setUploadTab] = useState<'file' | 'url'>('file');
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [urlInputValue, setUrlInputValue] = useState('');
  const [urlError, setUrlError] = useState('');

  const [pendingCompressionVideo, setPendingCompressionVideo] = useState<File | null>(null);
  const [pendingCompressionDecision, setPendingCompressionDecision] = useState<UploadDecision | null>(null);
  const [pendingUploadIndex, setPendingUploadIndex] = useState<number>(-1);
  const pendingValidFilesRef = useRef<File[]>([]);
  const uploadCancelledRef = useRef(false);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const concurrentCountRef = useRef(0);
  const maxConcurrent = 5;
  const maxRetries = 2;

  const [aliyunConfigured, setAliyunConfigured] = useState(false);

  useEffect(() => {
    fetch('/api/video2/aliyun/status')
      .then(res => res.json())
      .then(data => setAliyunConfigured(data.configured || false))
      .catch(() => {});
  }, []);

  const refreshAfterUpload = useCallback(async () => {
    if (loadShots) await loadShots();
    if (loadStats) await loadStats();
    if (loadProject) await loadProject();
    onUploadComplete?.();
  }, [loadShots, loadStats, loadProject, onUploadComplete]);

  const uploadSingleFile = useCallback(async (file: File, index: number, retry: number = 0) => {
    if (uploadCancelledRef.current) {
      setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'cancelled', progress: 0, message: '已取消' } : uf));
      return;
    }

    const detected = detectFileType(file);

    try {
      if (detected.type === 'video') {
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, progress: 5, message: '检测视频信息...' } : uf));
        const decision = await checkVideoBitrate(file);
        if (decision.decision === 'must_compress') {
          setUploadingFiles(prev => prev.map((uf, idx) => {
            if (idx === index) {
              return { ...uf, status: 'error', progress: 0, message: '需选择压缩方式' };
            } else if (uf.status === 'pending') {
              return { ...uf, status: 'pending', progress: 0, message: '等待中' };
            }
            return uf;
          }));
          setPendingCompressionVideo(file);
          setPendingCompressionDecision(decision);
          setPendingUploadIndex(index);
          return;
        }
      }

      setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'uploading', progress: 5 } : uf));

      if (detected.type === 'image') {
        await uploadVideo2Image(file, {
          projectId,
          sceneId: currentSceneId !== null ? currentSceneId : undefined,
          title: file.name,
          createShot: true,
          signal: uploadAbortControllerRef.current?.signal
        });
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf));
      } else {
        await uploadVideo2Video(file, {
          projectId,
          sceneId: currentSceneId !== null ? currentSceneId : undefined,
          title: file.name,
          createShot: true,
          compressionMethod: 'none',
          skipBitrateCheck: true,
          signal: uploadAbortControllerRef.current?.signal,
          onProgress: p => {
            setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, progress: p.progress, message: p.message } : uf));
          }
        });
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf));
      }
    } catch (e) {
      if (uploadCancelledRef.current) {
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'cancelled', progress: 0, message: '已取消' } : uf));
        return;
      }
      console.error('上传失败:', file.name, e);
      
      if (retry < maxRetries) {
        const nextRetry = retry + 1;
        setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, retryCount: nextRetry, progress: 0, status: 'pending', message: `准备重试 ${nextRetry}/${maxRetries}` } : uf));
        setTimeout(() => {
          uploadSingleFile(file, index, nextRetry);
        }, 1000 * nextRetry);
        return;
      }
      
      setUploadingFiles(prev => prev.map((uf, idx) => idx === index ? { ...uf, status: 'error', message: (e as Error).message } : uf));
    }
  }, [projectId, currentSceneId]);

  const handleUploadFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    const valid = list.filter(f => {
      const d = detectFileType(f);
      if (!d.supported) {
        showToast(`忽略不支持的文件：${f.name}`);
      }
      return d.supported;
    });
    if (valid.length === 0) return;

    const initial: UploadingFile[] = valid.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`,
      name: f.name, size: f.size, progress: 0, status: 'pending',
      retryCount: 0
    }));
    setUploadingFiles(initial);
    pendingValidFilesRef.current = valid;
    uploadCancelledRef.current = false;
    uploadAbortControllerRef.current = new AbortController();
    concurrentCountRef.current = 0;

    const runUploadQueue = () => {
      if (uploadCancelledRef.current) return;

      setUploadingFiles(current => {
        const pendingFiles = valid.map((f, i) => ({ file: f, index: i }))
          .filter((_, i) => {
            const uf = current[i];
            return uf && uf.status === 'pending';
          });

        const canStart = maxConcurrent - concurrentCountRef.current;
        if (canStart <= 0 || pendingFiles.length === 0) return current;

        const toStart = pendingFiles.slice(0, canStart);
        toStart.forEach(({ file, index }) => {
          concurrentCountRef.current++;
          uploadSingleFile(file, index, 0).then(() => {
            concurrentCountRef.current--;
            runUploadQueue();
          });
        });

        return current.map((uf, idx) => {
          if (toStart.some(p => p.index === idx)) {
            return { ...uf, status: 'uploading' as const, progress: 5 };
          }
          return uf;
        });
      });
    };

    setUploadingFiles(prev => prev.map((uf, idx) => idx < maxConcurrent ? { ...uf, status: 'uploading', progress: 5 } : uf));
    
    for (let i = 0; i < Math.min(maxConcurrent, valid.length); i++) {
      concurrentCountRef.current++;
      uploadSingleFile(valid[i], i, 0).then(() => {
        concurrentCountRef.current--;
        runUploadQueue();
      });
    }

    const checkComplete = setInterval(() => {
      setUploadingFiles(current => {
        const isAllDone = current.every(f => f.status === 'done' || f.status === 'error' || f.status === 'cancelled');
        const isCompressionPending = pendingCompressionVideo !== null;
        if (isAllDone && !isCompressionPending && concurrentCountRef.current === 0) {
          clearInterval(checkComplete);
          setTimeout(() => {
            refreshAfterUpload();
            const successCount = current.filter(f => f.status === 'done').length;
            const errorCount = current.filter(f => f.status === 'error').length;
            if (errorCount === 0) {
              showToast(`上传完成（${successCount} 项）`);
            } else {
              showToast(`上传完成（成功 ${successCount} 项，失败 ${errorCount} 项）`);
            }
          }, 0);
        }
        return current;
      });
    }, 500);

    uploadAbortControllerRef.current = null;
  }, [projectId, currentSceneId, showToast, refreshAfterUpload, uploadSingleFile, pendingCompressionVideo]);

  const cancelUpload = useCallback(() => {
    uploadCancelledRef.current = true;
    if (uploadAbortControllerRef.current) {
      uploadAbortControllerRef.current.abort();
    }
  }, []);

  const handleCompressionDecision = useCallback(async (method: 'server' | 'browser' | 'aliyun' | 'cancel') => {
    if (!pendingCompressionVideo || !pendingCompressionDecision || pendingUploadIndex < 0) {
      setPendingCompressionVideo(null);
      setPendingCompressionDecision(null);
      setPendingUploadIndex(-1);
      return;
    }

    const videoFile = pendingCompressionVideo;
    const idx = pendingUploadIndex;

    setPendingCompressionVideo(null);
    setPendingCompressionDecision(null);
    setPendingUploadIndex(-1);

    if (method === 'cancel') {
      return;
    }

    setUploadingFiles(prev => prev.map((uf, i) => i === idx ? { ...uf, status: 'uploading', progress: 10, message: '准备上传...' } : uf));

    (async () => {
      try {
        await uploadVideo2Video(videoFile, {
          projectId,
          sceneId: currentSceneId !== null ? currentSceneId : undefined,
          title: videoFile.name,
          createShot: true,
          compressionMethod: method,
          skipBitrateCheck: true,
          onProgress: p => {
            setUploadingFiles(prev => prev.map((uf, i) => i === idx ? { ...uf, progress: p.progress, message: p.message } : uf));
          }
        });
        setUploadingFiles(prev => prev.map((uf, i) => i === idx ? { ...uf, progress: 100, status: 'done', message: '完成' } : uf));
        await refreshAfterUpload();
      } catch (e) {
        console.error('上传失败:', videoFile.name, e);
        setUploadingFiles(prev => prev.map((uf, i) => i === idx ? { ...uf, status: 'error', message: (e as Error).message } : uf));
      }
    })();
  }, [pendingCompressionVideo, pendingCompressionDecision, pendingUploadIndex, projectId, currentSceneId, refreshAfterUpload]);

  const handleUploadFromUrl = useCallback(async () => {
    const url = urlInputValue.trim();
    if (!url) return;
    const newItem: UploadingFile = {
      id: `${Date.now()}-url`,
      name: url.substring(0, 50) + '...',
      size: 0,
      progress: 20,
      status: 'uploading',
      retryCount: 0
    };
    setUploadingFiles(prev => [...prev, newItem]);
    try {
      await uploadVideo2FromUrl(url, {
        projectId,
        sceneId: currentSceneId !== null ? currentSceneId : undefined,
        title: url
      });
      setUploadingFiles(prev => prev.map(uf => uf.id === newItem.id ? { ...uf, progress: 100, status: 'done', message: '转存完成' } : uf));
      setUrlInputValue('');
      await refreshAfterUpload();
    } catch (e) {
      setUploadingFiles(prev => prev.map(uf => uf.id === newItem.id ? { ...uf, status: 'error', message: String(e) } : uf));
    }
  }, [urlInputValue, projectId, currentSceneId, refreshAfterUpload]);

  const clearUploadingFiles = useCallback(() => {
    setUploadingFiles([]);
  }, []);

  const retryFailedFiles = useCallback(() => {
    setUploadingFiles(current => {
      const failedIndices = current
        .map((uf, idx) => ({ uf, idx }))
        .filter(({ uf }) => uf.status === 'error')
        .map(({ idx }) => idx);

      if (failedIndices.length === 0) return current;

      failedIndices.forEach(index => {
        const file = pendingValidFilesRef.current[index];
        if (file) {
          concurrentCountRef.current++;
          uploadSingleFile(file, index, 0).then(() => {
            concurrentCountRef.current--;
          });
        }
      });

      return current.map((uf, idx) => {
        if (failedIndices.includes(idx)) {
          return { ...uf, status: 'uploading' as const, progress: 5, retryCount: 0, message: '重试中...' };
        }
        return uf;
      });
    });
  }, [uploadSingleFile]);

  return {
    uploadingFiles,
    setUploadingFiles,
    uploadTab,
    setUploadTab,
    urlInputValue,
    setUrlInputValue,
    urlError,
    setUrlError,
    pendingCompressionVideo,
    pendingCompressionDecision,
    handleUploadFiles,
    handleUploadFromUrl,
    cancelUpload,
    handleCompressionDecision,
    aliyunConfigured,
    clearUploadingFiles,
    retryFailedFiles,
  };
}
