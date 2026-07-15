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
export interface SignedUrlResult {
  url: string;
  ready: boolean;
}

export function useSignedUrl(originalUrl: string | undefined | null): SignedUrlResult {
  const [signedUrl, setSignedUrl] = useState<string>('');

  useEffect(() => {
    if (!originalUrl) {
      setSignedUrl('');
      return;
    }

    const cached = getSignedUrlFromCache(originalUrl);
    setSignedUrl(cached);

    if (cached === originalUrl) {
      requestSignUrl(originalUrl);
    }

    const unsubscribe = subscribeSignUrlUpdate(updatedUrls => {
      if (updatedUrls.includes(originalUrl)) {
        const latest = getSignedUrlFromCache(originalUrl);
        setSignedUrl(prev => (prev !== latest ? latest : prev));
      }
    });

    const startTime = Date.now();
    const fallbackInterval = setInterval(() => {
      const latest = getSignedUrlFromCache(originalUrl);
      if (latest !== originalUrl) {
        setSignedUrl(prev => (prev !== latest ? latest : prev));
      }
      if (latest !== originalUrl || Date.now() - startTime > 30000) {
        clearInterval(fallbackInterval);
      }
    }, 2000);

    return () => {
      unsubscribe();
      clearInterval(fallbackInterval);
    };
  }, [originalUrl]);

  const finalUrl = signedUrl || originalUrl || '';
  const ready = !!finalUrl && signedUrl !== '' && signedUrl !== originalUrl;

  return { url: finalUrl, ready };
}
