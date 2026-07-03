import { useState, useEffect } from 'react';
import { batchGetSignedUrls, getSignedUrlFromCache, subscribeSignUrlUpdate } from '../lib/ossUtils';

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
export function useSignedUrl(originalUrl: string | undefined | null): string {
  const [signedUrl, setSignedUrl] = useState<string>('');

  useEffect(() => {
    if (!originalUrl) {
      setSignedUrl('');
      return;
    }

    // 立即返回缓存中的值（同步）
    const cached = getSignedUrlFromCache(originalUrl);
    setSignedUrl(cached);

    // 如果缓存未命中，请求签名
    if (cached === originalUrl) {
      requestSignUrl(originalUrl);
    }

    // 订阅缓存更新：当本 URL 的签名就绪时立即更新 state
    const unsubscribe = subscribeSignUrlUpdate(updatedUrls => {
      if (updatedUrls.includes(originalUrl)) {
        const latest = getSignedUrlFromCache(originalUrl);
        setSignedUrl(prev => (prev !== latest ? latest : prev));
      }
    });

    // 兜底：长间隔轮询（2s），防止 pub-sub 遗漏；最多持续 30s
    const startTime = Date.now();
    const fallbackInterval = setInterval(() => {
      const latest = getSignedUrlFromCache(originalUrl);
      if (latest !== originalUrl) {
        setSignedUrl(prev => (prev !== latest ? latest : prev));
      }
      // 签名就绪或超过 30s 则停止兜底轮询
      if (latest !== originalUrl || Date.now() - startTime > 30000) {
        clearInterval(fallbackInterval);
      }
    }, 2000);

    return () => {
      unsubscribe();
      clearInterval(fallbackInterval);
    };
  }, [originalUrl]);

  return signedUrl || originalUrl || '';
}
