import { useState, useRef, useCallback, useEffect } from 'react';
import { X, Upload, FileText, Loader2, CheckCircle2, AlertCircle, Info, Scissors, ImageOff, ChevronDown } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import type { ModelConfig, Settings } from '../../lib/types';
import { AiErrorGuide } from './AiErrorGuide';

interface AIScriptDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
  sceneId?: number | null;
  onSuccess?: (result: { shots: any[]; digitalAssets: { mainActors: any[]; keyProps: any[]; mainScenes: any[] } }) => void;
  onOpenSettings?: () => void;
}

type DialogState = 'initial' | 'analyzing' | 'shotcut_selection' | 'stock_selection' | 'completed';

interface ShotData {
  shotIndex: number;
  shotType: string;
  title: string;
  sceneContent: string;
  hasShotCut: boolean;
  isStockOrEffect: boolean;
  // 其他字段
  actors?: string;
  props?: string;
  costume?: string;
  location?: string;
  focalLength?: string;
  narration?: string;
  cameraMovement?: string;
  shotAngle?: string;
  lighting?: string;
  notes?: string;
  estimatedDuration?: string;
  aiImagePrompt?: string;
  sceneName?: string;
  sceneId?: number | null;
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
  onSuccess,
  onOpenSettings,
}: AIScriptDialogProps) {
  const [state, setState] = useState<DialogState>('initial');
  const [mode, setMode] = useState<'script' | 'narration'>('script');
  const [textInput, setTextInput] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [generateImages, setGenerateImages] = useState(true);
  const [progress, setProgress] = useState(0);
  const [shotCount, setShotCount] = useState(0);
  const [shots, setShots] = useState<ShotData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [digitalAssets, setDigitalAssets] = useState<{ mainActors: any[]; keyProps: any[]; mainScenes: any[] }>({
    mainActors: [],
    keyProps: [],
    mainScenes: []
  });

  // 平台和模型选择
  const [provider, setProvider] = useState<string>('geekai');
  const [modelId, setModelId] = useState('deepseek-chat');
  const [llmModels, setLlmModels] = useState<ModelConfig[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

  // 分割选择状态
  const [shotCutDecisions, setShotCutDecisions] = useState<Record<number, 'split' | 'keep'>>({});

  // 素材镜头选择状态
  const [stockDecisions, setStockDecisions] = useState<Record<number, 'generate' | 'skip'>>({});

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
    setProvider('geekai');
    setModelId('deepseek-chat');
    setShotCutDecisions({});
    setStockDecisions({});
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

  // 加载设置中的模型列表
  useEffect(() => {
    if (isOpen && !settingsLoaded) {
      fetch('/api/video2/settings')
        .then(res => res.json())
        .then(data => {
          if (data.success && data.data) {
            setSettings(data.data);
            const models = data.data.llm_fallback_chain || [];
            setLlmModels(models);
            if (models.length > 0) {
              const firstModel = models[0];
              setProvider(firstModel.provider);
              setModelId(firstModel.model);
            }
            setSettingsLoaded(true);
          }
        })
        .catch(console.error);
    }
  }, [isOpen, settingsLoaded]);

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
          // 保存完整的分镜数据（包括 hasShotCut 和 isStockOrEffect）
          const fullShots: ShotData[] = outputShots.map((s: any, idx: number) => ({
            shotIndex: idx + 1,
            shotType: s.shotType || '未知',
            title: s.title || s.sceneContent?.substring(0, 20) || `镜头 ${idx + 1}`,
            sceneContent: s.sceneContent || '',
            hasShotCut: s.hasShotCut || false,
            isStockOrEffect: s.isStockOrEffect || false,
            actors: s.actors || '',
            props: s.props || '',
            costume: s.costume || '',
            location: s.location || '',
            focalLength: s.focalLength || '',
            narration: s.narration || '',
            cameraMovement: s.cameraMovement || '',
            shotAngle: s.shotAngle || '',
            lighting: s.lighting || '',
            notes: s.notes || '',
            estimatedDuration: s.estimatedDuration || '',
            aiImagePrompt: s.aiImagePrompt || '',
            sceneName: s.sceneName || '',
            sceneId: s.sceneId || null
          }));
          setShots(fullShots);

          // 保存数字资产信息
          if (data.output?.digitalAssets) {
            setDigitalAssets(data.output.digitalAssets);
          }

          // 检查是否需要进入分割选择状态
          const hasShotCutShots = fullShots.filter(s => s.hasShotCut);
          if (hasShotCutShots.length > 0) {
            // 初始化所有镜头切换分镜为"保持原样"
            const initialDecisions: Record<number, 'split' | 'keep'> = {};
            hasShotCutShots.forEach(s => {
              initialDecisions[s.shotIndex] = 'keep';
            });
            setShotCutDecisions(initialDecisions);
            setState('shotcut_selection');
          } else {
            // 检查是否需要进入素材镜头选择状态
            const stockShots = fullShots.filter(s => s.isStockOrEffect);
            if (stockShots.length > 0) {
              // 初始化所有素材镜头为"生成"
              const initialStockDecisions: Record<number, 'generate' | 'skip'> = {};
              stockShots.forEach(s => {
                initialStockDecisions[s.shotIndex] = 'generate';
              });
              setStockDecisions(initialStockDecisions);
              setState('stock_selection');
            } else {
              setState('completed');
            }
          }
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
      formData.append('provider', provider);
      formData.append('model', modelId);

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
    resetState();
  };

  // 分割选择的批量操作
  const setAllShotCutDecisions = (decision: 'split' | 'keep') => {
    const newDecisions: Record<number, 'split' | 'keep'> = {};
    shots.filter(s => s.hasShotCut).forEach(s => {
      newDecisions[s.shotIndex] = decision;
    });
    setShotCutDecisions(newDecisions);
  };

  // 素材镜头选择的批量操作
  const setAllStockDecisions = (decision: 'generate' | 'skip') => {
    const newDecisions: Record<number, 'generate' | 'skip'> = {};
    shots.filter(s => s.isStockOrEffect).forEach(s => {
      newDecisions[s.shotIndex] = decision;
    });
    setStockDecisions(newDecisions);
  };

  // 应用分割决策
  const applyShotCutDecisions = () => {
    let processedShots: ShotData[] = [];

    shots.forEach(shot => {
      if (shot.hasShotCut && shotCutDecisions[shot.shotIndex] === 'split') {
        // 分割镜头 - 创建2个新的分镜
        const originalTitle = shot.title;
        const originalContent = shot.sceneContent;

        // 创建分割后的第一个镜头
        processedShots.push({
          ...shot,
          shotIndex: processedShots.length + 1,
          title: `${originalTitle} (分割#1)`,
          sceneContent: `${originalContent}（原${originalTitle}分割#1）`,
          hasShotCut: false
        });

        // 创建分割后的第二个镜头
        processedShots.push({
          ...shot,
          shotIndex: processedShots.length + 1,
          title: `${originalTitle} (分割#2)`,
          sceneContent: `${originalContent}（原${originalTitle}分割#2）`,
          hasShotCut: false
        });
      } else {
        // 保持原样
        processedShots.push({
          ...shot,
          shotIndex: processedShots.length + 1
        });
      }
    });

    setShots(processedShots);
    setShotCount(processedShots.length);

    // 检查是否需要进入素材镜头选择状态
    const stockShots = processedShots.filter(s => s.isStockOrEffect);
    if (stockShots.length > 0) {
      const initialStockDecisions: Record<number, 'generate' | 'skip'> = {};
      stockShots.forEach(s => {
        initialStockDecisions[s.shotIndex] = 'generate';
      });
      setStockDecisions(initialStockDecisions);
      setState('stock_selection');
    } else {
      setState('completed');
    }
  };

  // 应用素材镜头决策并提交到后端
  const applyStockDecisionsAndSubmit = async () => {
    // 过滤掉用户选择跳过的素材镜头
    const finalShots = shots.filter(shot => {
      if (shot.isStockOrEffect && stockDecisions[shot.shotIndex] === 'skip') {
        return false;
      }
      return true;
    });

    setShots(finalShots);
    setShotCount(finalShots.length);

    // 提交到后端创建分镜
    try {
      const res = await fetch('/api/video2/ai/create-shots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          projectId,
          sceneId,
          shots: finalShots,
          sceneMap: {} // 场次已在解析时创建
        })
      });

      const data = await res.json();

      if (data.success) {
        setState('completed');
        if (onSuccess) {
          onSuccess({ shots: data.shots || finalShots, digitalAssets });
        }
      } else {
        setError(data.message || '创建分镜失败');
        setState('completed');
      }
    } catch (e) {
      console.error('提交分镜失败:', e);
      setError('网络错误，分镜数据已准备好但未能保存');
      setState('completed');
    }
  };

  // 直接确认（无需分割或素材选择）
  const handleConfirm = async () => {
    if (shots.length === 0) {
      onClose();
      return;
    }

    // 提交到后端创建分镜
    try {
      const res = await fetch('/api/video2/ai/create-shots', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          projectId,
          sceneId,
          shots,
          sceneMap: {}
        })
      });

      const data = await res.json();

      if (data.success) {
        if (onSuccess) {
          onSuccess({ shots: data.shots || shots, digitalAssets });
        }
        onClose();
      } else {
        setError(data.message || '创建分镜失败');
      }
    } catch (e) {
      console.error('提交分镜失败:', e);
      setError('网络错误，请重试');
    }
  };

  if (!isOpen) return null;

  const estimatedFee = estimateCost(shotCount > 0 ? shotCount : 8, generateImages);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-2 sm:p-4">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg bg-slate-900 rounded-2xl sm:rounded-3xl border border-white/10 p-4 sm:p-6 shadow-2xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-4 sm:mb-6 shrink-0">
          <h2 className="text-lg font-semibold text-white">AI 自动生成分镜</h2>
          <button
            onClick={onClose}
            className="w-10 h-10 sm:w-8 sm:h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容区域 - 可滚动 */}
        <div className="flex-1 overflow-y-auto min-h-0">
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

              {/* 平台和模型选择 */}
              <div className="space-y-3">
                <label className="block text-sm text-slate-300">AI 模型选择：</label>
                <div className="flex gap-3">
                  {/* 平台选择 */}
                  <div className="relative">
                    <select
                      value={provider}
                      onChange={(e) => {
                        const newProvider = e.target.value;
                        setProvider(newProvider);
                        const firstModel = llmModels.find(m => m.provider === newProvider);
                        if (firstModel) setModelId(firstModel.model);
                      }}
                      className="px-3 py-2 pr-8 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm text-slate-200 cursor-pointer appearance-none"
                    >
                      {(settings?.ai_platforms || [{ id: 'geekai', name: 'GeekAI' }, { id: 'siliconflow', name: 'SiliconFlow' }]).map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>

                  {/* 模型选择 */}
                  <div className="relative flex-1">
                    <select
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      className="w-full px-3 py-2 pr-8 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm text-slate-200 cursor-pointer appearance-none"
                    >
                      {llmModels.filter(m => m.provider === provider).map((m) => (
                        <option key={m.model} value={m.model}>{m.model}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  {llmModels.find(m => m.model === modelId)?.cost ? `费用：${llmModels.find(m => m.model === modelId)?.cost}` : ''}
                </p>
              </div>

              {/* 错误提示 */}
              {error && (
                <AiErrorGuide error={error} onOpenSettings={onOpenSettings} />
              )}
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
            </div>
          )}

          {/* 镜头切换分割选择状态 */}
          {state === 'shotcut_selection' && (
            <div className="space-y-4">
              {/* 提示 */}
              <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <Scissors className="w-5 h-5 text-amber-400 shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-amber-300">检测到含镜头切换的分镜</h3>
                  <p className="text-xs text-amber-200/80 mt-1">
                    AI 检测到以下分镜可能包含镜头切换。请选择是否将其分割为独立的分镜。
                  </p>
                </div>
              </div>

              {/* 批量操作按钮 */}
              <div className="flex gap-2">
                <button
                  onClick={() => setAllShotCutDecisions('split')}
                  className="px-3 py-1.5 rounded-lg bg-violet-500/20 hover:bg-violet-500/30 text-violet-300 text-xs font-medium transition"
                >
                  全部分割
                </button>
                <button
                  onClick={() => setAllShotCutDecisions('keep')}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-slate-300 text-xs font-medium transition"
                >
                  全部保持
                </button>
              </div>

              {/* 分镜列表 - 支持滚动 */}
              <div className="max-h-[40vh] overflow-y-auto pr-2 space-y-2">
                {shots.filter(s => s.hasShotCut).map((shot) => (
                  <div
                    key={shot.shotIndex}
                    className="p-3 rounded-xl bg-white/[0.03] border border-white/10"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs text-slate-500"># {shot.shotIndex}</span>
                          <span className="text-sm font-medium text-white">{shot.shotType}</span>
                        </div>
                        <p className="text-xs text-slate-400 line-clamp-2">{shot.title}</p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => setShotCutDecisions(prev => ({ ...prev, [shot.shotIndex]: 'split' }))}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                            shotCutDecisions[shot.shotIndex] === 'split'
                              ? 'bg-violet-500 text-white'
                              : 'bg-white/10 hover:bg-white/15 text-slate-300'
                          }`}
                        >
                          分割
                        </button>
                        <button
                          onClick={() => setShotCutDecisions(prev => ({ ...prev, [shot.shotIndex]: 'keep' }))}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                            shotCutDecisions[shot.shotIndex] === 'keep'
                              ? 'bg-slate-600 text-white'
                              : 'bg-white/10 hover:bg-white/15 text-slate-300'
                          }`}
                        >
                          保持原样
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* 错误提示 */}
              {error && (
                <AiErrorGuide error={error} onOpenSettings={onOpenSettings} />
              )}
            </div>
          )}

          {/* 素材镜头选择状态 */}
          {state === 'stock_selection' && (
            <div className="space-y-4">
              {/* 提示 */}
              <div className="flex items-center gap-3 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20">
                <ImageOff className="w-5 h-5 text-blue-400 shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-blue-300">检测到素材/特效镜头</h3>
                  <p className="text-xs text-blue-200/80 mt-1">
                    以下分镜被标记为素材镜头或特效镜头（不需要实际拍摄）。您可以选择生成分镜卡片或跳过。
                  </p>
                </div>
              </div>

              {/* 批量操作按钮 */}
              <div className="flex gap-2">
                <button
                  onClick={() => setAllStockDecisions('generate')}
                  className="px-3 py-1.5 rounded-lg bg-violet-500/20 hover:bg-violet-500/30 text-violet-300 text-xs font-medium transition"
                >
                  全部生成
                </button>
                <button
                  onClick={() => setAllStockDecisions('skip')}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-slate-300 text-xs font-medium transition"
                >
                  全部跳过
                </button>
              </div>

              {/* 分镜列表 - 支持滚动 */}
              <div className="max-h-[40vh] overflow-y-auto pr-2 space-y-2">
                {shots.filter(s => s.isStockOrEffect).map((shot) => (
                  <div
                    key={shot.shotIndex}
                    className="p-3 rounded-xl bg-white/[0.03] border border-white/10"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs text-slate-500"># {shot.shotIndex}</span>
                          <span className="text-sm font-medium text-white">{shot.shotType}</span>
                          {shot.hasShotCut && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">含镜头切换</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400 line-clamp-2">{shot.title}</p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => setStockDecisions(prev => ({ ...prev, [shot.shotIndex]: 'generate' }))}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                            stockDecisions[shot.shotIndex] === 'generate'
                              ? 'bg-violet-500 text-white'
                              : 'bg-white/10 hover:bg-white/15 text-slate-300'
                          }`}
                        >
                          生成
                        </button>
                        <button
                          onClick={() => setStockDecisions(prev => ({ ...prev, [shot.shotIndex]: 'skip' }))}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                            stockDecisions[shot.shotIndex] === 'skip'
                              ? 'bg-slate-600 text-white'
                              : 'bg-white/10 hover:bg-white/15 text-slate-300'
                          }`}
                        >
                          跳过
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* 错误提示 */}
              {error && (
                <AiErrorGuide error={error} onOpenSettings={onOpenSettings} />
              )}
            </div>
          )}

          {/* 完成状态 */}
          {state === 'completed' && (
            <div className="space-y-4">
              {/* 成功提示 */}
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-6 h-6 text-green-400" />
                <div>
                  <h3 className="text-base font-semibold text-white">分镜已准备好！</h3>
                  <p className="text-sm text-slate-400">
                    共 {shotCount} 个分镜待创建
                  </p>
                </div>
              </div>

              {/* 费用信息 */}
              <div className="flex items-center justify-between p-4 rounded-xl bg-white/[0.03] border border-white/10">
                <span className="text-sm text-slate-300">预估费用：</span>
                <span className="text-base font-semibold text-green-400">¥{estimatedFee.toFixed(2)}</span>
              </div>

              {/* 分镜预览列表 */}
              {shots.length > 0 && (
                <div>
                  <p className="text-xs text-slate-500 mb-3">分镜预览</p>
                  <div className="flex flex-wrap gap-2">
                    {shots.slice(0, 12).map((shot) => (
                      <div
                        key={shot.shotIndex}
                        className="flex flex-col items-center p-3 rounded-xl bg-white/[0.03] border border-white/10 min-w-[60px]"
                      >
                        <span className="text-xs text-slate-400 mb-1">#{shot.shotIndex}</span>
                        <span className="text-sm font-medium text-white">{shot.shotType}</span>
                        {shot.isStockOrEffect && (
                          <span className="text-xs text-blue-300 mt-1">素材</span>
                        )}
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
                <AiErrorGuide error={error} onOpenSettings={onOpenSettings} />
              )}
            </div>
          )}
        </div>

        {/* 底部按钮 - 固定 */}
        <div className="shrink-0 pt-4 border-t border-white/10 mt-4">
          <div className="flex justify-end gap-3">
            {state === 'initial' && (
              <>
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
              </>
            )}

            {state === 'analyzing' && (
              <button
                onClick={handleCancel}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
              >
                取消处理
              </button>
            )}

            {state === 'shotcut_selection' && (
              <>
                <button
                  onClick={() => {
                    // 跳过分割，直接进入下一步
                    const stockShots = shots.filter(s => s.isStockOrEffect);
                    if (stockShots.length > 0) {
                      const initialStockDecisions: Record<number, 'generate' | 'skip'> = {};
                      stockShots.forEach(s => {
                        initialStockDecisions[s.shotIndex] = 'generate';
                      });
                      setStockDecisions(initialStockDecisions);
                      setState('stock_selection');
                    } else {
                      setState('completed');
                    }
                  }}
                  className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
                >
                  跳过
                </button>
                <button
                  onClick={applyShotCutDecisions}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white text-sm font-medium transition"
                >
                  确认并继续
                </button>
              </>
            )}

            {state === 'stock_selection' && (
              <>
                <button
                  onClick={() => setState('completed')}
                  className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
                >
                  跳过
                </button>
                <button
                  onClick={applyStockDecisionsAndSubmit}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white text-sm font-medium transition"
                >
                  确认并创建
                </button>
              </>
            )}

            {state === 'completed' && (
              <>
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
                  创建分镜
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}