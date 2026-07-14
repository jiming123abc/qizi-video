import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Eye, EyeOff, ChevronDown, Loader2, Download, Upload, AlertTriangle, LogIn, LogOut, Lock, Plus, Edit, Info } from 'lucide-react';
import type { Settings, AiPlatform } from '../../lib/types';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useToastContext } from '../ToastProvider';
import { clearAdminToken, checkAuth, loginWithToken } from '../../lib/auth';
import { getErrorMessage } from '../../lib/utils';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: number;
}

const IMAGE_SIZES = [
  '1024×576 (16:9)',
  '576×1024 (9:16)',
  '768×768 (1:1)',
  '1536×1024 (3:2)',
];

export default function SettingsDialog({ isOpen, onClose, projectId }: SettingsDialogProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [backingUp, setBackingUp] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<'new' | 'merge'>('new');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [authEnabled, setAuthEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const { showToast } = useToastContext();

  // Escape 键关闭对话框
  useEscapeKey(onClose, isOpen);

  // 设置表单状态
  const [settings, setSettings] = useState<Settings>({
    default_image_size: '1024×576 (16:9)',
    video_target_bitrate_1080p: 3000,
    video_target_bitrate_720p: 2000,
    video_target_bitrate_480p: 1000,
    image_compress_threshold_kb: 300,
  } as Settings);

  // 加载设置
  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, authRes] = await Promise.all([
        fetch('/api/settings'),
        checkAuth()
      ]);
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        if (data.success && data.data) {
          setSettings(prev => ({ ...prev, ...data.data }));
        }
      }
      setAuthEnabled(authRes.enabled);
      setAuthenticated(authRes.authenticated);
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
        'default_image_size',
        'video_target_bitrate_1080p', 'video_target_bitrate_720p', 'video_target_bitrate_480p',
        'image_compress_threshold_kb',
        'llm_fallback_chain', 'image_fallback_chain',
        'ai_platforms',
      ] as const;

      // P3-7：记录每个设置项的保存结果，失败时提示具体哪项
      const failedKeys: string[] = [];
      for (const key of keys) {
        try {
          const res = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value: settings[key] }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            failedKeys.push(`${key}（${data.message || res.statusText}）`);
          }
        } catch (e) {
          failedKeys.push(`${key}（网络错误）`);
        }
      }

      if (failedKeys.length > 0) {
        setError(`以下设置项保存失败：${failedKeys.join('、')}`);
      } else {
        onClose();
      }
    } catch (e) {
      console.error('保存设置失败:', e);
      setError('保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  // 模型列表操作
  const addModel = (type: 'llm' | 'image') => {
    const defaultProvider = settings.ai_platforms?.[0]?.id || 'geekai';
    const key = type === 'llm' ? 'llm_fallback_chain' : 'image_fallback_chain';
    const newModel = type === 'llm'
      ? { model: '', provider: defaultProvider, cost: 'low' as const, supportsVision: false }
      : { model: '', provider: defaultProvider, quality: 'standard', cost: 'mid' as const, supportsImageRef: false };

    setSettings(prev => ({
      ...prev,
      [key]: [...(prev[key] || []), newModel]
    }));
  };

  const updateModel = (type: 'llm' | 'image', index: number, field: string, value: string | number | boolean) => {
    const key = type === 'llm' ? 'llm_fallback_chain' : 'image_fallback_chain';
    setSettings(prev => {
      const list = [...(prev[key] || [])];
      list[index] = { ...list[index], [field]: value };
      return { ...prev, [key]: list };
    });
  };

  const removeModel = (type: 'llm' | 'image', index: number) => {
    const key = type === 'llm' ? 'llm_fallback_chain' : 'image_fallback_chain';
    setSettings(prev => {
      const list = [...(prev[key] || [])];
      list.splice(index, 1);
      return { ...prev, [key]: list };
    });
  };

  // ===== AI 平台管理 =====
  const [editingPlatformId, setEditingPlatformId] = useState<string | null>(null);
  const [showPlatformForm, setShowPlatformForm] = useState(false);
  const [platformForm, setPlatformForm] = useState<AiPlatform>({
    id: '', name: '', baseUrl: '', apiKey: '', docsUrl: '', builtIn: false
  });

  const addPlatform = () => {
    setPlatformForm({
      id: 'custom_' + Date.now(),
      name: '',
      baseUrl: '',
      apiKey: '',
      docsUrl: '',
      builtIn: false
    });
    setEditingPlatformId(null);
    setShowPlatformForm(true);
  };

  const editPlatform = (platform: AiPlatform) => {
    // 编辑时，若 apiKey 已脱敏则清空让用户重新输入；否则保留明文
    setPlatformForm({
      ...platform,
      apiKey: platform.apiKey && platform.apiKey.includes('****') ? '' : platform.apiKey
    });
    setEditingPlatformId(platform.id);
    setShowPlatformForm(true);
  };

  const savePlatform = () => {
    if (!platformForm.name.trim() || !platformForm.baseUrl.trim()) return;

    setSettings(prev => {
      const platforms = [...(prev.ai_platforms || [])];
      const idx = platforms.findIndex(p => p.id === platformForm.id);
      if (idx >= 0) {
        // 编辑：如果用户没输入新 apiKey（为空），保留原脱敏值（后端会还原真实值）
        platforms[idx] = {
          ...platformForm,
          apiKey: platformForm.apiKey || platforms[idx].apiKey
        };
      } else {
        platforms.push(platformForm);
      }
      return { ...prev, ai_platforms: platforms };
    });
    setShowPlatformForm(false);
    setEditingPlatformId(null);
  };

  const removePlatform = (id: string) => {
    setSettings(prev => ({
      ...prev,
      ai_platforms: (prev.ai_platforms || []).filter(p => p.id !== id)
    }));
  };

  const handleBackup = async () => {
    if (!projectId) return;
    setBackingUp(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/backup`);
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cd = res.headers.get('Content-Disposition');
      let fileName = 'project_backup.json';
      if (cd) {
        const match = cd.match(/filename="?([^"]+)"?/);
        if (match) fileName = decodeURIComponent(match[1]);
      }
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error('导出备份失败:', e);
      setError('导出备份失败');
    } finally {
      setBackingUp(false);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setError(null);
    try {
      const text = await file.text();
      const projectData = JSON.parse(text);

      const res = await fetch('/api/projects/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectData,
          targetProjectId: importMode === 'merge' ? projectId : null,
          mode: importMode
        })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || '导入失败');
      }

      const data = await res.json();
      showToast(`导入成功！场次: ${data.sceneCount} 个，分镜: ${data.shotCount} 个`, 'success');
      setTimeout(() => {
        onClose();
        window.location.reload();
      }, 1500);
    } catch (e: unknown) {
      console.error('导入备份失败:', e);
      setError('导入备份失败: ' + getErrorMessage(e, ''));
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleLogin = async () => {
    if (!loginToken.trim()) return;
    setLoginLoading(true);
    setError(null);
    try {
      const ok = await loginWithToken(loginToken.trim());
      if (ok) {
        setAuthenticated(true);
        setLoginToken('');
      } else {
        setError('密码错误，请重试');
      }
    } catch (e) {
      setError('登录失败');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    clearAdminToken();
    setAuthenticated(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] p-8 sm:p-4">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[90vh] flex flex-col bg-slate-900 rounded-3xl border border-white/10 shadow-2xl">
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
              {/* 视频压缩设置 */}
              <section>
                <h3 className="text-sm font-medium text-violet-300 mb-4 flex items-center">
                  <span className="w-1 h-4 bg-violet-400 rounded-full mr-2" />
                  视频压缩设置
                </h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-slate-300 w-28">1080P及以上：</label>
                    <input
                      type="number"
                      value={settings.video_target_bitrate_1080p}
                      onChange={(e) => setSettings(prev => ({ ...prev, video_target_bitrate_1080p: Number(e.target.value) }))}
                      className="flex-1 px-4 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200"
                    />
                    <span className="text-sm text-slate-400">kbps</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-slate-300 w-28">720P及以上：</label>
                    <input
                      type="number"
                      value={settings.video_target_bitrate_720p}
                      onChange={(e) => setSettings(prev => ({ ...prev, video_target_bitrate_720p: Number(e.target.value) }))}
                      className="flex-1 px-4 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200"
                    />
                    <span className="text-sm text-slate-400">kbps</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-slate-300 w-28">480P及以上：</label>
                    <input
                      type="number"
                      value={settings.video_target_bitrate_480p}
                      onChange={(e) => setSettings(prev => ({ ...prev, video_target_bitrate_480p: Number(e.target.value) }))}
                      className="flex-1 px-4 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200"
                    />
                    <span className="text-sm text-slate-400">kbps</span>
                  </div>
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 mt-3">
                    <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-blue-300">
                      分辨率阶梯判断规则：≥1080P 使用 1080P 码率，≥720P 使用 720P 码率，≥480P 使用 480P 码率。码率值同时作为判断阈值和压缩目标。
                    </p>
                  </div>
                </div>
              </section>

              <div className="h-px bg-white/10" />

              {/* 图片压缩设置 */}
              <section>
                <h3 className="text-sm font-medium text-violet-300 mb-4 flex items-center">
                  <span className="w-1 h-4 bg-violet-400 rounded-full mr-2" />
                  图片压缩设置
                </h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-slate-300 w-28">压缩阈值：</label>
                    <input
                      type="number"
                      value={settings.image_compress_threshold_kb}
                      onChange={(e) => setSettings(prev => ({ ...prev, image_compress_threshold_kb: Number(e.target.value) }))}
                      className="flex-1 px-4 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200"
                    />
                    <span className="text-sm text-slate-400">KB</span>
                  </div>
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                    <AlertTriangle className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-blue-300">
                      该值同时作为判断阈值和压缩目标：超过该大小的图片会被压缩，压缩目标大小也为该值。
                    </p>
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
                    className="w-full px-4 py-2.5 rounded-xl bg-slate-800 border border-white/10 focus:border-violet-400/50 outline-none text-white appearance-none cursor-pointer"
                  >
                    {IMAGE_SIZES.map(size => (
                      <option key={size} value={size} className="bg-slate-800 text-slate-100">{size}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
              </section>

              <div className="h-px bg-white/10" />

              {/* AI 平台管理 */}
              <section>
                <h3 className="text-sm font-medium text-violet-300 mb-4 flex items-center">
                  <span className="w-1 h-4 bg-violet-400 rounded-full mr-2" />
                  AI 平台管理
                </h3>
                <div className="space-y-3">
                  {/* 平台列表 */}
                  {(settings.ai_platforms || []).map(platform => (
                    <div key={platform.id} className="p-3 rounded-xl bg-white/5 border border-white/10">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-white">{platform.name}</span>
                            {platform.builtIn && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">内置</span>}
                          </div>
                          <div className="text-xs text-slate-400 mt-1 truncate">{platform.baseUrl}</div>
                          <div className="text-xs text-slate-500 mt-0.5">API Key: {platform.apiKey || '未配置'}</div>
                          {platform.docsUrl && (
                            <a href={platform.docsUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-violet-400 hover:underline mt-0.5 inline-block">
                              技术文档 →
                            </a>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <button onClick={() => editPlatform(platform)} className="p-1.5 rounded-lg text-slate-400 hover:text-violet-400 hover:bg-violet-500/10 transition" title="编辑">
                            <Edit className="w-4 h-4" />
                          </button>
                          <button onClick={() => removePlatform(platform.id)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition" title="删除">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* 新增平台按钮 */}
                  <button onClick={addPlatform} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/30 text-violet-200 text-sm font-medium transition">
                    <Plus className="w-4 h-4" />
                    新增 AI 平台
                  </button>

                  {/* 平台编辑/新增表单 */}
                  {showPlatformForm && (
                    <div className="p-4 rounded-xl bg-slate-800/50 border border-violet-500/30 space-y-3">
                      <div className="text-sm font-medium text-violet-300">
                        {editingPlatformId ? '编辑平台' : '新增平台'}
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">平台名称</label>
                        <input type="text" value={platformForm.name} onChange={e => setPlatformForm({ ...platformForm, name: e.target.value })} placeholder="如：OpenAI、智谱AI" className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-violet-400/50" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Base URL</label>
                        <input type="text" value={platformForm.baseUrl} onChange={e => setPlatformForm({ ...platformForm, baseUrl: e.target.value })} placeholder="如：https://api.openai.com/v1" className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-violet-400/50" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">API Key {editingPlatformId && <span className="text-slate-500">（留空则保留原值）</span>}</label>
                        <input type="text" value={platformForm.apiKey} onChange={e => setPlatformForm({ ...platformForm, apiKey: e.target.value })} placeholder="sk-..." className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm font-mono focus:outline-none focus:border-violet-400/50" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">技术文档链接（可选）</label>
                        <input type="text" value={platformForm.docsUrl || ''} onChange={e => setPlatformForm({ ...platformForm, docsUrl: e.target.value })} placeholder="https://..." className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-violet-400/50" />
                      </div>
                      <div className="flex gap-2">
                        <button onClick={savePlatform} className="flex-1 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm">保存</button>
                        <button onClick={() => setShowPlatformForm(false)} className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm hover:bg-white/10">取消</button>
                      </div>
                    </div>
                  )}

                  {/* 安全提示 */}
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-300">
                      API Key 在保存后将脱敏显示（如 sk-****abcd），编辑时可重新输入。内置平台的 API Key 首次从环境变量自动导入。
                    </p>
                  </div>
                </div>
              </section>

              <div className="h-px bg-white/10" />

              {/* AI 模型配置 */}
              <section>
                <h3 className="text-sm font-medium text-violet-300 mb-4 flex items-center">
                  <span className="w-1 h-4 bg-violet-400 rounded-full mr-2" />
                  AI 模型配置
                </h3>

                <div className="space-y-5">
                  <div className="h-px bg-white/10" />

                  {/* 文本模型 */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-medium text-slate-300">文本模型</h4>
                      <button
                        onClick={() => addModel('llm')}
                        className="px-3 py-1 text-xs rounded-lg bg-violet-600 hover:bg-violet-500 text-white flex items-center gap-1 transition"
                      >
                        <Plus className="w-3 h-3" />
                        新增模型
                      </button>
                    </div>
                    {/* 模型添加指引 */}
                    <div className="flex items-start gap-2 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 mb-3">
                      <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                      <div className="text-xs text-blue-300 space-y-1">
                        <div><b>模型添加指引：</b></div>
                        <div>• <b>模型名</b>：填写平台 API 文档中的完整模型 ID，如 <code className="px-1 bg-blue-500/20 rounded">deepseek-chat</code>、<code className="px-1 bg-blue-500/20 rounded">gpt-4o-mini</code></div>
                        <div>• <b>查询渠道</b>：在对应平台的控制台或模型广场查看可用模型列表</div>
                        <div>• <b>技术文档</b>：参见各平台文档（上方"AI 平台管理"中的链接）</div>
                        <div>• <b>费用</b>：参考平台定价页，选择对应费用等级</div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {(settings.llm_fallback_chain || []).map((model, index) => (
                        <div key={index} className="flex items-center gap-2 p-3 rounded-xl bg-white/5 border border-white/10">
                          <span className="text-xs text-slate-500 w-6">{index + 1}.</span>
                          <input
                            type="text"
                            value={model.model}
                            onChange={(e) => updateModel('llm', index, 'model', e.target.value)}
                            placeholder="模型名"
                            className="flex-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-violet-400/50"
                          />
                          <div className="relative w-28">
                            <select
                              value={model.provider}
                              onChange={(e) => updateModel('llm', index, 'provider', e.target.value)}
                              className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-white text-sm appearance-none cursor-pointer focus:outline-none focus:border-violet-400/50"
                            >
                              {(settings.ai_platforms || []).map(p => (
                                <option key={p.id} value={p.id} className="bg-slate-800 text-slate-100">{p.name}</option>
                              ))}
                            </select>
                            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
                          </div>
                          <div className="relative w-24">
                            <select
                              value={model.cost || 'low'}
                              onChange={(e) => updateModel('llm', index, 'cost', e.target.value)}
                              className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-white text-sm appearance-none cursor-pointer focus:outline-none focus:border-violet-400/50"
                            >
                              <option value="free" className="bg-slate-800 text-slate-100">免费</option>
                              <option value="low" className="bg-slate-800 text-slate-100">低</option>
                              <option value="mid" className="bg-slate-800 text-slate-100">中</option>
                              <option value="mid_high" className="bg-slate-800 text-slate-100">中高</option>
                              <option value="high" className="bg-slate-800 text-slate-100">高</option>
                            </select>
                            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
                          </div>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={model.supportsVision || false}
                              onChange={(e) => updateModel('llm', index, 'supportsVision', e.target.checked)}
                              className="w-4 h-4 rounded border-white/20 bg-slate-800 text-violet-500 focus:ring-violet-500/50"
                            />
                            <span className="text-xs text-slate-400">视觉</span>
                          </label>
                          <button
                            onClick={() => removeModel('llm', index)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition"
                            title="删除"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      {(!settings.llm_fallback_chain || settings.llm_fallback_chain.length === 0) && (
                        <div className="text-center py-4 text-slate-500 text-sm">
                          暂无文本模型，点击上方按钮添加
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="h-px bg-white/10" />

                  {/* 图像模型 */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-medium text-slate-300">图像模型</h4>
                      <button
                        onClick={() => addModel('image')}
                        className="px-3 py-1 text-xs rounded-lg bg-violet-600 hover:bg-violet-500 text-white flex items-center gap-1 transition"
                      >
                        <Plus className="w-3 h-3" />
                        新增模型
                      </button>
                    </div>
                    <div className="space-y-2">
                      {(settings.image_fallback_chain || []).map((model, index) => (
                        <div key={index} className="flex items-center gap-2 p-3 rounded-xl bg-white/5 border border-white/10">
                          <span className="text-xs text-slate-500 w-6">{index + 1}.</span>
                          <input
                            type="text"
                            value={model.model}
                            onChange={(e) => updateModel('image', index, 'model', e.target.value)}
                            placeholder="模型名"
                            className="flex-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-violet-400/50"
                          />
                          <div className="relative w-28">
                            <select
                              value={model.provider}
                              onChange={(e) => updateModel('image', index, 'provider', e.target.value)}
                              className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-white text-sm appearance-none cursor-pointer focus:outline-none focus:border-violet-400/50"
                            >
                              {(settings.ai_platforms || []).map(p => (
                                <option key={p.id} value={p.id} className="bg-slate-800 text-slate-100">{p.name}</option>
                              ))}
                            </select>
                            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
                          </div>
                          <div className="relative w-24">
                            <select
                              value={model.quality || 'standard'}
                              onChange={(e) => updateModel('image', index, 'quality', e.target.value)}
                              className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-white text-sm appearance-none cursor-pointer focus:outline-none focus:border-violet-400/50"
                            >
                              <option value="standard" className="bg-slate-800 text-slate-100">标准</option>
                              <option value="hd" className="bg-slate-800 text-slate-100">高清</option>
                              <option value="ultra" className="bg-slate-800 text-slate-100">超清</option>
                            </select>
                            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
                          </div>
                          <div className="relative w-20">
                            <select
                              value={model.cost || 'mid'}
                              onChange={(e) => updateModel('image', index, 'cost', e.target.value)}
                              className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-white/10 text-white text-sm appearance-none cursor-pointer focus:outline-none focus:border-violet-400/50"
                            >
                              <option value="free" className="bg-slate-800 text-slate-100">免费</option>
                              <option value="low" className="bg-slate-800 text-slate-100">低</option>
                              <option value="mid" className="bg-slate-800 text-slate-100">中</option>
                              <option value="mid_high" className="bg-slate-800 text-slate-100">中高</option>
                              <option value="high" className="bg-slate-800 text-slate-100">高</option>
                            </select>
                            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
                          </div>
                          <label className="flex items-center gap-1 cursor-pointer" title="支持图生图">
                            <input
                              type="checkbox"
                              checked={model.supportsImageRef || false}
                              onChange={(e) => updateModel('image', index, 'supportsImageRef', e.target.checked)}
                              className="accent-violet-500"
                            />
                            <span className="text-xs text-slate-400">图生图</span>
                          </label>
                          <button
                            onClick={() => removeModel('image', index)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition ml-auto"
                            title="删除"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                      {(!settings.image_fallback_chain || settings.image_fallback_chain.length === 0) && (
                        <div className="text-center py-4 text-slate-500 text-sm">
                          暂无图像模型，点击上方按钮添加
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              <div className="h-px bg-white/10" />

              {/* 项目备份与恢复 */}
              {projectId && (
                <section>
                  <h3 className="text-sm font-medium text-violet-300 mb-4 flex items-center">
                    <span className="w-1 h-4 bg-violet-400 rounded-full mr-2" />
                    项目备份与恢复
                  </h3>

                  <div className="space-y-4">
                    <button
                      onClick={handleBackup}
                      disabled={backingUp}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-violet-500/20 to-fuchsia-500/20 border border-violet-500/30 hover:from-violet-500/30 hover:to-fuchsia-500/30 text-violet-200 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      {backingUp ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                      导出项目备份（JSON）
                    </button>

                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <label className="text-sm text-slate-300">导入模式：</label>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="radio"
                              checked={importMode === 'new'}
                              onChange={() => setImportMode('new')}
                              className="accent-violet-500"
                            />
                            <span className="text-sm text-slate-300">新建项目</span>
                          </label>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="radio"
                              checked={importMode === 'merge'}
                              onChange={() => setImportMode('merge')}
                              className="accent-violet-500"
                            />
                            <span className="text-sm text-slate-300">合并到当前</span>
                          </label>
                        </div>
                      </div>

                      <button
                        onClick={handleImportClick}
                        disabled={importing}
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-slate-200 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        {importing ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Upload className="w-4 h-4" />
                        )}
                        从备份文件导入
                      </button>

                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json"
                        onChange={handleFileChange}
                        className="hidden"
                      />

                      {importMode === 'merge' && (
                        <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          <p className="text-xs text-amber-300">
                            合并模式会将备份中的场次和分镜添加到当前项目，不会覆盖现有数据。
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              )}

              <div className="h-px bg-white/10" />

              {/* 管理员鉴权 */}
              <section>
                <h3 className="text-sm font-medium text-violet-300 mb-4 flex items-center">
                  <span className="w-1 h-4 bg-violet-400 rounded-full mr-2" />
                  管理员鉴权
                </h3>

                {!authEnabled ? (
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                    <Lock className="w-4 h-4 text-emerald-400 shrink-0" />
                    <p className="text-xs text-emerald-300">
                      未启用管理员鉴权，所有操作均可公开访问。
                    </p>
                  </div>
                ) : authenticated ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                      <LogIn className="w-4 h-4 text-emerald-400 shrink-0" />
                      <p className="text-sm text-emerald-300">
                        已登录，拥有管理员权限
                      </p>
                    </div>
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300 text-sm font-medium transition"
                    >
                      <LogOut className="w-4 h-4" />
                      退出登录
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="relative">
                      <input
                        type={showToken ? 'text' : 'password'}
                        value={loginToken}
                        onChange={(e) => setLoginToken(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                        placeholder="请输入管理员密码"
                        className="w-full px-4 py-2.5 pr-10 rounded-xl bg-white/5 border border-white/10 focus:border-violet-400/50 outline-none text-slate-200 placeholder-slate-500"
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken(!showToken)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition"
                      >
                        {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <button
                      onClick={handleLogin}
                      disabled={loginLoading || !loginToken.trim()}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:shadow-lg hover:shadow-violet-500/30 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      {loginLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                      <LogIn className="w-4 h-4" />
                      登录
                    </button>
                  </div>
                )}
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
