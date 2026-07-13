import React from 'react';
import { Image as ImageIcon, X } from 'lucide-react';
import type { UploadDecision } from '../../lib/ossUtils';
import type { FileCompressionInfo } from '../../hooks/useUpload';
import { VideoCompressionDialog } from './VideoCompressionDialog';

interface UploadingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled' | 'pending' | 'detecting';
  message?: string;
}

interface UploadDialogProps {
  isOpen: boolean;
  onClose: () => void;
  uploadingFiles: UploadingFile[];
  onUploadFiles: (files: File[]) => void;
  onCancelUpload: () => void;
  pendingCompressionVideo: File | null;
  pendingCompressionDecision: UploadDecision | null;
  pendingCompressionFiles?: FileCompressionInfo[];
  onCompressionDecision: (method: 'server' | 'browser' | 'aliyun' | 'cancel') => void;
  aliyunConfigured: boolean;
  currentSceneName?: string;
  onRetryFailed: () => void;
  maxFiles?: number;
}

export function UploadDialog({
  isOpen,
  onClose,
  uploadingFiles,
  onUploadFiles,
  onCancelUpload,
  pendingCompressionVideo,
  pendingCompressionDecision,
  pendingCompressionFiles = [],
  onCompressionDecision,
  aliyunConfigured,
  currentSceneName,
  onRetryFailed,
  maxFiles = 200,
}: UploadDialogProps) {
  if (!isOpen) return null;

  const isUploading = uploadingFiles.some(f => f.status === 'uploading');
  const successCount = uploadingFiles.filter(f => f.status === 'done').length;
  const errorCount = uploadingFiles.filter(f => f.status === 'error').length;
  const pendingCount = uploadingFiles.filter(f => f.status === 'pending').length;

  const handleBackdropClick = () => {
    onClose();
  };

  const handleCloseClick = () => {
    onClose();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files) as File[];
      if (files.length > maxFiles) {
        onUploadFiles(files.slice(0, maxFiles));
      } else {
        onUploadFiles(files);
      }
      e.target.value = '';
    }
  };

  const handleClearAndClose = () => {
    onCancelUpload();
  };

  return (
    <>
      <div className={`fixed inset-0 z-[60] p-5 sm:p-4 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${pendingCompressionVideo !== null ? 'opacity-0 pointer-events-none' : 'opacity-100'}`} onClick={handleBackdropClick}>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-xl max-h-[85vh] rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl flex flex-col shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4 shrink-0">
            <div>
              <h2 className="text-base font-semibold">批量上传</h2>
              {currentSceneName !== undefined && (
                <p className="text-xs text-slate-400 mt-0.5">
                  当前场次：{currentSceneName}
                </p>
              )}
            </div>
            <button onClick={handleCloseClick} className="touch-target-36 w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            <label className="block border-2 border-dashed border-white/15 hover:border-violet-400/40 rounded-2xl p-8 text-center cursor-pointer transition bg-white/[0.02]">
              <input
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden"
                onChange={handleFileInputChange}
              />
              <ImageIcon className="w-10 h-10 mx-auto mb-3 text-violet-300/60" />
              <p className="text-sm font-medium mb-1">点击选择图片或视频</p>
              <p className="text-xs text-slate-500">支持多选，最多 {maxFiles} 个文件，非图片视频文件会被自动忽略</p>
            </label>
          </div>

          {uploadingFiles.length > 0 && (
            <div className="mt-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs text-slate-400">
                  {successCount > 0 && <span className="text-green-400 mr-3">成功 {successCount}</span>}
                  {errorCount > 0 && <span className="text-red-400 mr-3">失败 {errorCount}</span>}
                  {pendingCount > 0 && <span className="text-yellow-400 mr-3">等待 {pendingCount}</span>}
                  {isUploading && <span className="text-blue-400">上传中...</span>}
                </div>
                {errorCount > 0 && !isUploading && (
                  <button
                    onClick={onRetryFailed}
                    className="px-3 py-1 rounded-full text-xs text-violet-300 hover:text-violet-200 hover:bg-violet-500/10 transition"
                  >重试失败项</button>
                )}
              </div>
              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                {uploadingFiles.map(f => (
                  <div key={f.id} className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/10">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-200 truncate">{f.name}</div>
                      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mt-2">
                        <div
                          className={`h-full rounded-full transition-all ${f.status === 'error' ? 'bg-red-400' : f.status === 'done' ? 'bg-green-400' : 'bg-gradient-to-r from-violet-500 to-fuchsia-500'}`}
                          style={{ width: `${f.progress}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-xs text-right">
                      {f.status === 'error' ? (
                        <span className="text-red-300">{f.message || '失败'}</span>
                      ) : (
                        <span className="text-slate-300">{f.message || `${f.progress}%`}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-center pt-3">
                <button
                  onClick={handleClearAndClose}
                  className="px-4 py-2 rounded-full text-xs text-slate-400 hover:text-white hover:bg-white/5 transition"
                >{uploadingFiles.every(f => f.status !== 'uploading') ? '关闭' : '完成后可点击关闭'}</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <VideoCompressionDialog
        isOpen={pendingCompressionVideo !== null}
        onClose={() => onCompressionDecision('cancel')}
        file={pendingCompressionVideo}
        decision={pendingCompressionDecision}
        compressionFiles={pendingCompressionFiles}
        aliyunConfigured={aliyunConfigured}
        onSelect={onCompressionDecision}
      />
    </>
  );
}
