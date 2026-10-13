const OSS = require('ali-oss');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ALIYUN_ACCESS_KEY_ID = process.env.ALIYUN_ACCESS_KEY_ID || process.env.ALIYUN_ACCESS_KEY_ID_DEV || process.env.OSS_ACCESS_KEY_ID || process.env.OSS_ACCESS_KEY_ID_DEV;
const ALIYUN_ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || process.env.ALIYUN_ACCESS_KEY_SECRET_DEV || process.env.OSS_ACCESS_KEY_SECRET || process.env.OSS_ACCESS_KEY_SECRET_DEV;
const OSS_BUCKET = process.env.OSS_BUCKET || process.env.OSS_BUCKET_DEV;
const OSS_REGION = process.env.OSS_REGION || process.env.OSS_REGION_DEV || 'oss-cn-beijing';

const ossClient = new OSS({
  accessKeyId: ALIYUN_ACCESS_KEY_ID,
  accessKeySecret: ALIYUN_ACCESS_KEY_SECRET,
  bucket: OSS_BUCKET,
  region: OSS_REGION,
  secure: true
});

const VIDEO_URL = 'https://qizi-video-store.oss-cn-beijing.aliyuncs.com/projects/5/shot-references/videos/1784312650548-toyk55gp-无需压缩.mp4';

function extractOssKey(url) {
  try {
    const urlObj = new URL(url);
    return decodeURIComponent(urlObj.pathname.replace(/^\//, ''));
  } catch (e) {
    return null;
  }
}

async function getSnapshot(ossKey, timeMs, width = 400) {
  const process = `video/snapshot,t_${timeMs},f_jpg,w_${width}`;
  const signedUrl = ossClient.signatureUrl(ossKey, {
    expires: 3600,
    process
  });
  
  const response = await fetch(signedUrl);
  if (!response.ok) {
    throw new Error(`OSS returned ${response.status}: ${response.statusText}`);
  }
  
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer;
}

async function calculatePixelDiff(buffer1, buffer2) {
  const img1 = sharp(buffer1).greyscale();
  const img2 = sharp(buffer2).greyscale();
  
  const [data1, data2] = await Promise.all([
    img1.raw().toBuffer(),
    img2.raw().toBuffer()
  ]);
  
  let diffPixels = 0;
  let totalDiff = 0;
  const len = Math.min(data1.length, data2.length);
  
  for (let i = 0; i < len; i++) {
    const diff = Math.abs(data1[i] - data2[i]);
    totalDiff += diff;
    if (diff > 20) {
      diffPixels++;
    }
  }
  
  const diffPercentage = (diffPixels / len) * 100;
  const avgDiff = totalDiff / len;
  
  return { diffPixels, diffPercentage, avgDiff, totalPixels: len };
}

async function analyzeTransition(ossKey, startTime, endTime, step, label) {
  console.log(`\n=== ${label} (${startTime}ms - ${endTime}ms, step ${step}ms) ===`);
  
  const times = [];
  for (let t = startTime; t <= endTime; t += step) {
    times.push(t);
  }
  
  const snapshots = [];
  for (const t of times) {
    try {
      const buffer = await getSnapshot(ossKey, t, 200);
      snapshots.push({ time: t, buffer });
      await new Promise(r => setTimeout(r, 50));
    } catch (e) {
      console.log(`  获取 ${t}ms 截图失败: ${e.message}`);
    }
  }
  
  console.log(`\n  相邻帧像素差异分析：`);
  let maxDiff = 0;
  let maxDiffTime = 0;
  
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    
    const diff = await calculatePixelDiff(prev.buffer, curr.buffer);
    
    console.log(`  ${prev.time}ms -> ${curr.time}ms: ` +
      `差异像素=${diff.diffPixels.toLocaleString()} ` +
      `(${diff.diffPercentage.toFixed(2)}%), ` +
      `平均差异=${diff.avgDiff.toFixed(2)}`);
    
    if (diff.diffPercentage > maxDiff) {
      maxDiff = diff.diffPercentage;
      maxDiffTime = curr.time;
    }
  }
  
  console.log(`\n  最大差异点: ${maxDiffTime}ms (${maxDiff.toFixed(2)}%)`);
  
  return { maxDiffTime, maxDiff, snapshots };
}

async function main() {
  const ossKey = extractOssKey(VIDEO_URL);
  console.log('OSS Key:', ossKey);
  
  const firstResult = await analyzeTransition(
    ossKey,
    2000, 3000, 50,
    '第一个切换点粗扫描'
  );
  
  const fineStart = Math.max(2000, firstResult.maxDiffTime - 100);
  const fineEnd = Math.min(3000, firstResult.maxDiffTime + 100);
  
  const firstFineResult = await analyzeTransition(
    ossKey,
    fineStart, fineEnd, 10,
    '第一个切换点精细扫描'
  );
  
  const secondResult = await analyzeTransition(
    ossKey,
    8500, 9700, 50,
    '第二个切换点粗扫描'
  );
  
  const fineStart2 = Math.max(8500, secondResult.maxDiffTime - 100);
  const fineEnd2 = Math.min(9700, secondResult.maxDiffTime + 100);
  
  const secondFineResult = await analyzeTransition(
    ossKey,
    fineStart2, fineEnd2, 10,
    '第二个切换点精细扫描'
  );
  
  console.log('\n' + '='.repeat(60));
  console.log('最终结果：');
  console.log('='.repeat(60));
  console.log(`第一个切换点: ~${firstFineResult.maxDiffTime}ms (${(firstFineResult.maxDiffTime/1000).toFixed(3)}s)`);
  console.log(`第二个切换点: ~${secondFineResult.maxDiffTime}ms (${(secondFineResult.maxDiffTime/1000).toFixed(3)}s)`);
  
  console.log('\n与数据库中 startTime 的对比：');
  console.log(`第一个切换点: 数据库=2.43s, 实际=${(firstFineResult.maxDiffTime/1000).toFixed(3)}s, 差距=${(firstFineResult.maxDiffTime/1000 - 2.43).toFixed(3)}s`);
  console.log(`第二个切换点: 数据库=9.17s, 实际=${(secondFineResult.maxDiffTime/1000).toFixed(3)}s, 差距=${(secondFineResult.maxDiffTime/1000 - 9.17).toFixed(3)}s`);
}

main().then(() => {
  console.log('\n完成！');
  process.exit(0);
}).catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
