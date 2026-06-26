import { useState, useRef, useCallback, useEffect } from 'react';
import { X, Upload, FileText, Loader2, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useEscapeKey';

interface AIScriptDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
  sceneId?: number | null;
  onSuccess?: (shots: any[]) => void;
}

type DialogState = 'initial' | 'analyzing' | 'completed';

interface ShotPreview {
  shotIndex: number;
  shotType: string;
  title: string;
}

// 简单费用估算（基于分镜数量和是否生成图片）
function estimateCost(shotCount: number, generateImages: boolean): number {
  // 文本分析费用：约 0.1 元 per shot
  const analysisCost = shotCount * 0.1;
  // 图片生成费用：约 0.05 元 per shot
  const imageCost = generateImages ? shotCount * 0.05 : 0;
  return analysisCost + imageCost;
}

export default function AIScriptDialog({
  isOpen,
  onClose,
  projectId,
  sceneId,
  onSuccess
}: AIScriptDialogProps) {
  const [state, setState] = useState<DialogState>('initial');
  const [mode, setMode] = useState<'script' | 'narration'>('script');
  const [textInput, setTextInput] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [generateImages, setGenerateImages] = useState(true);
  const [progress, setProgress] = useState(0);
  const [shotCount, setShotCount] = useState(0);
  const [shots, setShots] = useState<ShotPreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 清理轮询
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // Escape 键关闭对话框
  useEscapeKey(onClose, isOpen);

  // 重置状态
  const resetState = useCallback(() => {
    setState('initial');
    setMode('script');
    setTextInput('');
    setFile(null);
    setGenerateImages(true);
    setProgress(0);
    setShotCount(0);
    setShots([]);
    setError(null);
    setTaskId(null);
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // 关闭弹窗时重置
  useEffect(() => {
    if (!isOpen) {
      resetState();
    }
  }, [isOpen, resetState]);

  // 轮询任务状态
  const pollTaskStatus = useCallback((tid: string) => {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/video2/ai/task/${tid}`);
        const data = await res.json();
        
        if (data.status === 'processing' || data.status === 'pending') {
          setProgress(data.progress || 0);
          if (data.output?.shots) {
            setShotCount(data.output.shots.length);
          }
        } else if (data.status === 'done') {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setProgress(100);
          const outputShots = data.output?.shots || [];
          setShotCount(outputShots.length);
          setShots(outputShots.map((s: any, idx: number) => ({
            shotIndex: idx + 1,
            shotType: s.shotType || '未知',
            title: s.title || s.sceneContent?.substring(0, 20) || `镜头 ${idx + 1}`
          })));
          setState('completed');
        } else if (data.status === 'error') {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setError(data.error || '分析失败，请重试');
          setState('initial');
        }
      } catch (e) {
        console.error('轮询任务状态失败:', e);
      }
    }, 2000);
  }, []);

  // 开始分析
  const handleStartAnalysis = async () => {
    if (!textInput.trim() && !file) {
      setError('请上传脚本文件或输入文本内容');
      return;
    }

    setError(null);
    setState('analyzing');
    setProgress(5);

    try {
      const formData = new FormData();
      formData.append('projectId', String(projectId));
      if (sceneId !== null && sceneId !== undefined) {
        formData.append('sceneId', String(sceneId));
      }
      formData.append('mode', mode);
      formData.append('generateImages', String(generateImages));

      if (file) {
        formData.append('file', file);
      } else {
        formData.append('text', textInput);
      }

      const res = await fetch('/api/video2/ai/parse-script', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();

      if (data.taskId) {
        setTaskId(data.taskId);
        pollTaskStatus(data.taskId);
      } else if (data.error) {
        setError(data.error);
        setState('initial');
      }
    } catch (e) {
      console.error('提交分析任务失败:', e);
      setError('网络错误，请重试');
      setState('initial');
    }
  };

  // 取消处理
  const handleCancel = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    // 如果后端支持取消，可以在这里调用取消API
    resetState();
  };

  // 查看并确认
  const handleConfirm = () => {
    if (onSuccess && shots.length > 0) {
      onSuccess(shots);
    }
    onClose();
  };

  if (!isOpen) return null;

  const estimatedFee = estimateCost(shotCount > 0 ? shotCount : 8, generateImages);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900/95 backdrop-blur-xl rounded-3xl border border-white/10 w-full max-w-lg p-6 shadow-2xl">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-white">AI 自动生成分镜</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 初始状态 */}
        {state === 'initial' && (
          <div className="space-y-5">
            {/* 输入模式选择 */}
            <div>
              <label className="block text-sm text-slate-300 mb-2">选择输入方式：</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="mode"
                    value="script"
                    checked={mode === 'script'}
                    onChange={() => setMode('script')}
                    className="w-4 h-4 accent-violet-500"
                  />
                  <span className="text-sm text-slate-200">拍摄/分镜脚本</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="mode"
                    value="narration"
                    checked={mode === 'narration'}
                    onChange={() => setMode('narration')}
                    className="w-4 h-4 accent-violet-500"
                  />
                  <span className="text-sm text-slate-200">视频文案/旁白</span>
                </label>
              </div>
            </div>

            {/* 文件上传 */}
            <div>
              <label className="block text-sm text-slate-300 mb-2">
                上传脚本文件 (.txt/.docx)
              </label>
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-white/15 hover:border-violet-400/40 rounded-2xl p-6 text-center cursor-pointer transition bg-white/[0.02]"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.docx"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.[0]) {
                      setFile(e.target.files[0]);
                      setTextInput('');
                    }
                  }}
                />
                {file ? (
                  <div className="flex items-center justify-center gap-2 text-violet-300">
                    <FileText className="w-5 h-5" />
                    <span className="text-sm font-medium">{file.name}</span>
                  </div>
                ) : (
                  <>
                    <Upload className="w-8 h-8 mx-auto mb-2 text-slate-500" />
                    <p className="text-sm text-slate-400">点击选择文件</p>
                  </>
                )}
              </div>
            </div>

            {/* 分隔符 */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-white/10" />
              <span className="text-xs text-slate-500">或</span>
              <div className="flex-1 h-px bg-white/10" />
            </div>

            {/* 文本输入 */}
            <div>
              <label className="block text-sm text-slate-300 mb-2">文本输入（粘贴脚本内容）</label>
              <textarea
                value={textInput}
                onChange={(e) => {
                  setTextInput(e.target.value);
                  if (e.target.value.trim()) setFile(null);
                }}
                placeholder="在此粘贴脚本内容..."
                rows={5}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm text-slate-200 placeholder-slate-500 resize-none transition"
              />
            </div>

            {/* AI 参考图选项 */}
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={generateImages}
                onChange={(e) => setGenerateImages(e.target.checked)}
                className="w-4 h-4 mt-0.5 accent-violet-500"
              />
              <div>
                <span className="text-sm text-slate-200">自动生成 AI 参考图</span>
                <p className="text-xs text-slate-500 mt-0.5">不勾选则仅生成分镜数据</p>
              </div>
            </label>

            {/* 模型选择 */}
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <span>使用模型：</span>
              <span className="font-medium text-white">DeepSeek V3</span>
              <div className="relative group">
                <Info className="w-4 h-4 text-slate-500 cursor-help" />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-lg bg-slate-800 text-xs text-slate-300 whitespace-nowrap opacity-0 group-hover:opacity-100 transition pointer-events-none border border-white/10">
                  费用低 · 速度快
                </div>
              </div>
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            {/* 按钮 */}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
              >
                取消
              </button>
              <button
                onClick={handleStartAnalysis}
                disabled={!textInput.trim() && !file}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                开始分析
              </button>
            </div>
          </div>
        )}

        {/* 分析中状态 */}
        {state === 'analyzing' && (
          <div className="py-8 text-center">
            <div className="flex items-center justify-center gap-3 mb-6">
              <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
              <span className="text-base text-slate-200">正在分析脚本...</span>
              <span className="text-base text-violet-400 font-medium">{progress}%</span>
            </div>

            {/* 进度条 */}
            <div className="h-2 rounded-full bg-white/10 overflow-hidden mb-4">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>

            {shotCount > 0 && (
              <p className="text-sm text-slate-400 mb-6">已识别 {shotCount} 个分镜</p>
            )}

            <p className="text-xs text-slate-500 mb-8">请勿关闭页面</p>

            <button
              onClick={handleCancel}
              className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
            >
              取消处理
            </button>
          </div>
        )}

        {/* 完成状态 */}
        {state === 'completed' && (
          <div className="py-4">
            {/* 成功提示 */}
            <div className="flex items-center gap-3 mb-5">
              <CheckCircle2 className="w-6 h-6 text-green-400" />
              <div>
                <h3 className="text-base font-semibold text-white">分析完成！</h3>
                <p className="text-sm text-slate-400">
                  已生成 {shotCount} 个分镜
                </p>
              </div>
            </div>

            {/* 费用信息 */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-white/[0.03] border border-white/10 mb-5">
              <span className="text-sm text-slate-300">预估费用：</span>
              <span className="text-base font-semibold text-green-400">¥{estimatedFee.toFixed(2)}</span>
            </div>

            {/* 分镜预览列表 */}
            {shots.length > 0 && (
              <div className="mb-6">
                <p className="text-xs text-slate-500 mb-3">分镜预览</p>
                <div className="flex flex-wrap gap-2">
                  {shots.slice(0, 12).map((shot) => (
                    <div
                      key={shot.shotIndex}
                      className="flex flex-col items-center p-3 rounded-xl bg-white/[0.03] border border-white/10 min-w-[60px]"
                    >
                      <span className="text-xs text-slate-400 mb-1">#{shot.shotIndex}</span>
                      <span className="text-sm font-medium text-white">{shot.shotType}</span>
                    </div>
                  ))}
                  {shots.length > 12 && (
                    <div className="flex items-center justify-center p-3 rounded-xl bg-white/[0.03] border border-white/10 min-w-[60px]">
                      <span className="text-sm text-slate-400">+{shots.length - 12}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 错误提示 */}
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm mb-5">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            {/* 按钮 */}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
              >
                取消
              </button>
              <button
                onClick={handleConfirm}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white text-sm font-medium transition"
              >
                查看并确认
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
