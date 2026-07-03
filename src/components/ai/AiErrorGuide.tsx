import React, { useMemo } from 'react';
import { AlertCircle, Settings } from 'lucide-react';

export interface ErrorGuide {
  type: 'api_key' | 'model' | 'network' | 'quota' | 'timeout' | 'content' | 'unknown';
  title: string;
  suggestions: string[];
  showSettingsButton?: boolean;
}

export function analyzeAiError(errorMsg: string): ErrorGuide {
  const msg = errorMsg.toLowerCase();

  if (msg.includes('api key') || msg.includes('apikey') || msg.includes('401') || msg.includes('unauthorized') || msg.includes('未配置') || msg.includes('无效')) {
    return {
      type: 'api_key',
      title: 'API Key 问题',
      suggestions: [
        '请检查 API Key 是否已正确配置',
        '确认 API Key 没有拼写错误或多余空格',
        '确认 API Key 仍在有效期内',
      ],
      showSettingsButton: true,
    };
  }

  if (msg.includes('model') || msg.includes('模型') || msg.includes('不存在') || msg.includes('not found') || msg.includes('不支持')) {
    return {
      type: 'model',
      title: '模型问题',
      suggestions: [
        '请检查模型名称是否正确',
        '尝试更换其他模型',
        '确认该模型是否支持当前功能',
      ],
      showSettingsButton: true,
    };
  }

  if (msg.includes('网络') || msg.includes('network') || msg.includes('timeout') || msg.includes('超时') || msg.includes('连接') || msg.includes('failed to fetch')) {
    return {
      type: 'network',
      title: '网络问题',
      suggestions: [
        '请检查网络连接是否正常',
        '稍后重试',
        '确认当前网络可以访问 AI 服务',
      ],
    };
  }

  if (msg.includes('余额') || msg.includes('quota') || msg.includes('额度') || msg.includes('insufficient') || msg.includes('超限')) {
    return {
      type: 'quota',
      title: '额度不足',
      suggestions: [
        '请检查账户余额或配额是否充足',
        '前往对应 AI 平台充值',
        '更换其他可用的模型或平台',
      ],
      showSettingsButton: true,
    };
  }

  if (msg.includes('内容') || msg.includes('违规') || msg.includes('安全') || msg.includes('content') || msg.includes('safety') || msg.includes('敏感')) {
    return {
      type: 'content',
      title: '内容安全问题',
      suggestions: [
        '请检查内容是否包含违规或敏感信息',
        '调整提示词描述，避免敏感内容',
        '尝试使用其他模型',
      ],
    };
  }

  if (msg.includes('超时') || msg.includes('timed out') || msg.includes('耗时过长')) {
    return {
      type: 'timeout',
      title: '请求超时',
      suggestions: [
        '建议更换响应更快的模型',
        '稍后重试',
        '减少输入内容长度或复杂度',
      ],
    };
  }

  return {
    type: 'unknown',
    title: '操作失败',
    suggestions: [
      '请稍后重试',
      '如问题持续，请检查 API 配置和网络连接',
    ],
    showSettingsButton: true,
  };
}

interface AiErrorGuideProps {
  error: string;
  onOpenSettings?: () => void;
}

export function AiErrorGuide({ error, onOpenSettings }: AiErrorGuideProps) {
  const guide = useMemo(() => analyzeAiError(error), [error]);

  return (
    <div className="p-3 sm:p-4 rounded-xl bg-red-500/10 border border-red-500/20">
      <div className="flex items-start gap-2">
        <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-red-300">{guide.title}</p>
          <p className="text-xs text-red-400/80 mt-1 break-words">{error}</p>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-red-500/10">
        <p className="text-xs text-red-300/80 mb-2">可能的解决方法：</p>
        <ul className="space-y-1">
          {guide.suggestions.map((s, i) => (
            <li key={i} className="text-xs text-red-400/70 flex items-start gap-1.5">
              <span className="text-red-400/50">•</span>
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </div>
      {guide.showSettingsButton && onOpenSettings && (
        <button
          onClick={onOpenSettings}
          className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-200 text-xs transition min-h-[40px]"
        >
          <Settings className="w-3.5 h-3.5" />
          打开设置
        </button>
      )}
    </div>
  );
}
