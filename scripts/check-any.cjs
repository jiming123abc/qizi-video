// 检查 src/ 目录下的显式 any 类型使用
// 用法: node scripts/check-any.cjs
// 发现显式 any 时退出码 1，否则退出码 0
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');
// 匹配显式 any 类型: : any, <any>, as any, any[]
const ANY_PATTERN = /:\s*any\b|<any>|as any\b|\bany\[\]/;
const SKIP_DIRS = ['node_modules', 'dist'];

const found = [];

function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.includes(entry.name)) {
        scan(fullPath);
      }
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // 跳过注释行
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (ANY_PATTERN.test(line)) {
          const relPath = path.relative(SRC_DIR, fullPath);
          found.push(`${relPath}:${i + 1}: ${trimmed}`);
        }
      });
    }
  }
}

scan(SRC_DIR);

if (found.length > 0) {
  console.error(`\n发现 ${found.length} 处显式 any 类型：\n`);
  found.forEach(f => console.error(`  ${f}`));
  console.error('\n请使用具体类型或 unknown 替代 any。');
  process.exit(1);
}

console.log('✓ 未发现显式 any 类型');
