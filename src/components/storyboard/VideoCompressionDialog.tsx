import React from 'react';
import { X, Server, Monitor, Hand, AlertTriangle, Cloud } from 'lucide-react';
import type { UploadDecision } from '../../lib/ossUtils';

interface VideoCompressionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  file: File | null;
  decision: UploadDecision | null;
  aliyunConfigured?: boolean;
  onSelect: (method: 'server' | 'browser' | 'aliyun' | 'cancel') => void;
}

export function VideoCompressionDialog({
  isOpen,
  onClose,
  file,
  decision,
  aliyunConfigured = false,
  onSelect,
}: VideoCompressionDialogProps) {
  if (!isOpen || !file || !decision) return null;

  const canServerCompress = decision.fileSizeMBNum <= 95;
  const canAliyunCompress = aliyunConfigured;
  const fileSizeMB = decision.fileSizeMB;
  const bitrateKbps = decision.bitrateKbps;
  const targetBitrateKbps = decision.targetBitrateKbps;
  const resolution = decision.resolution || 'other';

  return (
    <div className="fixed inset-0 z-[60] p-4 bg-black/60 backdrop-blur-sm">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-[#1a1530] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <h3 className="text-base font-semibold text-white">视频码率过高</h3>
          <button
            onClick={() => onSelect('cancel')}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center transition text-white/60 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-400/20">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-amber-200">检测到视频码率较高</p>
                <div className="text-xs text-amber-200/70 space-y-0.5">
                  <p>当前码率：<span className="text-amber-100 font-medium">{bitrateKbps?.toLocaleString() || '未知'} kbps</span></p>
                  <p>目标码率：<span className="text-amber-100 font-medium">{targetBitrateKbps.toLocaleString()} kbps</span>（{resolution}）</p>
                  <p>文件大小：<span className="text-amber-100 font-medium">{fileSizeMB} MB</span></p>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm text-white/80 font-medium">请选择压缩方式：</p>

            <button
              onClick={() => onSelect('server')}
              disabled={!canServerCompress}
              className={`w-full p-3 rounded-xl border text-left transition ${
                canServerCompress
                  ? 'border-green-400/30 bg-green-500/10 hover:bg-green-500/20 hover:border-green-400/50 cursor-pointer'
                  : 'border-white/10 bg-white/[0.02] opacity-50 cursor-not-allowed'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                  canServerCompress ? 'bg-green-500/20 text-green-300' : 'bg-white/5 text-white/30'
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
                        不支持
                      </span>
                    )}
                    {canServerCompress && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-300">
                        推荐
                      </span>
                    )}
                  </div>
                  <div className={`mt-0.5 text-xs ${canServerCompress ? 'text-white/60' : 'text-white/30'}`}>
                    速度快 · ffmpeg 专业处理 · 免费
                    {!canServerCompress && <span className="text-amber-300/70"> · 限 ≤95MB</span>}
                  </div>
                  {!canServerCompress && (
                    <p className="mt-1 text-xs text-amber-300/70">
                      文件超过 95MB，服务端暂不支持
                    </p>
                  )}
                </div>
              </div>
            </button>

            <button
              onClick={() => onSelect('browser')}
              className="w-full p-3 rounded-xl border border-blue-400/30 bg-blue-500/10 hover:bg-blue-500/20 hover:border-blue-400/50 text-left transition cursor-pointer"
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-500/20 text-blue-300 flex items-center justify-center shrink-0">
                  <Monitor className="w-4.5 h-4.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">浏览器压缩</span>
                  </div>
                  <div className="mt-0.5 text-xs text-white/60">
                    无文件大小限制 · 本地处理 · 免费
                  </div>
                </div>
              </div>
            </button>

            <button
              onClick={() => onSelect('aliyun')}
              disabled={!canAliyunCompress}
              className={`w-full p-3 rounded-xl border text-left transition ${
                canAliyunCompress
                  ? 'border-orange-400/30 bg-orange-500/10 hover:bg-orange-500/20 hover:border-orange-400/50 cursor-pointer'
                  : 'border-white/10 bg-white/[0.02] opacity-50 cursor-not-allowed'
              }`}
            >
              <div className="flex items-start gap-3">
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
