import React, { useEffect } from 'react';
import { X, Check, AlertCircle, RotateCw } from 'lucide-react';
import type { UploadingFile } from './UploadProvider';

interface UploadDialogProps {
  isOpen: boolean;
  uploadingFiles: UploadingFile[];
  allDone: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRetryFailed: () => void;
}

export function UploadDialog({
  isOpen,
  uploadingFiles,
  allDone,
  onConfirm,
  onCancel,
  onRetryFailed,
}: UploadDialogProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';
    } else {
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
    }
    return () => {
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const isUploading = uploadingFiles.some(f => f.status === 'uploading' || f.status === 'detecting' || f.status === 'retrying');
  const successCount = uploadingFiles.filter(f => f.status === 'done').length;
  const errorCount = uploadingFiles.filter(f => f.status === 'error').length;
  const pendingCount = uploadingFiles.filter(f => f.status === 'pending').length;
  const hasErrors = errorCount > 0;

  return (
    <div
      className="fixed inset-0 z-[60] p-4 bg-black/60 backdrop-blur-sm transition-opacity duration-200 flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-xl min-h-[300px] max-h-[85vh] rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl flex flex-col shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
          <div>
            <h2 className="text-base font-semibold">上传文件</h2>
            <div className="text-xs text-slate-400 mt-0.5">
              {uploadingFiles.length > 0 && (
                <span>
                  共 {uploadingFiles.length} 个文件
                  {successCount > 0 && <span className="text-green-400 ml-2">成功 {successCount}</span>}
                  {errorCount > 0 && <span className="text-red-400 ml-2">失败 {errorCount}</span>}
                  {pendingCount > 0 && <span className="text-yellow-400 ml-2">等待 {pendingCount}</span>}
                  {isUploading && <span className="text-blue-400 ml-2">上传中...</span>}
                </span>
              )}
            </div>
          </div>
          {/* 上传中不显示关闭按钮 */}
          {!isUploading && !allDone && (
            <button
              onClick={onCancel}
              className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition text-white/60 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* 文件列表 */}
        <div className="flex-1 overflow-y-auto p-5 min-h-0">
          <div className="space-y-2">
            {uploadingFiles.map(f => (
              <div
                key={f.id}
                className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/10"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-200 truncate">{f.name}</div>
                  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mt-2">
                    <div
                      className={`h-full rounded-full transition-all ${
                        f.status === 'error' ? 'bg-red-400'
                        : f.status === 'done' ? 'bg-green-400'
                        : f.status === 'cancelled' ? 'bg-slate-500'
                        : 'bg-gradient-to-r from-violet-500 to-fuchsia-500'
                      }`}
                      style={{ width: `${f.progress}%` }}
                    />
                  </div>
                </div>
                <div className="text-xs text-right shrink-0 min-w-[60px]">
                  {f.status === 'done' ? (
                    <span className="text-green-400 flex items-center justify-end gap-1">
                      <Check className="w-3 h-3" /> 完成
                    </span>
                  ) : f.status === 'error' ? (
                    <span className="text-red-300 flex items-center justify-end gap-1">
                      <AlertCircle className="w-3 h-3" /> 失败
                    </span>
                  ) : f.status === 'cancelled' ? (
                    <span className="text-slate-500">已取消</span>
                  ) : f.status === 'detecting' ? (
                    <span className="text-blue-400">检测中</span>
                  ) : f.status === 'retrying' ? (
                    <span className="text-yellow-400 flex items-center justify-end gap-1">
                      <RotateCw className="w-3 h-3 animate-spin" /> 重试
                    </span>
                  ) : (
                    <span className="text-slate-300">{f.message || `${f.progress}%`}</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* 失败重试按钮 */}
          {hasErrors && !isUploading && (
            <div className="mt-4 text-center">
              <button
                onClick={onRetryFailed}
                className="px-4 py-2 rounded-full text-xs text-violet-300 hover:text-violet-200 hover:bg-violet-500/10 transition inline-flex items-center gap-1.5"
              >
                <RotateCw className="w-3.5 h-3.5" />
                重试失败项
              </button>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-5 py-4 border-t border-white/10 shrink-0 flex items-center justify-end gap-3">
          {allDone ? (
            <>
              <button
                onClick={onCancel}
                className="px-5 py-2.5 rounded-xl border border-white/15 text-sm text-slate-300 hover:bg-white/10 transition"
              >
                取消
              </button>
              <button
                onClick={onConfirm}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white text-sm font-medium transition"
              >
                确认
              </button>
            </>
          ) : isUploading ? (
            <button
              onClick={onCancel}
              className="px-5 py-2.5 rounded-xl border border-white/15 text-sm text-slate-300 hover:bg-white/10 transition"
            >
              取消上传
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
