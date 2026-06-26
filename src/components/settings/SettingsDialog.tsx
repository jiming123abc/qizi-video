import { useState, useEffect, useCallback, DragEvent } from 'react';
import { X, Eye, EyeOff, Plus, GripVertical, Trash2, ChevronDown, Loader2 } from 'lucide-react';
import type { ModelConfig, Settings } from '../../lib/types';
import { useEscapeKey } from '../../hooks/useEscapeKey';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

// 可用的模型列表
const LLM_MODELS = [
  { model: 'DeepSeek V3', provider: 'geekai' as const, cost: 'low' as const },
  { model: 'DeepSeek V3', provider: 'siliconflow' as const, cost: 'low' as const },
  { model: 'GPT-4o-mini', provider: 'geekai' as const, cost: 'low' as const },
  { model: 'GLM-4-Flash', provider: 'geekai' as const, cost: 'free' as const },
];

const IMAGE_MODELS = [
  { model: 'GPT-Image-2', quality: 'medium', provider: 'geekai' as const, cost: 'mid_high' as const },
  { model: 'GPT-Image-2', quality: 'medium', provider: 'siliconflow' as const, cost: 'mid_high' as const },
  { model: 'Z-Image-Turbo', quality: 'standard' as const, provider: 'geekai' as const, cost: 'low' as const },
  { model: 'Z-Image-Turbo', quality: 'standard' as const, provider: 'siliconflow' as const, cost: 'low' as const },
  { model: 'Nano Banana 2', quality: 'standard' as const, provider: 'geekai' as const, cost: 'mid' as const },
  { model: 'Nano Banana 2', quality: 'standard' as const, provider: 'siliconflow' as const, cost: 'mid' as const },
  { model: 'CogView-4', quality: 'standard' as const, provider: 'geekai' as const, cost: 'mid' as const },
  { model: 'CogView-4', quality: 'standard' as const, provider: 'siliconflow' as const, cost: 'mid' as const },
];

const IMAGE_SIZES = [
  '1024×576 (16:9)',
  '576×1024 (9:16)',
  '1024×1024 (1:1)',
  '768×768 (1:1)',
];

const COST_LABELS: Record<ModelConfig['cost'], string> = {
  free: '免费',
  low: '低',
  mid: '中',
  mid_high: '中高',
  high: '高',
};

function maskApiKey(key: string): string {
  if (key.length <= 12) return '••••••••';
  return key.slice(0, 8) + '••••••••••••••••••' + key.slice(-6);
}

export default function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // API Key 显示/隐藏状态
  const [showGeekaiKey, setShowGeekaiKey] = useState(false);
  const [showSiliconflowKey, setShowSiliconflowKey] = useState(false);

  // 拖拽状态
  const [draggedLLMIndex, setDraggedLLMIndex] = useState<number | null>(null);
  const [draggedImageIndex, setDraggedImageIndex] = useState<number | null>(null);

  // Escape 键关闭对话框
  useEscapeKey(onClose, isOpen);

  // 设置表单状态
  const [settings, setSettings] = useState<Settings>({
    llm_provider: 'geekai',
    llm_model: 'DeepSeek V3',
    llm_fallback_chain: [],
    image_provider: 'geekai',
    image_model: 'GPT-Image-2',
    image_quality: 'medium',
    image_fallback_chain: [],
    geekai_api_key: '',
    siliconflow_api_key: '',
    default_image_size: '1024×576 (16:9)',
    export_include_images: true,
    export_format: 'docx',
    video_target_bitrate_1080p: 3000,
    video_target_bitrate_720p: 2000,
    video_target_bitrate_480p: 1000,
    model_prices: {},
  });

  // 加载设置
  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/video2/settings');
      if (res.ok) {
        const data = await res.json();
        setSettings(prev => ({ ...prev, ...data }));
      }
    } catch (e) {
      console.error('加载设置失败:', e);
      setError('加载设置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadSettings();
    }
  }, [isOpen, loadSettings]);

  // 保存设置
  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // 保存每个设置项
      const keys = [
        'llm_provider', 'llm_model', 'llm_fallback_chain',
        'image_provider', 'image_model', 'image_quality', 'image_fallback_chain',
        'geekai_api_key', 'siliconflow_api_key',
        'default_image_size', 'export_include_images', 'export_format',
        'video_target_bitrate_1080p', 'video_target_bitrate_720p', 'video_target_bitrate_480p',
      ] as const;

      for (const key of keys) {
        await fetch('/api/video2/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value: settings[key] }),
        });
      }

      onClose();
    } catch (e) {
      console.error('保存设置失败:', e);
      setError('保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  // LLM 降级链操作
  const addLLMModel = (model: typeof LLM_MODELS[number]) => {
    const config: ModelConfig = {
      model: model.model,
      provider: model.provider,
      cost: model.cost,
    };
    setSettings(prev => ({
      ...prev,
      llm_fallback_chain: [...prev.llm_fallback_chain, config],
    }));
  };

  const removeLLMModel = (index: number) => {
    setSettings(prev => ({
      ...prev,
      llm_fallback_chain: prev.llm_fallback_chain.filter((_, i) => i !== index),
    }));
  };

  const handleLLMDragStart = (index: number) => {
    setDraggedLLMIndex(index);
  };

  const handleLLMDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    if (draggedLLMIndex === null || draggedLLMIndex === index) return;

    setSettings(prev => {
      const newChain = [...prev.llm_fallback_chain];
      const [removed] = newChain.splice(draggedLLMIndex, 1);
      newChain.splice(index, 0, removed);
      return { ...prev, llm_fallback_chain: newChain };
    });
    setDraggedLLMIndex(index);
  };

  const handleLLMDragEnd = () => {
    setDraggedLLMIndex(null);
  };

  // Image 降级链操作
  const addImageModel = (model: typeof IMAGE_MODELS[number]) => {
    const config: ModelConfig = {
      model: model.model,
      quality: model.quality,
      provider: model.provider,
      cost: model.cost,
    };
    setSettings(prev => ({
      ...prev,
      image_fallback_chain: [...prev.image_fallback_chain, config],
    }));
  };

  const removeImageModel = (index: number) => {
    setSettings(prev => ({
      ...prev,
      image_fallback_chain: prev.image_fallback_chain.filter((_, i) => i !== index),
    }));
  };

  const handleImageDragStart = (index: number) => {
    setDraggedImageIndex(index);
  };

  const handleImageDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    if (draggedImageIndex === null || draggedImageIndex === index) return;

    setSettings(prev => {
      const newChain = [...prev.image_fallback_chain];
      const [removed] = newChain.splice(draggedImageIndex, 1);
      newChain.splice(index, 0, removed);
      return { ...prev, image_fallback_chain: newChain };
    });
    setDraggedImageIndex(index);
  };

  const handleImageDragEnd = () => {
    setDraggedImageIndex(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900/95 backdrop-blur-xl rounded-3xl border border-white/10 w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <h2 className="text-lg font-semibold text-white">系统设置</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
              <span className="ml-2 text-slate-400">加载中...</span>
            </div>
          ) : (
            <>
              {/* AI 模型配置 */}
              <section>
                <h3 className="text-sm font-medium text-violet-300 mb-4 flex items-center">
                  <span className="w-1 h-4 bg-violet-400 rounded-full mr-2" />
                  AI 模型配置
                </h3>

                {/* 大语言模型平台 */}
                <div className="mb-4">
                  <label className="block text-sm text-slate-300 mb-2">大语言模型平台：</label>
                  <div className="relative">
                    <select
                      value={settings.llm_provider}
                      onChange={(e) => setSettings(prev => ({ ...prev, llm_provider: e.target.value }))}
                      className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200 appearance-none cursor-pointer"
                    >
                      <option value="geekai">GeekAI</option>
                      <option value="siliconflow">硅基流动</option>
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                </div>

                {/* API Key */}
                <div className="mb-4">
                  <label className="block text-sm text-slate-300 mb-2">API Key：</label>
                  <div className="relative">
                    <input
                      type={showGeekaiKey ? 'text' : 'password'}
                      value={settings.geekai_api_key}
                      onChange={(e) => setSettings(prev => ({ ...prev, geekai_api_key: e.target.value }))}
                      placeholder="sk-DbD0R7hJ••••••••••••••••••BGD29F"
                      className="w-full px-4 py-2.5 pr-10 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200 placeholder-slate-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowGeekaiKey(!showGeekaiKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition"
                    >
                      {showGeekaiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="mb-4">
                  <label className="block text-sm text-slate-300 mb-2">API Key（硅基流动）：</label>
                  <div className="relative">
                    <input
                      type={showSiliconflowKey ? 'text' : 'password'}
                      value={settings.siliconflow_api_key}
                      onChange={(e) => setSettings(prev => ({ ...prev, siliconflow_api_key: e.target.value }))}
                      placeholder="sk-••••••••••••••••••••••••"
                      className="w-full px-4 py-2.5 pr-10 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200 placeholder-slate-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSiliconflowKey(!showSiliconflowKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition"
                    >
                      {showSiliconflowKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* 首选文本模型 */}
                <div className="mb-4">
                  <label className="block text-sm text-slate-300 mb-2">首选文本模型：</label>
                  <div className="flex items-center gap-3">
                    <div className="relative flex-1">
                      <select
                        value={settings.llm_model}
                        onChange={(e) => setSettings(prev => ({ ...prev, llm_model: e.target.value }))}
                        className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200 appearance-none cursor-pointer"
                      >
                        {LLM_MODELS.filter(m => m.provider === settings.llm_provider).map(m => (
                          <option key={`${m.model}-${m.provider}`} value={m.model}>{m.model}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                    </div>
                    <span className="text-sm text-slate-400 shrink-0">
                      费用: ¥{COST_LABELS[LLM_MODELS.find(m => m.model === settings.llm_model && m.provider === settings.llm_provider)?.cost || 'low']}
                    </span>
                  </div>
                </div>

                {/* LLM 降级链 */}
                <div className="mb-4">
                  <label className="block text-sm text-slate-300 mb-2">降级链（首选失败时按顺序尝试）：</label>
                  <div className="border border-white/10 rounded-xl p-3 bg-white/[0.02] min-h-[120px]">
                    {settings.llm_fallback_chain.length === 0 ? (
                      <p className="text-sm text-slate-500 text-center py-4">暂无可用降级模型</p>
                    ) : (
                      <div className="space-y-2">
                        {settings.llm_fallback_chain.map((model, index) => (
                          <div
                            key={`${model.model}-${model.provider}-${index}`}
                            draggable
                            onDragStart={() => handleLLMDragStart(index)}
                            onDragOver={(e) => handleLLMDragOver(e, index)}
                            onDragEnd={handleLLMDragEnd}
                            className={`flex items-center gap-2 p-2 rounded-lg bg-white/[0.03] border border-white/5 ${
                              draggedLLMIndex === index ? 'opacity-50' : ''
                            }`}
                          >
                            <GripVertical className="w-4 h-4 text-slate-500 cursor-grab" />
                            <span className="text-sm text-slate-300 w-5">{index + 1}.</span>
                            <span className="text-sm text-white flex-1">{model.model}</span>
                            <span className="text-xs text-slate-400">({model.provider === 'geekai' ? 'GeekAI' : '硅基流动'})</span>
                            <span className="text-xs text-slate-400">¥{COST_LABELS[model.cost]}</span>
                            <button
                              onClick={() => removeLLMModel(index)}
                              className="w-6 h-6 rounded hover:bg-red-500/20 flex items-center justify-center text-slate-400 hover:text-red-400 transition"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 添加按钮 */}
                  <div className="mt-2 relative inline-block">
                    <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-violet-400 hover:bg-violet-400/10 transition">
                      <Plus className="w-4 h-4" />
                      添加降级模型
                    </button>
                  </div>
                </div>
              </section>

              <div className="h-px bg-white/10" />

              {/* 首选生图模型 */}
              <section>
                <h3 className="text-sm font-medium text-violet-300 mb-4 flex items-center">
                  <span className="w-1 h-4 bg-violet-400 rounded-full mr-2" />
                  图像生成配置
                </h3>

                <div className="mb-4">
                  <label className="block text-sm text-slate-300 mb-2">生图平台：</label>
                  <div className="relative">
                    <select
                      value={settings.image_provider}
                      onChange={(e) => setSettings(prev => ({ ...prev, image_provider: e.target.value }))}
                      className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200 appearance-none cursor-pointer"
                    >
                      <option value="geekai">GeekAI</option>
                      <option value="siliconflow">硅基流动</option>
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                </div>

                <div className="mb-4">
                  <label className="block text-sm text-slate-300 mb-2">首选生图模型：</label>
                  <div className="flex items-center gap-3">
                    <div className="relative flex-1">
                      <select
                        value={`${settings.image_model}-${settings.image_quality}`}
                        onChange={(e) => {
                          const [model, quality] = e.target.value.split('-');
                          setSettings(prev => ({ ...prev, image_model: model, image_quality: quality || 'medium' }));
                        }}
                        className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200 appearance-none cursor-pointer"
                      >
                        {IMAGE_MODELS.filter(m => m.provider === settings.image_provider).map(m => (
                          <option key={`${m.model}-${m.quality}`} value={`${m.model}-${m.quality || 'medium'}`}>
                            {m.model}{m.quality ? ` (${m.quality})` : ''}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                    </div>
                    <span className="text-sm text-slate-400 shrink-0">
                      费用: ¥{COST_LABELS[IMAGE_MODELS.find(m => m.model === settings.image_model && m.provider === settings.image_provider)?.cost || 'mid']}
                    </span>
                  </div>
                </div>

                {/* Image 降级链 */}
                <div className="mb-4">
                  <label className="block text-sm text-slate-300 mb-2">降级链（首选失败时按顺序尝试）：</label>
                  <div className="border border-white/10 rounded-xl p-3 bg-white/[0.02] min-h-[100px]">
                    {settings.image_fallback_chain.length === 0 ? (
                      <p className="text-sm text-slate-500 text-center py-4">暂无可用降级模型</p>
                    ) : (
                      <div className="space-y-2">
                        {settings.image_fallback_chain.map((model, index) => (
                          <div
                            key={`${model.model}-${model.provider || 'geekai'}-${model.quality || ''}-${index}`}
                            draggable
                            onDragStart={() => handleImageDragStart(index)}
                            onDragOver={(e) => handleImageDragOver(e, index)}
                            onDragEnd={handleImageDragEnd}
                            className={`flex items-center gap-2 p-2 rounded-lg bg-white/[0.03] border border-white/5 ${
                              draggedImageIndex === index ? 'opacity-50' : ''
                            }`}
                          >
                            <GripVertical className="w-4 h-4 text-slate-500 cursor-grab" />
                            <span className="text-sm text-slate-300 w-5">{index + 1}.</span>
                            <span className="text-sm text-white flex-1">
                              {model.model}{model.quality ? ` (${model.quality})` : ''}
                            </span>
                            <span className="text-xs text-slate-400">({model.provider === 'geekai' ? 'GeekAI' : '硅基流动'})</span>
                            <span className="text-xs text-slate-400">¥{COST_LABELS[model.cost]}</span>
                            <button
                              onClick={() => removeImageModel(index)}
                              className="w-6 h-6 rounded hover:bg-red-500/20 flex items-center justify-center text-slate-400 hover:text-red-400 transition"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* 添加按钮 */}
                  <div className="mt-2 relative inline-block">
                    <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-violet-400 hover:bg-violet-400/10 transition">
                      <Plus className="w-4 h-4" />
                      添加降级模型
                    </button>
                  </div>
                </div>
              </section>

              <div className="h-px bg-white/10" />

              {/* 视频压缩设置 */}
              <section>
                <h3 className="text-sm font-medium text-violet-300 mb-4 flex items-center">
                  <span className="w-1 h-4 bg-violet-400 rounded-full mr-2" />
                  视频压缩设置
                </h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-slate-300 w-28">1080p 目标码率：</label>
                    <input
                      type="number"
                      value={settings.video_target_bitrate_1080p}
                      onChange={(e) => setSettings(prev => ({ ...prev, video_target_bitrate_1080p: Number(e.target.value) }))}
                      className="flex-1 px-4 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200"
                    />
                    <span className="text-sm text-slate-400">kbps</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-slate-300 w-28">720p 目标码率：</label>
                    <input
                      type="number"
                      value={settings.video_target_bitrate_720p}
                      onChange={(e) => setSettings(prev => ({ ...prev, video_target_bitrate_720p: Number(e.target.value) }))}
                      className="flex-1 px-4 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200"
                    />
                    <span className="text-sm text-slate-400">kbps</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-slate-300 w-28">480p 目标码率：</label>
                    <input
                      type="number"
                      value={settings.video_target_bitrate_480p}
                      onChange={(e) => setSettings(prev => ({ ...prev, video_target_bitrate_480p: Number(e.target.value) }))}
                      className="flex-1 px-4 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200"
                    />
                    <span className="text-sm text-slate-400">kbps</span>
                  </div>
                </div>
              </section>

              <div className="h-px bg-white/10" />

              {/* 默认参考图尺寸 */}
              <section>
                <h3 className="text-sm font-medium text-violet-300 mb-4 flex items-center">
                  <span className="w-1 h-4 bg-violet-400 rounded-full mr-2" />
                  默认参考图尺寸
                </h3>
                <div className="relative w-56">
                  <select
                    value={settings.default_image_size}
                    onChange={(e) => setSettings(prev => ({ ...prev, default_image_size: e.target.value }))}
                    className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200 appearance-none cursor-pointer"
                  >
                    {IMAGE_SIZES.map(size => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
              </section>

              {/* 错误提示 */}
              {error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-white/10 shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl border border-white/15 hover:bg-white/5 text-slate-300 text-sm font-medium transition"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="px-5 py-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}
