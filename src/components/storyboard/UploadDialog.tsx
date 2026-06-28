import { Upload, Link2, Image as ImageIcon, X } from 'lucide-react';
import type { UploadDecision } from '../../lib/ossUtils';
import { VideoCompressionDialog } from './VideoCompressionDialog';

interface UploadingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled';
  message?: string;
}

interface UploadDialogProps {
  isOpen: boolean;
  onClose: () => void;
  uploadTab: 'file' | 'url';
  setUploadTab: (tab: 'file' | 'url') => void;
  uploadingFiles: UploadingFile[];
  urlInputValue: string;
  setUrlInputValue: (val: string) => void;
  urlError: string;
  onUploadFiles: (files: File[]) => void;
  onUploadFromUrl: () => void;
  onCancelUpload: () => void;
  pendingCompressionVideo: File | null;
  pendingCompressionDecision: UploadDecision | null;
  onCompressionDecision: (method: 'server' | 'browser' | 'aliyun' | 'cancel') => void;
  aliyunConfigured: boolean;
  currentSceneName?: string;
}

export function UploadDialog({
  isOpen,
  onClose,
  uploadTab,
  setUploadTab,
  uploadingFiles,
  urlInputValue,
  setUrlInputValue,
  urlError,
  onUploadFiles,
  onUploadFromUrl,
  onCancelUpload,
  pendingCompressionVideo,
  pendingCompressionDecision,
  onCompressionDecision,
  aliyunConfigured,
  currentSceneName,
}: UploadDialogProps) {
  if (!isOpen) return null;

  const isUploading = uploadingFiles.some(f => f.status === 'uploading');

  const handleBackdropClick = () => {
    onClose();
  };

  const handleCloseClick = () => {
    onClose();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      onUploadFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const handleUrlInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUrlInputValue(e.target.value);
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !urlError) {
      onUploadFromUrl();
    }
  };

  const handleClearAndClose = () => {
    onCancelUpload();
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={handleBackdropClick}>
        <div className="w-full max-w-xl rounded-3xl border border-white/10 bg-slate-900/95 backdrop-blur-xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold">批量上传</h2>
              {currentSceneName !== undefined && (
                <p className="text-xs text-slate-400 mt-0.5">
                  当前场次：{currentSceneName}
                </p>
              )}
            </div>
            <button onClick={handleCloseClick} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex gap-2 mb-4 bg-white/5 p-1 rounded-2xl">
            <button
              onClick={() => setUploadTab('file')}
              className={`flex-1 py-2 text-sm rounded-xl transition ${uploadTab === 'file' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              <Upload className="w-4 h-4 inline mr-1.5" /> 选择文件
            </button>
            <button
              onClick={() => setUploadTab('url')}
              className={`flex-1 py-2 text-sm rounded-xl transition ${uploadTab === 'url' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              <Link2 className="w-4 h-4 inline mr-1.5" /> 网络 URL
            </button>
          </div>

          {uploadTab === 'file' ? (
            <div>
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
                <p className="text-xs text-slate-500">支持多选，非图片视频文件会被自动忽略</p>
              </label>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={urlInputValue}
                  onChange={handleUrlInputChange}
                  placeholder="https://example.com/image.jpg 或 https://example.com/video.mp4"
                  className={`flex-1 px-4 py-2.5 rounded-xl bg-white/5 border outline-none text-sm transition ${
                    urlError ? 'border-red-500/50 focus:border-red-400/60' : 'border-white/10 focus:border-violet-400/50'
                  }`}
                  onKeyDown={handleUrlKeyDown}
                />
                <button
                  onClick={onUploadFromUrl}
                  disabled={!urlInputValue.trim() || !!urlError}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white text-sm font-medium disabled:opacity-40 transition"
                >转存</button>
              </div>
              <p className={'text-xs mt-2 ' + (urlError ? 'text-red-400' : 'text-slate-500')}>
                {urlError || 'URL 必须是公开可访问资源链接'}
              </p>
            </div>
          )}

          {uploadingFiles.length > 0 && (
            <div className="mt-5 space-y-2">
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
              <div className="text-center pt-2">
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
        aliyunConfigured={aliyunConfigured}
        onSelect={onCompressionDecision}
      />
    </>
  );
}
