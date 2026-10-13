const OSS = require('ali-oss');
const fs = require('fs');
const path = require('path');
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

async function fineGrainedAnalysis() {
  const ossKey = extractOssKey(VIDEO_URL);
  console.log('OSS Key:', ossKey);
  
  const outputDir = path.join(__dirname, '../screenshots/transitions');
  
  const firstTransitionFine = [2410, 2420, 2430, 2440, 2450, 2460, 2470, 2480, 2490];
  const secondTransitionFine = [9110, 9120, 9130, 9140, 9150, 9160, 9170, 9180, 9190, 9200];
  
  console.log('\n=== 第一个切换点细粒度分析（2410-2490ms）===');
  for (const t of firstTransitionFine) {
    try {
      const buffer = await getSnapshot(ossKey, t, 400);
      const filename = `first_fine_${t}ms.jpg`;
      const filepath = path.join(outputDir, filename);
      fs.writeFileSync(filepath, buffer);
      console.log(`  ${t}ms (${(t/1000).toFixed(3)}s): ${buffer.length} bytes`);
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      console.log(`  ${t}ms: 失败 - ${e.message}`);
    }
  }
  
  console.log('\n=== 第二个切换点细粒度分析（9110-9200ms）===');
  for (const t of secondTransitionFine) {
    try {
      const buffer = await getSnapshot(ossKey, t, 400);
      const filename = `second_fine_${t}ms.jpg`;
      const filepath = path.join(outputDir, filename);
      fs.writeFileSync(filepath, buffer);
      console.log(`  ${t}ms (${(t/1000).toFixed(3)}s): ${buffer.length} bytes`);
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      console.log(`  ${t}ms: 失败 - ${e.message}`);
    }
  }
  
  console.log('\n细粒度截图已保存到:', outputDir);
}

fineGrainedAnalysis().then(() => {
  console.log('\n完成！');
  process.exit(0);
}).catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
