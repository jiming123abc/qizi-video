import { useState, useEffect } from 'react';
import {
  batchGetSignedUrls,
  getSignedUrlFromCache,
  hasFreshSignedUrl,
  isDirectAccessibleUrl,
  subscribeSignUrlUpdate
} from '../lib/ossUtils';

const pendingUrls = new Set<string>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBatch() {
  if (batchTimer) return;
  batchTimer = setTimeout(async () => {
    batchTimer = null;
    const urls = Array.from(pendingUrls);
    pendingUrls.clear();
    if (urls.length > 0) {
      await batchGetSignedUrls(urls);
    }
  }, 100);
}

function requestSignUrl(url: string) {
  if (!url) return;
  pendingUrls.add(url);
  scheduleBatch();
}

// 组件级别：为单个 URL 获取签名 URL
// 使用 pub-sub 订阅缓存更新，替代轮询；保留长间隔轮询作为兜底
export interface SignedUrlResult {
  url: string;
  ready: boolean;
}

export function useSignedUrl(originalUrl: string | undefined | null): SignedUrlResult {
  // 可直接访问的 URL（本地/代理/data URI）无需签名，立即就绪
  const direct = isDirectAccessibleUrl(originalUrl);
  const [signedUrl, setSignedUrl] = useState<string>(() =>
    originalUrl ? getSignedUrlFromCache(originalUrl) : ''
  );
  const [ready, setReady] = useState<boolean>(
    () => !!originalUrl && (isDirectAccessibleUrl(originalUrl) || hasFreshSignedUrl(originalUrl))
  );

  useEffect(() => {
    if (!originalUrl) {
      setSignedUrl('');
      setReady(false);
      return;
    }

    // 本地静态资源 / 后端代理 / data URI：直接使用原 URL，不发起签名
    if (isDirectAccessibleUrl(originalUrl)) {
      setSignedUrl(originalUrl);
      setReady(true);
      return;
    }

    // OSS URL：就绪与否以"缓存中是否有新鲜签名结果"为准，
    // 不能比较签名值与原 URL 是否相等（后端回退时两者可能相同）
    const syncFromCache = () => {
      const latest = getSignedUrlFromCache(originalUrl);
      setSignedUrl(prev => (prev !== latest ? latest : prev));
      setReady(hasFreshSignedUrl(originalUrl));
    };
    syncFromCache();

    if (!hasFreshSignedUrl(originalUrl)) {
      requestSignUrl(originalUrl);
    }

    const unsubscribe = subscribeSignUrlUpdate(updatedUrls => {
      if (updatedUrls.includes(originalUrl)) {
        syncFromCache();
      }
    });

    const startTime = Date.now();
    const fallbackInterval = setInterval(() => {
      syncFromCache();
      if (hasFreshSignedUrl(originalUrl) || Date.now() - startTime > 30000) {
        clearInterval(fallbackInterval);
      }
    }, 2000);

    return () => {
      unsubscribe();
      clearInterval(fallbackInterval);
    };
  }, [originalUrl]);

  const finalUrl = signedUrl || originalUrl || '';

  return { url: finalUrl, ready };
}
