import { useState, useRef, useCallback, useEffect } from 'react';
import { X, Upload, FileText, Loader2, CheckCircle2, AlertCircle, Info, Scissors, ImageOff, ChevronDown, Download, Lightbulb } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import type { ModelConfig, Settings, DigitalAsset, AiScriptShot } from '../../lib/types';
import { AiErrorGuide } from './AiErrorGuide';

interface AIScriptDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
  sceneId?: number | null;
  // any-audit：用 ShotData[] 和 DigitalAsset[] 替代 any[]（本文件已定义 ShotData，DigitalAsset 来自 types.ts）
  onSuccess?: (result: { shots: ShotData[]; digitalAssets: { mainActors: DigitalAsset[]; keyProps: DigitalAsset[]; mainScenes: DigitalAsset[] } | null }) => void;
  onOpenSettings?: () => void;
}

// P5-1：14 状态状态机（支持 A1/A2/B/C/D 五条路径）
type DialogState =
  | 'initial'
  | 'analyzing_type'         // 路径A/B/D：AI 判断文档类型中
  | 'intent_generating'      // 路径C：AI 根据制片意图生成视频文案中
  | 'intent_preview'         // 路径C：用户确认视频文案
  | 'scene_generating'       // 路径A2：AI 生成场次划分中
  | 'scene_preview'          // 路径A2：用户确认场次划分
  | 'storyboard_generating'  // 路径B/C 阶段1：生成分镜脚本中
  | 'storyboard_preview'     // 路径B/C 阶段1：预览分镜脚本
  | 'shooting_generating'    // 路径B/C 阶段2：生成拍摄脚本中
  | 'shooting_preview'       // 路径B/C 阶段2：预览拍摄脚本
  | 'final_parsing'          // 最终解析分镜数据
  | 'shotcut_selection'      // 镜头切换选择
  | 'stock_selection'        // 素材镜头选择
  | 'completed';

// P5-1：AI 任务输出类型（task.output.type）
type ScriptOutputType = 'video_copy' | 'scene_division' | 'storyboard_script' | 'shooting_script' | 'shots';

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

// 简单费用估算（基于分镜数量）
function estimateCost(shotCount: number): number {
  // 文本分析费用：约 0.1 元 per shot
  return shotCount * 0.1;
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
  // P5-1：移除 mode（改为 AI 自动判断），textInput 改为"制片意图"输入
  const [textInput, setTextInput] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [generateDigitalAssets, setGenerateDigitalAssets] = useState(false);
  const [progress, setProgress] = useState(0);
  const [shotCount, setShotCount] = useState(0);
  const [shots, setShots] = useState<ShotData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  // P5-1：AI 生成的脚本文本（视频文案/场次划分/分镜脚本/拍摄脚本）+ 用户可编辑副本
  const [scriptText, setScriptText] = useState('');
  const [editingScriptText, setEditingScriptText] = useState('');
  // any-audit：用 DigitalAsset[] 替代 any[]
  const [digitalAssets, setDigitalAssets] = useState<{ mainActors: DigitalAsset[]; keyProps: DigitalAsset[]; mainScenes: DigitalAsset[] }>({
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
    setTextInput('');
    setFile(null);
    setGenerateDigitalAssets(false);
    setProgress(0);
    setShotCount(0);
    setShots([]);
    setError(null);
    setTaskId(null);
    setScriptText('');
    setEditingScriptText('');
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
      fetch('/api/settings')
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
        const res = await fetch(`/api/ai/task/${tid}`);
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

          // P5-1：根据 task.output.type 路由到不同状态
          const outputType: ScriptOutputType = data.output?.type || 'shots';

          if (outputType === 'video_copy') {
            // 路径C：视频文案生成完成 → intent_preview
            setScriptText(data.output.content || '');
            setEditingScriptText(data.output.content || '');
            setState('intent_preview');
            return;
          }

          if (outputType === 'scene_division') {
            // 路径A2：场次划分生成完成 → scene_preview
            setScriptText(data.output.content || '');
            setEditingScriptText(data.output.content || '');
            setState('scene_preview');
            return;
          }

          if (outputType === 'storyboard_script') {
            // 路径B/C 阶段1：分镜脚本生成完成 → storyboard_preview
            setScriptText(data.output.content || '');
            setEditingScriptText(data.output.content || '');
            setState('storyboard_preview');
            return;
          }

          if (outputType === 'shooting_script') {
            // 路径B/C 阶段2：拍摄脚本生成完成 → shooting_preview
            setScriptText(data.output.content || '');
            setEditingScriptText(data.output.content || '');
            setState('shooting_preview');
            return;
          }

          // outputType === 'shots'：最终分镜数据
          const outputShots = data.output?.shots || [];
          setShotCount(outputShots.length);
          // 保存完整的分镜数据（包括 hasShotCut 和 isStockOrEffect）
          const fullShots: ShotData[] = outputShots.map((s: AiScriptShot, idx: number) => ({
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

  // P5-1：开始分析 - 根据用户输入选择 stage
  // - 上传文件时：stage='auto'（AI 判断文档类型走 A1/A2/B/D）
  // - 输入制片意图时：stage='intent'（路径C：AI 生成视频文案）
  const handleStartAnalysis = async () => {
    if (!textInput.trim() && !file) {
      setError('请上传文档或输入制片意图');
      return;
    }

    setError(null);
    setProgress(5);

    try {
      const formData = new FormData();
      formData.append('projectId', String(projectId));
      if (sceneId !== null && sceneId !== undefined) {
        formData.append('sceneId', String(sceneId));
      }
      formData.append('provider', provider);
      formData.append('model', modelId);

      if (file) {
        // 上传文档 → stage='auto'
        formData.append('stage', 'auto');
        formData.append('file', file);
        setState('analyzing_type');
      } else {
        // 输入制片意图 → stage='intent'
        formData.append('stage', 'intent');
        formData.append('text', textInput);
        setState('intent_generating');
      }

      const res = await fetch('/api/ai/parse-script', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();

      if (data.taskId) {
        setTaskId(data.taskId);
        pollTaskStatus(data.taskId);
      } else if (data.error || data.message) {
        setError(data.error || data.message);
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
      const res = await fetch('/api/ai/create-shots', {
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
          onSuccess({ shots: data.shots || finalShots, digitalAssets: generateDigitalAssets ? digitalAssets : null });
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
      const res = await fetch('/api/ai/create-shots', {
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
          onSuccess({ shots: data.shots || shots, digitalAssets: generateDigitalAssets ? digitalAssets : null });
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

  // P5-1：脚本预览确认 - 用户在 intent_preview/scene_preview/storyboard_preview/shooting_preview 状态确认
  // 根据当前状态提交对应的 stage 参数和脚本文本
  const handleConfirmScript = async () => {
    const contentToSubmit = editingScriptText.trim();
    if (!contentToSubmit) {
      setError('脚本内容不能为空');
      return;
    }

    setError(null);
    setProgress(5);

    // 根据当前状态决定下一个 stage
    let nextStage: 'intent_confirmed' | 'scene_confirmed' | 'storyboard' | 'shooting' = 'intent_confirmed';
    let nextState: DialogState = 'storyboard_generating';
    let scriptContentToSubmit = contentToSubmit;

    if (state === 'intent_preview') {
      // 路径C：用户确认视频文案后 → 生成分镜脚本（阶段1）
      nextStage = 'intent_confirmed';
      nextState = 'storyboard_generating';
    } else if (state === 'scene_preview') {
      // 路径A2：用户确认场次划分后 → 生成最终分镜
      // scriptContent 为原文档 + 用户确认的场次划分
      nextStage = 'scene_confirmed';
      nextState = 'final_parsing';
      // 拼接原文档（如果有）和场次划分
      scriptContentToSubmit = scriptText + '\n\n【场次划分（用户确认）】\n' + contentToSubmit;
    } else if (state === 'storyboard_preview') {
      // 路径B/C 阶段1：用户确认叙事流后 → 生成拍摄脚本（阶段2）
      nextStage = 'storyboard';
      nextState = 'shooting_generating';
    } else if (state === 'shooting_preview') {
      // 路径B/C 阶段2：用户确认拍摄脚本后 → 生成最终分镜
      nextStage = 'shooting';
      nextState = 'final_parsing';
    }

    try {
      const formData = new FormData();
      formData.append('projectId', String(projectId));
      if (sceneId !== null && sceneId !== undefined) {
        formData.append('sceneId', String(sceneId));
      }
      formData.append('stage', nextStage);
      formData.append('provider', provider);
      formData.append('model', modelId);
      formData.append('text', scriptContentToSubmit);

      const res = await fetch('/api/ai/parse-script', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();

      if (data.taskId) {
        setTaskId(data.taskId);
        setState(nextState);
        pollTaskStatus(data.taskId);
      } else if (data.error || data.message) {
        setError(data.error || data.message);
      }
    } catch (e) {
      console.error('提交确认失败:', e);
      setError('网络错误，请重试');
    }
  };

  // P5-1：下载脚本 - 调用后端 /api/ai/download-script
  const handleDownloadScript = async () => {
    const content = editingScriptText || scriptText;
    if (!content) return;

    try {
      const res = await fetch('/api/ai/download-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          filename: `script-${Date.now()}`,
          format: 'txt'
        })
      });

      if (!res.ok) {
        throw new Error('下载失败');
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `script-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('下载脚本失败:', e);
      setError('下载失败，请重试');
    }
  };

  if (!isOpen) return null;

  // P3-7：费用按实际分镜数计算（shotCount 在分析完成后 > 0，无需硬编码兜底）
  const estimatedFee = estimateCost(shotCount);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-0 sm:p-4">
      <div className="absolute inset-x-0 top-0 bottom-0 sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 w-full sm:max-w-lg sm:w-[calc(100%-2rem)] bg-slate-900 rounded-none sm:rounded-2xl sm:rounded-3xl border border-white/10 p-4 sm:p-6 shadow-2xl max-h-[100dvh] sm:max-h-[85vh] overflow-hidden flex flex-col">
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
          {/* 初始状态 - P5-1：移除 mode，改造为上传文档 / 输入制片意图 */}
          {state === 'initial' && (
            <div className="space-y-5">
              {/* 文件上传 */}
              <div>
                <label className="block text-sm text-slate-300 mb-2">
                  上传文档（建议优先上传分镜脚本、拍摄脚本；也可上传解说词、旁白、视频策划案等）
                </label>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-white/15 hover:border-violet-400/40 rounded-2xl p-6 text-center cursor-pointer transition bg-white/[0.02]"
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,.docx,.pdf"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        setFile(e.target.files[0]);
                        // P5-1：文件/意图互斥 - 上传文件时清空制片意图
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
                      <p className="text-sm text-slate-400">点击选择文件（支持 .txt / .md / .docx / .pdf）</p>
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

              {/* P5-1 路径C：制片意图输入 */}
              <div>
                <label className="block text-sm text-slate-300 mb-2 flex items-center gap-2">
                  <Lightbulb className="w-4 h-4 text-amber-400" />
                  输入制片意图
                </label>
                {/* 输入规范提示 */}
                <div className="mb-2 p-3 rounded-xl bg-amber-500/5 border border-amber-500/15">
                  <p className="text-xs text-amber-300/90 mb-1.5 font-medium">制片意图示例：</p>
                  <ul className="text-xs text-amber-200/70 space-y-1">
                    <li>• 我想制作一个 2 分钟的企业宣传片，展示公司发展历程和核心业务</li>
                    <li>• 我想制作一个 5 分钟的产品介绍视频，介绍新产品的功能和优势</li>
                    <li>• 我想制作一个 1 分钟的短视频，用于社交媒体推广</li>
                  </ul>
                  <p className="text-xs text-slate-500 mt-2">输入内容相对简短（一句话描述视频类型、主题、时长等），AI 将根据意图生成完整视频文案供您确认。</p>
                </div>
                <textarea
                  value={textInput}
                  onChange={(e) => {
                    setTextInput(e.target.value);
                    // P5-1：文件/意图互斥 - 输入意图时清空已选文件
                    if (e.target.value.trim()) setFile(null);
                  }}
                  placeholder="请输入您的制片意图，例如：我想制作一个 3 分钟的产品介绍视频，介绍我们公司新推出的智能手表，突出其健康监测功能和时尚设计"
                  rows={5}
                  className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm text-slate-200 placeholder-slate-500 resize-none transition"
                />
              </div>

              {/* 生成数字资产数据选项 */}
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={generateDigitalAssets}
                  onChange={(e) => setGenerateDigitalAssets(e.target.checked)}
                  className="w-4 h-4 mt-0.5 accent-violet-500"
                />
                <div>
                  <span className="text-sm text-slate-200">生成数字资产数据</span>
                  <p className="text-xs text-slate-500 mt-0.5">勾选后在分镜生成时提取主要演员/道具/场景数据（含生图提示词），不自动生图，需在数字资产管理中手动生成</p>
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
                      className="px-3 py-2 pr-8 rounded-xl bg-slate-800 border border-white/10 focus:border-violet-400/50 outline-none text-sm text-white cursor-pointer appearance-none"
                    >
                      {(settings?.ai_platforms || [{ id: 'geekai', name: 'GeekAI' }, { id: 'siliconflow', name: 'SiliconFlow' }]).map(p => (
                        <option key={p.id} value={p.id} className="bg-slate-800 text-slate-100">{p.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>

                  {/* 模型选择 */}
                  <div className="relative flex-1">
                    <select
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      className="w-full px-3 py-2 pr-8 rounded-xl bg-slate-800 border border-white/10 focus:border-violet-400/50 outline-none text-sm text-white cursor-pointer appearance-none"
                    >
                      {llmModels.filter(m => m.provider === provider).map((m) => (
                        <option key={m.model} value={m.model} className="bg-slate-800 text-slate-100">{m.model}</option>
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

          {/* P5-1：所有 AI 生成中状态共用 loading UI（analyzing_type/intent_generating/scene_generating/storyboard_generating/shooting_generating/final_parsing） */}
          {(state === 'analyzing_type' || state === 'intent_generating' || state === 'scene_generating'
            || state === 'storyboard_generating' || state === 'shooting_generating' || state === 'final_parsing') && (
            <div className="py-8 text-center">
              <div className="flex items-center justify-center gap-3 mb-6">
                <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
                <span className="text-base text-slate-200">
                  {state === 'analyzing_type' && '正在判断文档类型...'}
                  {state === 'intent_generating' && '正在根据制片意图生成视频文案...'}
                  {state === 'scene_generating' && '正在生成场次划分...'}
                  {state === 'storyboard_generating' && '正在生成分镜脚本...'}
                  {state === 'shooting_generating' && '正在生成拍摄脚本...'}
                  {state === 'final_parsing' && '正在解析分镜数据...'}
                </span>
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

          {/* P5-1：脚本预览状态共用 UI（intent_preview/scene_preview/storyboard_preview/shooting_preview） */}
          {(state === 'intent_preview' || state === 'scene_preview' || state === 'storyboard_preview' || state === 'shooting_preview') && (
            <div className="space-y-4">
              {/* 标题提示 */}
              <div className="flex items-center gap-3 p-4 rounded-xl bg-violet-500/10 border border-violet-500/20">
                <FileText className="w-5 h-5 text-violet-400 shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-violet-300">
                    {state === 'intent_preview' && 'AI 已生成视频文案'}
                    {state === 'scene_preview' && 'AI 已生成场次划分'}
                    {state === 'storyboard_preview' && 'AI 已生成分镜脚本（按时间顺序）'}
                    {state === 'shooting_preview' && 'AI 已生成拍摄脚本（按场次组织）'}
                  </h3>
                  <p className="text-xs text-violet-200/80 mt-1">
                    请审阅以下内容，您可以直接编辑修改后确认，也可下载后离线修改再上传。
                  </p>
                </div>
              </div>

              {/* 可编辑文本区 */}
              <textarea
                value={editingScriptText}
                onChange={(e) => setEditingScriptText(e.target.value)}
                rows={12}
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-sm text-slate-200 resize-y font-mono"
                placeholder="脚本内容..."
              />

              {/* 下载按钮 */}
              <button
                onClick={handleDownloadScript}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-sm font-medium transition"
              >
                <Download className="w-4 h-4" />
                下载脚本（.txt）
              </button>

              {/* 错误提示 */}
              {error && (
                <AiErrorGuide error={error} onOpenSettings={onOpenSettings} />
              )}
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
              <div className="p-4 rounded-xl bg-white/[0.03] border border-white/10">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-300">预估费用：</span>
                  <span className="text-base font-semibold text-green-400">¥{estimatedFee.toFixed(2)}</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">费用按实际分镜数计算</p>
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

            {/* P5-1：所有生成中状态共用取消按钮 */}
            {(state === 'analyzing_type' || state === 'intent_generating' || state === 'scene_generating'
              || state === 'storyboard_generating' || state === 'shooting_generating' || state === 'final_parsing') && (
              <button
                onClick={handleCancel}
                className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
              >
                取消处理
              </button>
            )}

            {/* P5-1：脚本预览状态 - 取消重新输入 + 确认并继续 */}
            {(state === 'intent_preview' || state === 'scene_preview' || state === 'storyboard_preview' || state === 'shooting_preview') && (
              <>
                <button
                  onClick={handleCancel}
                  className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
                >
                  取消重新输入
                </button>
                <button
                  onClick={handleConfirmScript}
                  disabled={!editingScriptText.trim()}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  {state === 'intent_preview' && '确认文案并继续'}
                  {state === 'scene_preview' && '确认场次划分'}
                  {state === 'storyboard_preview' && '确认叙事流'}
                  {state === 'shooting_preview' && '确认拍摄脚本'}
                </button>
              </>
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