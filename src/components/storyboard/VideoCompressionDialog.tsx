import React from 'react';
import { X, Server, Monitor, Hand, AlertTriangle, Cloud, FileVideo } from 'lucide-react';
import type { UploadDecision } from '../../lib/ossUtils';
import type { FileCompressionInfo } from '../../hooks/useUpload';

interface VideoCompressionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  file: File | null;
  decision: UploadDecision | null;
  compressionFiles?: FileCompressionInfo[];
  aliyunConfigured?: boolean;
  onSelect: (method: 'server' | 'browser' | 'aliyun' | 'cancel') => void;
}

export function VideoCompressionDialog({
  isOpen,
  onClose,
  file,
  decision,
  compressionFiles = [],
  aliyunConfigured = false,
  onSelect,
}: VideoCompressionDialogProps) {
  if (!isOpen || !decision) return null;

  const canServerCompress = decision.fileSizeMBNum <= 95;
  const canAliyunCompress = aliyunConfigured;
  const fileSizeMB = decision.fileSizeMB;
  const bitrateKbps = decision.bitrateKbps;
  const targetBitrateKbps = decision.targetBitrateKbps;
  const resolution = decision.resolution || 'other';

  const isMultiple = compressionFiles.length > 1;

  return (
    <div className="fixed inset-0 z-[70] p-4 bg-black/60 backdrop-blur-sm">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg max-h-[85vh] bg-[#1a1530] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
          <h3 className="text-base font-semibold text-white">视频码率过高</h3>
          <button
            onClick={() => onSelect('cancel')}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition text-white/60 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 flex-1 overflow-y-auto">
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-400/20">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-amber-200 font-medium">
                  {isMultiple 
                    ? `${compressionFiles.length} 个视频文件码率超过限制` 
                    : '视频文件码率超过限制'}
                </p>
                <p className="mt-0.5 text-xs text-amber-200/70">
                  当前码率 {bitrateKbps} Kbps，建议压缩至 {targetBitrateKbps} Kbps
                </p>
              </div>
            </div>
          </div>

          {isMultiple && (
            <div className="space-y-2">
              <p className="text-xs text-white/50 font-medium">需要压缩的文件：</p>
              <div className="max-h-40 overflow-y-auto space-y-2 pr-1">
                {compressionFiles.map((cf, idx) => (
                  <div 
                    key={`${cf.index}-${cf.file.name}`}
                    className="flex items-center gap-2 p-2 rounded-lg bg-white/5"
                  >
                    <FileVideo className="w-4 h-4 text-violet-400" />
                    <span className="text-xs text-white/80 truncate flex-1">
                      {cf.file.name}
                    </span>
                    <span className="text-xs text-amber-400">
                      {(cf.decision?.fileSizeMB || '').toString().substring(0, 5)}MB
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3">
            <button
              onClick={() => onSelect('server')}
              disabled={!canServerCompress}
              className={`w-full p-3 rounded-xl border ${
                canServerCompress 
                  ? 'border-violet-500/30 bg-violet-500/10 hover:bg-violet-500/20' 
                  : 'border-white/10 bg-white/[0.02]'
              } text-left transition cursor-pointer`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                  canServerCompress ? 'bg-violet-500/20 text-violet-300' : 'bg-white/5 text-white/30'
                }`}>
                  <Server className="w-4.5 h-4.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${canServerCompress ? 'text-white' : 'text-white/40'}`}>
                      服务端压缩
                    </span>
                    {!canServerCompress && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-white/10 text-white/50">
                        不可用
                      </span>
                    )}
                  </div>
                  <div className={`mt-0.5 text-xs ${canServerCompress ? 'text-white/60' : 'text-white/30'}`}>
                    速度快 · ffmpeg 专业处理 · 免费
                    {!canServerCompress && <span className="text-amber-300/70"> · 限 ≤95MB</span>}
                  </div>
                  {!canServerCompress && (
                    <p className="mt-1 text-xs text-amber-300/70">
                      部分文件超过 95MB，服务端暂不支持
                    </p>
                  )}
                </div>
              </div>
            </button>

            <button
              onClick={() => onSelect('browser')}
              className="w-full p-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-left transition cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-cyan-500/20 text-cyan-300 flex items-center justify-center shrink-0">
                  <Monitor className="w-4.5 h-4.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-white">浏览器端压缩</span>
                  <p className="mt-0.5 text-xs text-white/60">
                    本地处理 · 隐私安全 · 速度取决于电脑性能
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => onSelect('aliyun')}
              disabled={!canAliyunCompress}
              className={`w-full p-3 rounded-xl border ${
                canAliyunCompress 
                  ? 'border-orange-500/30 bg-orange-500/10 hover:bg-orange-500/20' 
                  : 'border-white/10 bg-white/[0.02]'
              } text-left transition cursor-pointer`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                  canAliyunCompress ? 'bg-orange-500/20 text-orange-300' : 'bg-white/5 text-white/30'
                }`}>
                  <Cloud className="w-4.5 h-4.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${canAliyunCompress ? 'text-white' : 'text-white/40'}`}>
                      阿里云压缩
                    </span>
                    {!canAliyunCompress && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-white/10 text-white/50">
                        不可用
                      </span>
                    )}
                  </div>
                  <div className={`mt-0.5 text-xs ${canAliyunCompress ? 'text-white/60' : 'text-white/30'}`}>
                    云端专业压缩 · 无大小限制 · 约 ¥0.5-2/5分钟
                  </div>
                  {!canAliyunCompress && (
                    <p className="mt-1 text-xs text-amber-300/70">
                      需配置阿里云 AccessKey
                    </p>
                  )}
                </div>
              </div>
            </button>

            <button
              onClick={() => onSelect('cancel')}
              className="w-full p-3 rounded-xl border border-dashed border-white/15 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/25 text-left transition cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-white/5 text-white/50 flex items-center justify-center shrink-0">
                  <Hand className="w-4.5 h-4.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-white/80">手动压缩后再上传</span>
                  <p className="mt-0.5 text-xs text-white/50">
                    💡 使用 HandBrake 等工具压缩后重新上传
                  </p>
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
