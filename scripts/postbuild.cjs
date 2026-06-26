const fs = require('fs');
const path = require('path');

const distPath = path.resolve(__dirname, '../dist');
const indexPath = path.join(distPath, 'index.html');

let html = fs.readFileSync(indexPath, 'utf-8');

const legacyPolyfillsMatch = html.match(/<script[^>]*id="vite-legacy-polyfill"[^>]*src="([^"]+)"[^>]*>/);
const legacyEntryMatch = html.match(/<script[^>]*id="vite-legacy-entry"[^>]*data-src="([^"]+)"[^>]*>/);
const cssMatch = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);

if (!legacyPolyfillsMatch || !legacyEntryMatch) {
  console.error('未找到 legacy 脚本');
  process.exit(1);
}

const legacyPolyfillsSrc = legacyPolyfillsMatch[1];
const legacyEntrySrc = legacyEntryMatch[1];
const cssHref = cssMatch ? cssMatch[1] : '';

const newHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="shortcut icon" type="image/svg+xml" href="/favicon.svg" />
    <title>柒子文化拍摄辅助</title>
    
    <!-- Open Graph Meta Tags for Social Sharing -->
    <meta property="og:title" content="柒子文化拍摄辅助" />
    <meta property="og:description" content="专业项目管理 · 镜头管理" />
    <meta property="og:image" content="/images/hero-home.png" />
    <meta property="og:url" content="https://video.qiziwenhua.top" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="柒子文化拍摄辅助" />
    
    <!-- WeChat Specific Meta Tags -->
    <meta name="description" content="专业项目管理 · 镜头管理" />
    <meta name="wechat:title" content="柒子文化拍摄辅助" />
    <meta name="wechat:description" content="专业项目管理 · 镜头管理" />
    <meta name="wechat:image" content="/images/hero-home.png" />
    
    <!-- Twitter Card Meta Tags -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="柒子文化拍摄辅助" />
    <meta name="twitter:description" content="专业项目管理 · 镜头管理" />
    <meta name="twitter:image" content="/images/hero-home.png" />
    ${cssHref ? `<link rel="stylesheet" href="${cssHref}">` : ''}
  </head>
  <body style="margin: 0; background: #0c0e14; color: #e5e4ed; font-family: system-ui, -apple-system, sans-serif;">
    <div id="root"></div>
    <noscript>
      <div style="padding: 40px; text-align: center; background: #fff; color: #000; min-height: 100vh;">
        <h1 style="color: #dc2626;">需要启用 JavaScript</h1>
        <p>请在浏览器设置中启用 JavaScript 后刷新页面</p>
      </div>
    </noscript>
    <script src="${legacyPolyfillsSrc}"></script>
    <script src="${legacyEntrySrc}"></script>
  </body>
</html>
`;

fs.writeFileSync(indexPath, newHtml, 'utf-8');
console.log('✅ 已强制使用 legacy 版本（兼容旧浏览器）');
