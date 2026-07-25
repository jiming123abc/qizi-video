const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'data.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database');
    initDatabase();
  }
});

function initDatabase() {
  db.serialize(() => {
    // [DEPRECATED] 企业官网旧表，已废弃，不再创建
    // 保留代码仅供参考，未来版本可删除
    // portfolio_items, featured_works, home_content, team_members, categories_details

    // storyboard 相关表在下方 initStoryboardDatabase 中创建
  });
}

function insertInitialData() {
  console.log('[legacy] 跳过企业官网旧表初始数据插入（storyboard 为独立数据库）');
}

const dbAsync = {
  get: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  all: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },
  run: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  },
  // P4-2：事务辅助方法，包裹多步写操作保证原子性
  // 用法：await dbAsync.transaction(async (tx) => { await tx.run(...); await tx.run(...); });
  // tx 与 dbAsync 等价（同一连接），BEGIN/COMMIT/ROLLBACK 控制事务边界
  transaction: async (fn) => {
    await dbAsync.run('BEGIN');
    try {
      const result = await fn(dbAsync);
      await dbAsync.run('COMMIT');
      return result;
    } catch (e) {
      await dbAsync.run('ROLLBACK').catch(() => {});
      throw e;
    }
  }
};

const portfolioItems = {
  getAll: async () => {
    const rows = await dbAsync.all('SELECT * FROM portfolio_items ORDER BY sortOrder ASC, id ASC');
    return rows.map(row => ({
      ...row,
      images: row.images ? JSON.parse(row.images) : undefined
    }));
  },
  create: async (item) => {
    const result = await dbAsync.run(
      'INSERT INTO portfolio_items (title, category, tag, shortDesc, fullDesc, img, images, videoUrl, type, color, bgGlow, hidden, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        item.title, item.category, item.tag, item.shortDesc, item.fullDesc,
        item.img, item.images ? JSON.stringify(item.images) : null, 
        item.videoUrl, item.type, item.color, item.bgGlow, item.hidden ? 1 : 0, item.sortOrder
      ]
    );
    return { id: result.lastID, ...item };
  },
  update: async (id, item) => {
    await dbAsync.run(
      'UPDATE portfolio_items SET title=?, category=?, tag=?, shortDesc=?, fullDesc=?, img=?, images=?, videoUrl=?, type=?, color=?, bgGlow=?, hidden=?, sortOrder=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?',
      [
        item.title, item.category, item.tag, item.shortDesc, item.fullDesc,
        item.img, item.images ? JSON.stringify(item.images) : null,
        item.videoUrl, item.type, item.color, item.bgGlow, item.hidden ? 1 : 0, item.sortOrder, id
      ]
    );
    return { id, ...item };
  },
  put: async (item) => {
    const id = item.id;
    const existing = await dbAsync.get('SELECT id FROM portfolio_items WHERE id=?', [id]);
    if (existing) {
      await dbAsync.run(
        'UPDATE portfolio_items SET title=?, category=?, tag=?, shortDesc=?, fullDesc=?, img=?, images=?, videoUrl=?, type=?, color=?, bgGlow=?, hidden=?, sortOrder=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?',
        [
          item.title, item.category, item.tag, item.shortDesc, item.fullDesc,
          item.img, item.images ? JSON.stringify(item.images) : null,
          item.videoUrl, item.type, item.color, item.bgGlow, item.hidden ? 1 : 0, item.sortOrder, id
        ]
      );
    } else {
      await dbAsync.run(
        'INSERT INTO portfolio_items (id, title, category, tag, shortDesc, fullDesc, img, images, videoUrl, type, color, bgGlow, hidden, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id, item.title, item.category, item.tag, item.shortDesc, item.fullDesc,
          item.img, item.images ? JSON.stringify(item.images) : null,
          item.videoUrl, item.type, item.color, item.bgGlow, item.hidden ? 1 : 0, item.sortOrder
        ]
      );
    }
    return item;
  },
  updateSort: async (items) => {
    for (const item of items) {
      await dbAsync.run(
        'UPDATE portfolio_items SET sortOrder=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?',
        [item.sortOrder, item.id]
      );
    }
    return items;
  },
  delete: async (id) => {
    // 先删除精选作品表中的相关记录
    await dbAsync.run('DELETE FROM featured_works WHERE portfolioId=?', [id]);
    // 再删除作品本身
    await dbAsync.run('DELETE FROM portfolio_items WHERE id=?', [id]);
    return true;
  }
};



const featuredWorks = {
  getAll: async () => {
    const rows = await dbAsync.all('SELECT * FROM featured_works ORDER BY sortOrder ASC');
    return rows;
  },
  create: async (work) => {
    // 先检查是否已存在
    const existing = await dbAsync.get(
      'SELECT * FROM featured_works WHERE portfolioId=?',
      [work.portfolioId]
    );
    if (existing) {
      // 已存在，直接返回现有数据
      return existing;
    }
    await dbAsync.run(
      'INSERT INTO featured_works (id, portfolioId, sortOrder) VALUES (?, ?, ?)',
      [work.id, work.portfolioId, work.sortOrder]
    );
    return work;
  },
  put: async (work) => {
    const id = work.id;
    const existing = await dbAsync.get('SELECT id FROM featured_works WHERE id=?', [id]);
    if (existing) {
      await dbAsync.run(
        'UPDATE featured_works SET portfolioId=?, sortOrder=? WHERE id=?',
        [work.portfolioId, work.sortOrder, id]
      );
    } else {
      await dbAsync.run(
        'INSERT INTO featured_works (id, portfolioId, sortOrder) VALUES (?, ?, ?)',
        [work.id, work.portfolioId, work.sortOrder]
      );
    }
    return work;
  },
  delete: async (id) => {
    await dbAsync.run('DELETE FROM featured_works WHERE id=?', [id]);
    return true;
  },
  updateSort: async (works) => {
    await dbAsync.run('DELETE FROM featured_works');
    for (const work of works) {
      await dbAsync.run(
        'INSERT INTO featured_works (id, portfolioId, sortOrder) VALUES (?, ?, ?)',
        [work.id, work.portfolioId, work.sortOrder]
      );
    }
    return works;
  }
};

const homeContent = {
  get: async () => {
    const row = await dbAsync.get('SELECT * FROM home_content WHERE id=1');
    return row ? {
      heroTitle: row.heroTitle,
      heroGradientTitle: row.heroGradientTitle,
      heroSubtitle: row.heroSubtitle,
      heroSlides: row.heroSlides ? JSON.parse(row.heroSlides) : [],
      heroImage: row.heroImage || '/images/hero-home.png',
      shareTitle: row.shareTitle || '大连柒子文化发展有限公司',
      shareDescription: row.shareDescription || '诚信立足 创新致远'
    } : {
      heroTitle: "开启未来的",
      heroGradientTitle: "视界 Matrix",
      heroSubtitle: "通过 AIGC 重新定义数字影像。我们将人类的情感与神经计算相结合，打造跨越维度的奇迹。",
      heroSlides: [
        { id: 1, img: '/images/hero-video.png', label: 'Neural Stream', title: 'Ethereal Segment 01' },
        { id: 2, img: '/images/ai-digital-human.png', label: 'Digital Human', title: 'Avatar Segment 02' },
        { id: 3, img: '/images/ai-film-production.png', label: 'Film Production', title: 'Cinematic Segment 03' }
      ],
      heroImage: '/images/hero-home.png',
      shareTitle: '大连柒子文化发展有限公司',
      shareDescription: '诚信立足 创新致远'
    };
  },
  update: async (content) => {
    await dbAsync.run(
      'INSERT OR REPLACE INTO home_content (id, heroTitle, heroGradientTitle, heroSubtitle, heroSlides, heroImage, shareTitle, shareDescription, updatedAt) VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [
        content.heroTitle,
        content.heroGradientTitle,
        content.heroSubtitle,
        content.heroSlides ? JSON.stringify(content.heroSlides) : null,
        content.heroImage || '/images/hero-home.png',
        content.shareTitle || '大连柒子文化发展有限公司',
        content.shareDescription || '诚信立足 创新致远'
      ]
    );
    return content;
  },
  put: async (content) => {
    return homeContent.update(content);
  }
};

const teamMembers = {
  getAll: async () => {
    const rows = await dbAsync.all('SELECT * FROM team_members ORDER BY sortOrder ASC, id ASC');
    return rows;
  },
  create: async (member) => {
    const result = await dbAsync.run(
      'INSERT INTO team_members (name, role, avatar, bio, fullDesc, sortOrder) VALUES (?, ?, ?, ?, ?, ?)',
      [member.name, member.role, member.avatar, member.bio, member.fullDesc, member.sortOrder]
    );
    return { id: result.lastID, ...member };
  },
  update: async (id, member) => {
    await dbAsync.run(
      'UPDATE team_members SET name=?, role=?, avatar=?, bio=?, fullDesc=?, sortOrder=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?',
      [member.name, member.role, member.avatar, member.bio, member.fullDesc, member.sortOrder, id]
    );
    return { id, ...member };
  },
  put: async (member) => {
    const id = member.id;
    const existing = await dbAsync.get('SELECT id FROM team_members WHERE id=?', [id]);
    if (existing) {
      await dbAsync.run(
        'UPDATE team_members SET name=?, role=?, avatar=?, bio=?, fullDesc=?, sortOrder=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?',
        [member.name, member.role, member.avatar, member.bio, member.fullDesc, member.sortOrder, id]
      );
    } else {
      await dbAsync.run(
        'INSERT INTO team_members (id, name, role, avatar, bio, fullDesc, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [member.id, member.name, member.role, member.avatar, member.bio, member.fullDesc, member.sortOrder]
      );
    }
    return member;
  },
  delete: async (id) => {
    await dbAsync.run('DELETE FROM team_members WHERE id=?', [id]);
    return true;
  }
};

const categoriesDetails = {
  getAll: async () => {
    const rows = await dbAsync.all('SELECT * FROM categories_details ORDER BY sortOrder ASC');
    return rows;
  },
  create: async (category) => {
    await dbAsync.run(
      'INSERT INTO categories_details (id, name, description, coverImage, icon, sortOrder, tag, color, bgGlow) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        category.id, category.name, category.description, category.coverImage,
        category.icon, category.sortOrder, category.tag, category.color, category.bgGlow
      ]
    );
    return category;
  },
  update: async (id, category) => {
    const oldCategory = await dbAsync.get('SELECT * FROM categories_details WHERE id=?', [id]);
    if (!oldCategory) throw new Error('分类不存在');
    const oldName = oldCategory.name;

    const merged = {
      name: category.name !== undefined ? category.name : oldCategory.name,
      description: category.description !== undefined ? category.description : oldCategory.description,
      coverImage: category.coverImage !== undefined ? category.coverImage : oldCategory.coverImage,
      icon: category.icon !== undefined ? category.icon : oldCategory.icon,
      sortOrder: category.sortOrder !== undefined ? category.sortOrder : oldCategory.sortOrder,
      tag: category.tag !== undefined ? category.tag : oldCategory.tag,
      color: category.color !== undefined ? category.color : oldCategory.color,
      bgGlow: category.bgGlow !== undefined ? category.bgGlow : oldCategory.bgGlow,
    };

    await dbAsync.run(
      'UPDATE categories_details SET name=?, description=?, coverImage=?, icon=?, sortOrder=?, tag=?, color=?, bgGlow=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?',
      [
        merged.name, merged.description, merged.coverImage, merged.icon,
        merged.sortOrder, merged.tag, merged.color, merged.bgGlow, id
      ]
    );

    if (oldName && merged.name && oldName !== merged.name) {
      await dbAsync.run(
        'UPDATE portfolio_items SET category=?, updatedAt=CURRENT_TIMESTAMP WHERE category=?',
        [merged.name, oldName]
      );
    }

    return { id, ...merged };
  },
  put: async (category) => {
    const id = category.id;
    const existing = await dbAsync.get('SELECT * FROM categories_details WHERE id=?', [id]);
    if (existing) {
      const oldName = existing.name;

      const merged = {
        name: category.name !== undefined ? category.name : existing.name,
        description: category.description !== undefined ? category.description : existing.description,
        coverImage: category.coverImage !== undefined ? category.coverImage : existing.coverImage,
        icon: category.icon !== undefined ? category.icon : existing.icon,
        sortOrder: category.sortOrder !== undefined ? category.sortOrder : existing.sortOrder,
        tag: category.tag !== undefined ? category.tag : existing.tag,
        color: category.color !== undefined ? category.color : existing.color,
        bgGlow: category.bgGlow !== undefined ? category.bgGlow : existing.bgGlow,
      };

      await dbAsync.run(
        'UPDATE categories_details SET name=?, description=?, coverImage=?, icon=?, sortOrder=?, tag=?, color=?, bgGlow=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?',
        [
          merged.name, merged.description, merged.coverImage, merged.icon,
          merged.sortOrder, merged.tag, merged.color, merged.bgGlow, id
        ]
      );

      if (oldName && merged.name && oldName !== merged.name) {
        await dbAsync.run(
          'UPDATE portfolio_items SET category=?, updatedAt=CURRENT_TIMESTAMP WHERE category=?',
          [merged.name, oldName]
        );
      }
      return { id, ...merged };
    } else {
      await dbAsync.run(
        'INSERT INTO categories_details (id, name, description, coverImage, icon, sortOrder, tag, color, bgGlow) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          category.id, category.name, category.description, category.coverImage,
          category.icon, category.sortOrder, category.tag, category.color, category.bgGlow
        ]
      );
      return category;
    }
  },
  updateSort: async (categories) => {
    for (const cat of categories) {
      await dbAsync.run(
        'UPDATE categories_details SET sortOrder=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?',
        [cat.sortOrder, cat.id]
      );
    }
    return categories;
  },
  delete: async (id) => {
    // 先获取要删除的分类的名称
    const category = await dbAsync.get('SELECT name FROM categories_details WHERE id=?', [id]);
    if (category) {
      // 清空所有该分类的作品的 category 字段
      await dbAsync.run(
        'UPDATE portfolio_items SET category=?, updatedAt=CURRENT_TIMESTAMP WHERE category=?',
        ['', category.name]
      );
    }
    // 删除分类
    await dbAsync.run('DELETE FROM categories_details WHERE id=?', [id]);
    return true;
  }
};

// ==================== storyboard 独立数据库（视频片段管理） ====================

const storyboardDbPath = path.join(__dirname, 'storyboard.db');
const storyboardDb = new sqlite3.Database(storyboardDbPath, (err) => {
  if (err) {
    console.error('[app] 打开数据库失败:', err.message);
  } else {
    console.log('[app] 已连接 SQLite 数据库');
    initStoryboardDatabase();
  }
});

// storyboard 数据库就绪标志（所有 DDL 完成后才为 true）
let storyboardDbReady = false;
const storyboardDbWaiters = [];

function onStoryboardDbReady(cb) {
  if (storyboardDbReady) { cb && cb(); return; }
  if (cb) storyboardDbWaiters.push(cb);
}
function setStoryboardDbReady() {
  if (storyboardDbReady) return;
  storyboardDbReady = true;
  const list = storyboardDbWaiters.splice(0, storyboardDbWaiters.length);
  list.forEach(function(cb) { try { cb(); } catch (e) {} });
  console.log('[app] 表结构已就绪');
}

function initStoryboardDatabase() {
  storyboardDb.serialize(() => {
    // P3-5：ignoredMsg 提前到 serialize 顶部，避免 TDZ 风险
    const ignoredMsg = 'duplicate column name';

    // 1. 创建 videos 表（完整新结构，包括所有新列：type/coverUrl/isCover/reference）
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        size INTEGER,
        duration REAL,
        sortOrder INTEGER DEFAULT 0,
        deleted INTEGER DEFAULT 0,
        deletedAt DATETIME,
        projectId INTEGER,
        sceneId INTEGER,
        type TEXT DEFAULT 'video',
        coverUrl TEXT,
        isCover INTEGER DEFAULT 0,
        reference INTEGER DEFAULT 0,
        shotNo TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 迁移：已存在表增加 shotNo 列（忽略错误）
    storyboardDb.run(`ALTER TABLE videos ADD COLUMN shotNo TEXT`, (err) => {
      // 如果列已存在或表不存在，忽略错误
    });

    // ========== 分镜升级：新增 videos 表专业字段 ==========
    const shotColumns = [
      'sceneContent TEXT DEFAULT \'\'',
      'actors TEXT DEFAULT \'\'',
      'props TEXT DEFAULT \'\'',
      'costume TEXT DEFAULT \'\'',
      'location TEXT DEFAULT \'\'',
      'focalLength TEXT DEFAULT \'\'',
      'narration TEXT DEFAULT \'\'',
      'cameraMovement TEXT DEFAULT \'\'',
      'shotType TEXT DEFAULT \'\'',
      'shotAngle TEXT DEFAULT \'\'',
      'lighting TEXT DEFAULT \'\'',
      'notes TEXT DEFAULT \'\'',
      'estimatedDuration TEXT DEFAULT \'\'',
      'aiImagePrompt TEXT DEFAULT \'\'',
      'aiStylePrompt TEXT DEFAULT \'\'',
      'mergedFrom TEXT DEFAULT \'\''
    ];
    shotColumns.forEach(function(colDef) {
      storyboardDb.run(`ALTER TABLE videos ADD COLUMN ${colDef}`, function(err) {
        if (err && String(err.message).indexOf(ignoredMsg) === -1) {
          console.error('[app] 新增分镜字段失败:', colDef, err.message);
        }
      });
    });

    // ========== shot_media 表（分镜参考画面） ==========
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS shot_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shotId INTEGER NOT NULL,
        url TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'image',
        filename TEXT DEFAULT '',
        size INTEGER DEFAULT 0,
        duration REAL,
        sortOrder INTEGER DEFAULT 0,
        source TEXT DEFAULT 'upload',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (shotId) REFERENCES videos(id) ON DELETE CASCADE
      )
    `);
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_shot_media_shot ON shot_media(shotId)');

    storyboardDb.run('ALTER TABLE shot_media ADD COLUMN startTime REAL DEFAULT 0', (err) => {
      if (err && !err.message.includes('duplicate column name')) {
        console.warn('[db] shot_media.startTime 列添加失败:', err.message);
      }
    });

    // ========== ai_generated_images 表（P3-22：AI 生图历史持久化） ==========
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS ai_generated_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ownerType TEXT NOT NULL,
        ownerId INTEGER NOT NULL,
        url TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        model TEXT DEFAULT '',
        provider TEXT DEFAULT '',
        size TEXT DEFAULT '',
        fileSize INTEGER DEFAULT 0,
        sortOrder INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_ai_gen_owner ON ai_generated_images(ownerType, ownerId)');

    // ========== settings 表（系统设置） ==========
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ========== ai_tasks 表（AI 异步任务） ==========
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS ai_tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        projectId INTEGER,
        input TEXT,
        output TEXT,
        error TEXT,
        progress INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ========== ai_usage_logs 表（AI 费用统计） ==========
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS ai_usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId TEXT,
        type TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        promptTokens INTEGER DEFAULT 0,
        completionTokens INTEGER DEFAULT 0,
        totalTokens INTEGER DEFAULT 0,
        imageCount INTEGER DEFAULT 0,
        estimatedCost REAL DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_usage_created ON ai_usage_logs(createdAt)');

    // ========== transcode_tasks 表（转码任务持久化） ==========
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS transcode_tasks (
        id TEXT PRIMARY KEY,
        jobId TEXT,
        requestId TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        progress INTEGER DEFAULT 0,
        videoUrl TEXT,
        outputUrl TEXT,
        outputObject TEXT,
        error TEXT,
        projectId INTEGER,
        options TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_transcode_status ON transcode_tasks(status)');
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_transcode_project ON transcode_tasks(projectId)');
    // 心跳字段：前端最后一次查询状态的时间，用于检测孤儿任务（用户已离开）
    storyboardDb.run('ALTER TABLE transcode_tasks ADD COLUMN lastQueriedAt DATETIME', function(err) {
      if (err && String(err.message).indexOf('duplicate column name') === -1) {
        console.error('[app] ALTER TABLE transcode_tasks.lastQueriedAt 失败:', err.message);
      }
    });

    // ========== digital_assets 表（数字资产：演员/道具/场景） ==========
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS digital_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projectId INTEGER NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        imagePrompt TEXT DEFAULT '',
        imageUrl TEXT DEFAULT '',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_digital_assets_project ON digital_assets(projectId)');
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_digital_assets_type ON digital_assets(type)');

    // ========== digital_asset_images 表（数字资产图片） ==========
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS digital_asset_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assetId INTEGER NOT NULL,
        imageUrl TEXT NOT NULL,
        size INTEGER DEFAULT 0,
        sortOrder INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (assetId) REFERENCES digital_assets(id) ON DELETE CASCADE
      )
    `);
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_digital_asset_images_asset ON digital_asset_images(assetId)');
    // 旧表迁移：补 size 列（数字资产大小统计）
    storyboardDb.run('ALTER TABLE digital_asset_images ADD COLUMN size INTEGER DEFAULT 0', function(err) {
      if (err && String(err.message).indexOf('duplicate column name') === -1) {
        console.error('[app] ALTER TABLE digital_asset_images.size 失败:', err.message);
      }
    });

    // 迁移旧数据：将 digital_assets.imageUrl 迁移到 digital_asset_images
    storyboardDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='digital_asset_images'", [], function(err, row) {
      if (row) {
        storyboardDb.run(`
          INSERT OR IGNORE INTO digital_asset_images (assetId, imageUrl, sortOrder)
          SELECT id, imageUrl, 0 FROM digital_assets
          WHERE imageUrl IS NOT NULL AND imageUrl != ''
          AND NOT EXISTS (SELECT 1 FROM digital_asset_images WHERE assetId = digital_assets.id)
        `);
      }
    });

    // 2. 创建 projects 表
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        coverUrl TEXT,
        sortOrder INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. 创建 scenes 表
    storyboardDb.run(`
      CREATE TABLE IF NOT EXISTS scenes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projectId INTEGER NOT NULL,
        name TEXT NOT NULL,
        sortOrder INTEGER DEFAULT 0,
        scrollPosition INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    // 4. 安全添加列（列已存在时报 duplicate column name，忽略即可，依然在 serialize 上下文中串行）
    //    对旧数据库升级：逐列补齐
    // P3-5：ignoredMsg 已在 serialize 顶部声明，此处无需重复
    const addColSqlList = [
      'ALTER TABLE videos ADD COLUMN sortOrder INTEGER DEFAULT 0',
      'ALTER TABLE videos ADD COLUMN deleted INTEGER DEFAULT 0',
      'ALTER TABLE videos ADD COLUMN deletedAt DATETIME',
      'ALTER TABLE videos ADD COLUMN projectId INTEGER',
      'ALTER TABLE videos ADD COLUMN sceneId INTEGER',
      'ALTER TABLE videos ADD COLUMN type TEXT DEFAULT \'video\'',
      'ALTER TABLE videos ADD COLUMN coverUrl TEXT',
      'ALTER TABLE videos ADD COLUMN isCover INTEGER DEFAULT 0',
      'ALTER TABLE videos ADD COLUMN reference INTEGER DEFAULT 0'
    ];
    addColSqlList.forEach(function(sql) {
      storyboardDb.run(sql, function(err) {
        if (err && String(err.message).indexOf(ignoredMsg) === -1) {
          console.error('[app] ALTER TABLE 失败:', err.message);
        }
      });
    });

    // 5. 创建索引
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status)');
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_videos_sort ON videos(sortOrder)');
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_videos_deleted ON videos(deleted)');
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_videos_project ON videos(projectId)');
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_videos_scene ON videos(sceneId)');
    storyboardDb.run('CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(projectId)');

    // 6. 初始化系统设置（首次启动插入默认值，已存在则跳过）
    storyboardDb.get('SELECT 1 as ok', function(_err, _row) {
      initDefaultSettings(function() {
        setStoryboardDbReady();
      });
    });
  });
}

// ========== 初始化默认设置 ==========
function initDefaultSettings(callback) {
  const defaults = {
    llm_provider: 'geekai',
    llm_model: 'deepseek-chat',
    llm_fallback_chain: JSON.stringify([
      { model: 'deepseek-chat', provider: 'geekai', cost: 'low' },
      { model: 'deepseek-chat', provider: 'siliconflow', cost: 'low' },
      { model: 'gpt-4o-mini', provider: 'geekai', cost: 'low' },
      { model: 'glm-4-flash', provider: 'geekai', cost: 'free' }
    ]),
    image_provider: 'geekai',
    image_model: 'gpt-image-2',
    image_quality: 'medium',
    image_fallback_chain: JSON.stringify([
      { model: 'gpt-image-2', quality: 'medium', provider: 'geekai', cost: 'mid_high', supportsImageRef: true },
      { model: 'z-image-turbo', quality: 'standard', provider: 'geekai', cost: 'low', supportsImageRef: false },
      { model: 'nano-banana-2', quality: 'standard', provider: 'geekai', cost: 'mid', supportsImageRef: true },
      { model: 'cogview-4', quality: 'standard', provider: 'geekai', cost: 'mid', supportsImageRef: false }
    ]),
    default_image_size: '1024x576',
    export_include_images: 'true',
    export_format: 'docx',
    video_target_bitrate_1080p: '3000',
    video_target_bitrate_720p: '2000',
    video_target_bitrate_480p: '1000',
    image_compress_threshold_kb: '300',
    model_prices: JSON.stringify({
      'deepseek-chat': { input: 0.001, output: 0.002 },
      'gpt-4o-mini': { input: 0.01, output: 0.03 },
      'glm-4-flash': { input: 0, output: 0 },
      'gpt-image-2': { per_image_medium: 0.08 },
      'z-image-turbo': { per_image_standard: 0.02 },
      'nano-banana-2': { per_image_standard: 0.05 },
      'cogview-4': { per_image_standard: 0.05 }
    })
  };

  let remaining = Object.keys(defaults).length;
  let inserted = 0;

  Object.keys(defaults).forEach(function(key) {
    storyboardDb.get('SELECT key FROM settings WHERE key = ?', [key], function(err, row) {
      if (!row) {
        storyboardDb.run(
          'INSERT INTO settings (key, value) VALUES (?, ?)',
          [key, defaults[key]],
          function(err2) {
            if (!err2) inserted++;
            remaining--;
            if (remaining === 0) {
              console.log('[app] 已初始化 settings: ' + inserted + ' 条');
              callback && callback();
            }
          }
        );
      } else {
        remaining--;
        if (remaining === 0) {
          console.log('[app] settings 已存在，跳过初始化');
          callback && callback();
        }
      }
    });
  });
}

const storyboardAsync = {
  get: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      onStoryboardDbReady(() => {
        storyboardDb.get(sql, params, (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
    });
  },
  all: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      onStoryboardDbReady(() => {
        storyboardDb.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    });
  },
  run: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      onStoryboardDbReady(() => {
        storyboardDb.run(sql, params, function(err) {
          if (err) reject(err);
          else resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    });
  },
  // P4-2：事务辅助方法（storyboardDb 连接），包裹多步写操作保证原子性
  // 用法：await storyboardAsync.transaction(async (tx) => { await tx.run(...); });
  transaction: async (fn) => {
    await storyboardAsync.run('BEGIN');
    try {
      const result = await fn(storyboardAsync);
      await storyboardAsync.run('COMMIT');
      return result;
    } catch (e) {
      await storyboardAsync.run('ROLLBACK').catch(() => {});
      throw e;
    }
  }
};

// ── projects ──────────────────────────────────────────────
const projects = {
  getAll: async () => {
    const projects = await storyboardAsync.all(
      'SELECT * FROM projects ORDER BY sortOrder ASC, id ASC'
    );
    if (projects.length === 0) return [];

    // 统计分镜数量
    const shotCountRows = await storyboardAsync.all(
      `SELECT projectId, COUNT(*) as cnt
       FROM videos WHERE deleted = 0 AND reference = 0
       GROUP BY projectId`
    );
    const shotCountMap = new Map();
    shotCountRows.forEach(r => shotCountMap.set(r.projectId, r.cnt));

    // 统计存储占用（按 DISTINCT url 去重，避免同一文件被多次引用时重复计算）
    // 1. videos 表（分镜 + 参考文件，按 url 去重）
    const videoSizeRows = await storyboardAsync.all(
      `SELECT projectId, SUM(s) as totalSize FROM (
        SELECT projectId, MAX(size) as s FROM videos
        WHERE deleted = 0 AND url IS NOT NULL AND url != ''
        GROUP BY projectId, url
      ) GROUP BY projectId`
    );
    const videoSizeMap = new Map();
    videoSizeRows.forEach(r => videoSizeMap.set(r.projectId, r.totalSize || 0));

    // 2. shot_media（按 url 去重，排除已在 videos 中统计的 url）
    const shotMediaSizeRows = await storyboardAsync.all(
      `SELECT projectId, SUM(s) as totalSize FROM (
        SELECT v.projectId, m.url, MAX(m.size) as s
        FROM shot_media m JOIN videos v ON m.shotId = v.id
        WHERE v.deleted = 0 AND m.url IS NOT NULL AND m.url != ''
          AND m.url NOT IN (SELECT url FROM videos WHERE projectId = v.projectId AND deleted = 0 AND url IS NOT NULL AND url != '')
        GROUP BY v.projectId, m.url
      ) GROUP BY projectId`
    );
    const shotMediaSizeMap = new Map();
    shotMediaSizeRows.forEach(r => shotMediaSizeMap.set(r.projectId, r.totalSize || 0));

    // 3. 数字资产图（按 url 去重）
    const assetImgSizeRows = await storyboardAsync.all(
      `SELECT projectId, SUM(s) as totalSize FROM (
        SELECT da.projectId, dai.imageUrl as url, MAX(dai.size) as s
        FROM digital_asset_images dai JOIN digital_assets da ON dai.assetId = da.id
        WHERE dai.imageUrl IS NOT NULL AND dai.imageUrl != ''
        GROUP BY da.projectId, dai.imageUrl
      ) GROUP BY projectId`
    );
    const assetImgSizeMap = new Map();
    assetImgSizeRows.forEach(r => assetImgSizeMap.set(r.projectId, r.totalSize || 0));

    // 4. AI 生图历史（按 url 去重，排除已在上述来源中统计的）
    const aiHistSizeRows = await storyboardAsync.all(
      `SELECT projectId, SUM(s) as totalSize FROM (
        SELECT v.projectId, a.url, MAX(a.fileSize) as s
        FROM ai_generated_images a JOIN videos v ON a.ownerId = v.id
        WHERE a.ownerType = 'shot' AND v.deleted = 0 AND a.url IS NOT NULL AND a.url != ''
        GROUP BY v.projectId, a.url
        UNION ALL
        SELECT da.projectId, a.url, MAX(a.fileSize) as s
        FROM ai_generated_images a JOIN digital_assets da ON a.ownerId = da.id
        WHERE a.ownerType = 'asset' AND a.url IS NOT NULL AND a.url != ''
        GROUP BY da.projectId, a.url
      ) GROUP BY projectId`
    );
    const aiHistSizeMap = new Map();
    aiHistSizeRows.forEach(r => aiHistSizeMap.set(r.projectId, r.totalSize || 0));

    // 合并到 projects
    const result = projects.map(p => {
      return {
        ...p,
        shotCount: shotCountMap.get(p.id) || 0,
        totalSize: (videoSizeMap.get(p.id) || 0)
                  + (shotMediaSizeMap.get(p.id) || 0)
                  + (assetImgSizeMap.get(p.id) || 0)
                  + (aiHistSizeMap.get(p.id) || 0)
      };
    });
    return result;
  },
  getById: async (id) => {
    return await storyboardAsync.get('SELECT * FROM projects WHERE id = ?', [id]);
  },
  create: async ({ name, description, coverUrl }) => {
    const maxRow = await storyboardAsync.get('SELECT MAX(sortOrder) as maxSort FROM projects');
    const nextSort = ((maxRow && maxRow.maxSort != null) ? maxRow.maxSort : -1) + 1;
    const DEFAULT_COVER = 'data:image/svg+xml;utf8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 225"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#ec4899"/></linearGradient></defs><rect width="400" height="225" fill="url(#g)"/></svg>');
    const finalCoverUrl = coverUrl || DEFAULT_COVER;
    const result = await storyboardAsync.run(
      'INSERT INTO projects (name, description, sortOrder, coverUrl) VALUES (?, ?, ?, ?)',
      [name, description || '', nextSort, finalCoverUrl]
    );
    return { id: result.lastID, name, description: description || '', sortOrder: nextSort, coverUrl: finalCoverUrl };
  },
  update: async (id, { name, description, coverUrl }) => {
    const fields = [];
    const vals = [];
    if (name !== undefined) { fields.push('name=?'); vals.push(name); }
    if (description !== undefined) { fields.push('description=?'); vals.push(description); }
    if (coverUrl !== undefined) { fields.push('coverUrl=?'); vals.push(coverUrl); }
    if (fields.length === 0) return;
    fields.push('updatedAt=CURRENT_TIMESTAMP');
    vals.push(id);
    await storyboardAsync.run('UPDATE projects SET ' + fields.join(', ') + ' WHERE id = ?', vals);
    return true;
  },
  updateSort: async (orders) => {
    for (const item of orders) {
      await storyboardAsync.run(
        'UPDATE projects SET sortOrder = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
        [item.sortOrder, item.id]
      );
    }
    return true;
  },
  delete: async (id) => {
    // 获取该项目下所有视频 url（用于调用方清理 OSS）
    const videos = await storyboardAsync.all(
      'SELECT url FROM videos WHERE projectId = ?',
      [id]
    );
    await storyboardAsync.run('DELETE FROM scenes WHERE projectId = ?', [id]);
    await storyboardAsync.run('DELETE FROM projects WHERE id = ?', [id]);
    return videos; // 返回视频 URL 列表，由调用方清理 OSS
  }
};

// ── scenes ──────────────────────────────────────────────
const scenes = {
  getByProjectId: async (projectId) => {
    const scenes = await storyboardAsync.all(
      'SELECT * FROM scenes WHERE projectId = ? ORDER BY sortOrder ASC, id ASC',
      [projectId]
    );
    if (scenes.length === 0) return [];

    // 一次 GROUP BY 聚合替代 N+1
    const statsRows = await storyboardAsync.all(
      `SELECT sceneId, COUNT(*) as cnt
       FROM videos WHERE sceneId IS NOT NULL AND deleted = 0 AND reference = 0
       GROUP BY sceneId`
    );
    const statsMap = new Map();
    statsRows.forEach(r => statsMap.set(r.sceneId, r.cnt));

    return scenes.map(s => ({
      ...s,
      shotCount: statsMap.get(s.id) || 0
    }));
  },
  create: async ({ projectId, name }) => {
    const maxRow = await storyboardAsync.get(
      'SELECT MAX(sortOrder) as maxSort FROM scenes WHERE projectId = ?',
      [projectId]
    );
    const nextSort = ((maxRow && maxRow.maxSort != null) ? maxRow.maxSort : -1) + 1;
    const result = await storyboardAsync.run(
      'INSERT INTO scenes (projectId, name, sortOrder) VALUES (?, ?, ?)',
      [projectId, name, nextSort]
    );
    return { id: result.lastID, projectId, name, sortOrder: nextSort, shotCount: 0 };
  },
  update: async (id, { name, scrollPosition }) => {
    const fields = [];
    const vals = [];
    if (name !== undefined) { fields.push('name=?'); vals.push(name); }
    if (scrollPosition !== undefined) { fields.push('scrollPosition=?'); vals.push(scrollPosition); }
    if (fields.length === 0) return;
    fields.push('updatedAt=CURRENT_TIMESTAMP');
    vals.push(id);
    await storyboardAsync.run('UPDATE scenes SET ' + fields.join(', ') + ' WHERE id = ?', vals);
    return true;
  },
  updateSort: async (orders) => {
    for (const item of orders) {
      await storyboardAsync.run(
        'UPDATE scenes SET sortOrder = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
        [item.sortOrder, item.id]
      );
    }
    return true;
  },
  delete: async (id) => {
    // 该场次下视频归到未分类
    await storyboardAsync.run('UPDATE videos SET sceneId = NULL WHERE sceneId = ?', [id]);
    await storyboardAsync.run('DELETE FROM scenes WHERE id = ?', [id]);
    return true;
  }
};

// ── items（扩展）────────────────────────────────────────
function formatShot(shot) {
  if (!shot) return shot;
  if (shot.mergedFrom && typeof shot.mergedFrom === 'string') {
    try {
      shot.mergedFrom = JSON.parse(shot.mergedFrom);
    } catch (e) {
      shot.mergedFrom = [];
    }
  } else if (!shot.mergedFrom) {
    shot.mergedFrom = [];
  }
  if (shot.reference !== undefined) {
    shot.reference = shot.reference === 1 || shot.reference === true;
  }
  return shot;
}

const items = {
  getAll: async () => {
    const rows = await storyboardAsync.all(
      'SELECT * FROM videos WHERE deleted = 0 ORDER BY sortOrder ASC, id ASC'
    );
    return rows.map(formatShot);
  },
  getByFilter: async ({ projectId, sceneId, status, deleted, type, reference }) => {
    let sql = 'SELECT * FROM videos WHERE 1=1';
    const params = [];
    if (projectId !== undefined) { sql += ' AND projectId = ?'; params.push(projectId); }
    if (sceneId !== undefined) { sql += sceneId === null ? ' AND sceneId IS NULL' : ' AND sceneId = ?'; if (sceneId !== null) params.push(sceneId); }
    if (status !== undefined) { sql += ' AND status = ?'; params.push(status); }
    if (deleted !== undefined) { sql += ' AND deleted = ?'; params.push(deleted); }
    if (type !== undefined) { sql += ' AND type = ?'; params.push(type); }
    if (reference !== undefined) { sql += ' AND reference = ?'; params.push(reference); }
    sql += ' ORDER BY sortOrder ASC, id ASC';
    const rows = await storyboardAsync.all(sql, params);
    return rows.map(formatShot);
  },
  getByStatus: async (status) => {
    const rows = await storyboardAsync.all(
      'SELECT * FROM videos WHERE status = ? AND deleted = 0 ORDER BY sortOrder ASC, id ASC',
      [status]
    );
    return rows.map(formatShot);
  },
  getStats: async ({ projectId, sceneId, reference } = {}) => {
    let whereClause = 'WHERE deleted = 0';
    const params = [];
    if (projectId !== undefined) { whereClause += ' AND projectId = ?'; params.push(projectId); }
    if (sceneId !== undefined) {
      if (sceneId === null) {
        whereClause += ' AND sceneId IS NULL';
      } else {
        whereClause += ' AND sceneId = ?';
        params.push(sceneId);
      }
    }
    if (reference !== undefined) { whereClause += ' AND reference = ?'; params.push(reference); }
    const all = await storyboardAsync.all(
      'SELECT status, COUNT(*) as cnt FROM videos ' + whereClause + ' GROUP BY status',
      params
    );
    const map = { pending: 0, done: 0, total: 0, trash: 0, unclassified: 0 };
    all.forEach(r => {
      map[r.status] = r.cnt;
      map.total += r.cnt;
    });
    let trashWhere = ' WHERE deleted = 1';
    const trashParams = [];
    if (projectId !== undefined) { trashWhere += ' AND projectId = ?'; trashParams.push(projectId); }
    if (reference !== undefined) { trashWhere += ' AND reference = ?'; trashParams.push(reference); }
    const trash = await storyboardAsync.get(
      'SELECT COUNT(*) as cnt FROM videos' + trashWhere,
      trashParams
    );
    map.trash = trash ? trash.cnt : 0;
    let unclassifiedWhere = 'WHERE deleted = 0 AND sceneId IS NULL';
    const unclassifiedParams = [];
    if (projectId !== undefined) { unclassifiedWhere += ' AND projectId = ?'; unclassifiedParams.push(projectId); }
    if (reference !== undefined) { unclassifiedWhere += ' AND reference = ?'; unclassifiedParams.push(reference); }
    const unclassified = await storyboardAsync.get(
      'SELECT COUNT(*) as cnt FROM videos ' + unclassifiedWhere,
      unclassifiedParams
    );
    map.unclassified = unclassified ? unclassified.cnt : 0;
    return map;
  },
  getSceneStats: async (projectId) => {
    const rows = await storyboardAsync.all(
      `SELECT v.sceneId, s.name as sceneName, v.status, COUNT(*) as cnt
       FROM videos v
       LEFT JOIN scenes s ON v.sceneId = s.id
       WHERE v.projectId = ? AND v.deleted = 0 AND v.status != 'trash' AND v.reference = 0
       GROUP BY v.sceneId, v.status
       ORDER BY s.sortOrder IS NULL, s.sortOrder ASC, v.sceneId IS NULL, v.sceneId ASC`,
      [projectId]
    );
    const sceneMap = {};
    rows.forEach(r => {
      const key = r.sceneId ?? 'null';
      if (!sceneMap[key]) {
        sceneMap[key] = {
          id: r.sceneId,
          name: r.sceneName || '未分类',
          pending: 0,
          done: 0,
          total: 0
        };
      }
      if (r.status === 'done') {
        sceneMap[key].done = r.cnt;
      } else {
        sceneMap[key].pending += r.cnt;
      }
      sceneMap[key].total += r.cnt;
    });
    return Object.values(sceneMap);
  },
  exportProject: async (projectId) => {
    const project = await storyboardAsync.get('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!project) return null;
    const scenes = await storyboardAsync.all(
      'SELECT id, name, sortOrder, createdAt, updatedAt FROM scenes WHERE projectId = ? ORDER BY sortOrder IS NULL, sortOrder ASC, id ASC',
      [projectId]
    );
    const shots = await storyboardAsync.all(
      `SELECT id, title, filename, url, status, size, duration, sortOrder, projectId, sceneId, type, coverUrl, reference,
              narration, sceneContent, actors, location, shotNo, shotType, cameraMovement, shotAngle, durationSeconds,
              props, costume, notes, deleted, deletedAt, createdAt, updatedAt, mergedFrom, aiImageTaskId, aiImagePrompt,
              focalLength, lighting, estimatedDuration, aiStylePrompt
       FROM videos WHERE projectId = ? AND deleted = 0
       ORDER BY sortOrder IS NULL, sortOrder ASC, id ASC`,
      [projectId]
    );
    const shotIds = shots.map(s => s.id);
    let media = [];
    if (shotIds.length > 0) {
      const placeholders = shotIds.map(() => '?').join(',');
      media = await storyboardAsync.all(
        `SELECT id, shotId, url, type, filename, size, duration, sortOrder, source, createdAt
         FROM shot_media WHERE shotId IN (${placeholders})
         ORDER BY shotId ASC, sortOrder ASC, id ASC`,
        shotIds
      );
    }
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      project: {
        name: project.name,
        description: project.description,
        coverUrl: project.coverUrl,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      },
      scenes,
      shots,
      media
    };
  },
  importProject: async (projectData, targetProjectId = null, mode = 'merge') => {
    const { project, scenes, shots, media } = projectData;
    let newProjectId = targetProjectId;

    if (!targetProjectId) {
      const result = await storyboardAsync.run(
        'INSERT INTO projects (name, description, coverUrl, sortOrder) VALUES (?, ?, ?, ?)',
        [
          project?.name || '导入的项目',
          project?.description || '',
          project?.coverUrl || null,
          null
        ]
      );
      newProjectId = result.lastID;
    } else {
      const existing = await storyboardAsync.get('SELECT * FROM projects WHERE id = ?', [targetProjectId]);
      if (!existing) throw new Error('目标项目不存在');
    }

    const sceneIdMap = {};
    if (scenes && scenes.length > 0) {
      for (const s of scenes) {
        const result = await storyboardAsync.run(
          'INSERT INTO scenes (name, sortOrder, projectId) VALUES (?, ?, ?)',
          [s.name, s.sortOrder ?? null, newProjectId]
        );
        sceneIdMap[s.id] = result.lastID;
      }
    }

    const shotIdMap = {};
    if (shots && shots.length > 0) {
      for (const sh of shots) {
        const newSceneId = sh.sceneId != null ? (sceneIdMap[sh.sceneId] ?? null) : null;
        const result = await storyboardAsync.run(
          `INSERT INTO videos (title, filename, url, status, size, duration, sortOrder, projectId, sceneId, type, coverUrl, reference,
            narration, sceneContent, actors, location, shotNo, shotType, cameraMovement, shotAngle, durationSeconds,
            props, costume, notes, mergedFrom, aiImageTaskId, aiImagePrompt, focalLength, lighting, estimatedDuration,
            aiStylePrompt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sh.title, sh.filename, sh.url, sh.status || 'pending', sh.size || 0, sh.duration || 0,
            sh.sortOrder ?? null, newProjectId, newSceneId, sh.type || 'video',
            sh.coverUrl || null, sh.reference || 0,
            sh.narration || null, sh.sceneContent || null, sh.actors || null, sh.location || null,
            sh.shotNo || null, sh.shotType || null, sh.cameraMovement || null, sh.shotAngle || null,
            sh.durationSeconds || null, sh.props || null, sh.costume || null, sh.notes || null,
            sh.mergedFrom || null, sh.aiImageTaskId || null, sh.aiImagePrompt || null,
            sh.focalLength || null, sh.lighting || null, sh.estimatedDuration || null,
            sh.aiStylePrompt || null
          ]
        );
        shotIdMap[sh.id] = result.lastID;
      }
    }

    if (media && media.length > 0) {
      for (const m of media) {
        const newShotId = shotIdMap[m.shotId];
        if (!newShotId) continue;
        await storyboardAsync.run(
          'INSERT INTO shot_media (shotId, url, type, filename, size, duration, sortOrder, source, startTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            newShotId, m.url, m.type || 'image', m.filename || '',
            m.size || 0, m.duration || null, m.sortOrder ?? 0, m.source || 'upload',
            m.startTime !== undefined ? m.startTime : 0
          ]
        );
      }
    }

    return { projectId: newProjectId, sceneIdMap, shotIdMap };
  },
  getById: async (id) => {
    const row = await storyboardAsync.get('SELECT * FROM videos WHERE id = ?', [id]);
    return formatShot(row);
  },
  create: async (item) => {
    const maxRow = await storyboardAsync.get(
      'SELECT MAX(sortOrder) as maxSort FROM videos WHERE deleted = 0 AND (reference IS NULL OR reference = 0)'
    );
    const nextSort = ((maxRow && maxRow.maxSort != null) ? maxRow.maxSort : -1) + 1;
    const result = await storyboardAsync.run(
      'INSERT INTO videos (title, filename, url, status, size, duration, sortOrder, projectId, sceneId, type, coverUrl, reference) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        item.title,
        item.filename,
        item.url,
        item.status || 'pending',
        item.size || null,
        item.duration || null,
        item.sortOrder !== undefined ? item.sortOrder : nextSort,
        item.projectId !== undefined ? item.projectId : null,
        item.sceneId !== undefined ? item.sceneId : null,
        item.type || 'video',
        item.coverUrl || null,
        item.reference || 0
      ]
    );
    return formatShot({ id: result.lastID, sortOrder: nextSort, ...item });
  },
  updateStatus: async (id, status) => {
    const result = await storyboardAsync.run(
      'UPDATE videos SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id]
    );
    return result.changes > 0;
  },
  updateShotNo: async (id, shotNo) => {
    const result = await storyboardAsync.run(
      'UPDATE videos SET shotNo = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [shotNo || null, id]
    );
    return result.changes > 0;
  },
  updateTitle: async (id, title) => {
    const result = await storyboardAsync.run(
      'UPDATE videos SET title = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [title, id]
    );
    return result.changes > 0;
  },
  updateSort: async (orders) => {
    for (const item of orders) {
      await storyboardAsync.run(
        'UPDATE videos SET sortOrder = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
        [item.sortOrder, item.id]
      );
    }
    return true;
  },
  // 软删除（移入垃圾桶）
  softDelete: async (id) => {
    const result = await storyboardAsync.run(
      'UPDATE videos SET deleted = 1, deletedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [id]
    );
    return result.changes > 0;
  },
  // 从垃圾桶恢复
  restore: async (id) => {
    const result = await storyboardAsync.run(
      'UPDATE videos SET deleted = 0, deletedAt = NULL, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [id]
    );
    return result.changes > 0;
  },
  // 彻底删除（DB 记录，由调用方清理 OSS）
  hardDelete: async (id) => {
    const result = await storyboardAsync.run('DELETE FROM videos WHERE id = ?', [id]);
    return result.changes > 0;
  },
  // 批量软删除
  batchSoftDelete: async (ids) => {
    const placeholders = ids.map(() => '?').join(',');
    const result = await storyboardAsync.run(
      `UPDATE videos SET deleted = 1, deletedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      ids
    );
    return result.changes;
  },
  // 批量恢复
  batchRestore: async (ids) => {
    const placeholders = ids.map(() => '?').join(',');
    const result = await storyboardAsync.run(
      `UPDATE videos SET deleted = 0, deletedAt = NULL, updatedAt = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      ids
    );
    return result.changes;
  },
  // 批量更新状态
  batchUpdateStatus: async (ids, status) => {
    const placeholders = ids.map(() => '?').join(',');
    const result = await storyboardAsync.run(
      `UPDATE videos SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      [status, ...ids]
    );
    return result.changes;
  },
  // 批量彻底删除（返回被删视频的 URL 列表）
  batchHardDelete: async (ids) => {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await storyboardAsync.all(
      `SELECT url FROM videos WHERE id IN (${placeholders})`,
      ids
    );
    await storyboardAsync.run(
      `DELETE FROM videos WHERE id IN (${placeholders})`,
      ids
    );
    return rows.map(r => r.url);
  },
  // 批量移动到场次
  batchChangeScene: async (ids, sceneId) => {
    const placeholders = ids.map(() => '?').join(',');
    const result = await storyboardAsync.run(
      `UPDATE videos SET sceneId = ?, updatedAt = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      [sceneId, ...ids]
    );
    return result.changes;
  },
  // 兼容旧 API（硬删除，保留给 server.js 旧 DELETE 路由的兼容实现）
  delete: async (id) => {
    const result = await storyboardAsync.run('DELETE FROM videos WHERE id = ?', [id]);
    return result.changes > 0;
  },
  // 原子设置封面：先清除同项目的旧 isCover=1，再设置当前记录
  setCover: async (projectId, videoId) => {
    await storyboardAsync.run('UPDATE videos SET isCover = 0, updatedAt = CURRENT_TIMESTAMP WHERE projectId = ? AND isCover = 1', [projectId]);
    const r = await storyboardAsync.run('UPDATE videos SET isCover = 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [videoId]);
    return r.changes > 0;
  },
  // P4-2 补充：原子设置封面，同时更新 videos.isCover 和 projects.coverUrl（事务包裹）
  // 用法：await setCoverWithProject(projectId, videoId, coverUrl)
  setCoverWithProject: async (projectId, videoId, coverUrl) => {
    return await storyboardAsync.transaction(async (tx) => {
      await tx.run('UPDATE videos SET isCover = 0, updatedAt = CURRENT_TIMESTAMP WHERE projectId = ? AND isCover = 1', [projectId]);
      const r = await tx.run('UPDATE videos SET isCover = 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [videoId]);
      if (r.changes > 0) {
        await tx.run('UPDATE projects SET coverUrl = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [coverUrl, projectId]);
      }
      return r.changes > 0;
    });
  },
  // 取消某条视频的封面标记
  unsetCover: async (videoId) => {
    const r = await storyboardAsync.run('UPDATE videos SET isCover = 0, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [videoId]);
    return r.changes > 0;
  },

  // 分镜升级：更新分镜字段（支持批量字段更新）
  updateShotFields: async (id, fields) => {
    const allowedFields = [
      'sceneContent', 'actors', 'props', 'costume', 'location', 'focalLength',
      'narration', 'cameraMovement', 'shotType', 'shotAngle', 'lighting',
      'notes', 'estimatedDuration', 'aiImagePrompt', 'aiStylePrompt',
      'shotNo', 'status'
    ];
    const sets = [];
    const vals = [];
    allowedFields.forEach(function(f) {
      if (fields[f] !== undefined) {
        sets.push(f + ' = ?');
        vals.push(fields[f]);
      }
    });
    if (sets.length === 0) return false;
    sets.push('updatedAt = CURRENT_TIMESTAMP');
    vals.push(id);
    const r = await storyboardAsync.run('UPDATE videos SET ' + sets.join(', ') + ' WHERE id = ?', vals);
    return r.changes > 0;
  },

  // 压缩/转码完成后更新媒体 URL 和 size（用于阿里云 MPS 流程）
  updateMediaUrlAndSize: async (oldUrl, newUrl, newSize) => {
    const r1 = await storyboardAsync.run(
      'UPDATE videos SET url = ?, size = ?, updatedAt = CURRENT_TIMESTAMP WHERE url = ?',
      [newUrl, newSize, oldUrl]
    );
    const r2 = await storyboardAsync.run(
      'UPDATE shot_media SET url = ?, size = ? WHERE url = ?',
      [newUrl, newSize, oldUrl]
    );
    return { videosUpdated: r1.changes, mediaUpdated: r2.changes };
  },

  // 分镜升级：创建空白分镜（无参考画面）
  createShot: async (item) => {
    // P4-2：用事务包裹 MAX+1 与 INSERT，防御并发请求分配到相同 sortOrder
    const { newId, nextSort } = await storyboardAsync.transaction(async (tx) => {
      const maxRow = await tx.get(
        'SELECT MAX(sortOrder) as maxSort FROM videos WHERE deleted = 0 AND projectId = ?' + (item.sceneId !== undefined ? ' AND sceneId ' + (item.sceneId === null ? 'IS NULL' : '= ?') : ''),
        item.sceneId !== undefined && item.sceneId !== null ? [item.projectId, item.sceneId] : [item.projectId]
      );
      const nextSort = ((maxRow && maxRow.maxSort != null) ? maxRow.maxSort : -1) + 1;

      const r = await tx.run(
        `INSERT INTO videos
         (title, filename, url, status, size, duration, sortOrder, projectId, sceneId, type,
          sceneContent, actors, props, costume, location, focalLength, narration,
          cameraMovement, shotType, shotAngle, lighting, notes, estimatedDuration,
          aiImagePrompt, aiStylePrompt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.sceneContent || item.title || '新分镜',
          item.filename || '',
          item.url || '',
          item.status || 'done',
          item.size || 0,
          item.duration || null,
          item.sortOrder !== undefined ? item.sortOrder : nextSort,
          item.projectId,
          item.sceneId !== undefined ? item.sceneId : null,
          item.type || 'image',
          item.sceneContent || '',
          item.actors || '',
          item.props || '',
          item.costume || '',
          item.location || '',
          item.focalLength || '',
          item.narration || '',
          item.cameraMovement || '',
          item.shotType || '',
          item.shotAngle || '',
          item.lighting || '',
          item.notes || '',
          item.estimatedDuration || '',
          item.aiImagePrompt || '',
          item.aiStylePrompt || ''
        ]
      );
      return { newId: r.lastID, nextSort };
    });

    return formatShot({ id: newId, sortOrder: nextSort, ...item });
  },

  // 分镜升级：合并分镜
  mergeShots: async (shotIds) => {
    if (!shotIds || shotIds.length < 2) throw new Error('至少需要2个分镜才能合并');

    const shots = await storyboardAsync.all(
      `SELECT * FROM videos WHERE id IN (${shotIds.map(() => '?').join(',')}) ORDER BY sortOrder ASC, id ASC`,
      shotIds
    );
    if (shots.length < 2) throw new Error('分镜不存在');

    // 检查是否同一项目
    const projectId = shots[0].projectId;
    if (shots.some(s => s.projectId !== projectId)) {
      throw new Error('只能合并同一项目的分镜');
    }

    // 检查合并后 shot_media 总数
    const mediaCount = await storyboardAsync.get(
      `SELECT COUNT(*) as cnt FROM shot_media WHERE shotId IN (${shotIds.map(() => '?').join(',')})`,
      shotIds
    );
    if (mediaCount && mediaCount.cnt > 10) {
      throw new Error('合并后参考画面总数不能超过10个');
    }

    const firstShot = shots[0];
    const otherShots = shots.slice(1);

    // 合并 sceneContent（拼接）
    const mergedContent = shots.map(s => s.sceneContent || s.title || '').filter(t => t).join(' / ');

    // P4-2：用事务包裹"迁移 media + 删除原 shot + 更新首 shot"，保证原子性
    // 中途任何步骤失败都会 ROLLBACK，避免出现孤儿 media 或媒体丢失
    await storyboardAsync.transaction(async (tx) => {
      // 合并后第一个分镜保留，其他分镜的media迁移过来
      for (const shot of otherShots) {
        // 获取该分镜的media最大sortOrder
        const maxSortRow = await tx.get(
          'SELECT COALESCE(MAX(sortOrder), -1) as maxSort FROM shot_media WHERE shotId = ?',
          [firstShot.id]
        );
        const baseSort = (maxSortRow ? maxSortRow.maxSort : -1) + 1;

        // 迁移media
        const media = await tx.all('SELECT * FROM shot_media WHERE shotId = ? ORDER BY sortOrder ASC', [shot.id]);
        for (let i = 0; i < media.length; i++) {
          await tx.run(
            'INSERT INTO shot_media (shotId, url, type, filename, size, duration, sortOrder, source, createdAt, startTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [firstShot.id, media[i].url, media[i].type, media[i].filename, media[i].size, media[i].duration, baseSort + i, media[i].source, media[i].createdAt, media[i].startTime || 0]
          );
        }

        // 删除被合并的分镜
        await tx.run('DELETE FROM videos WHERE id = ?', [shot.id]);
      }

      // 收集所有被合并分镜的 mergedFrom，用于递归统计
      const allMergedFromIds = new Set();
      for (const shot of shots) {
        if (shot.mergedFrom) {
          try {
            const prevIds = JSON.parse(shot.mergedFrom);
            if (Array.isArray(prevIds)) {
              prevIds.forEach(id => allMergedFromIds.add(id));
            }
          } catch (e) {
            // 解析失败，忽略
          }
        } else {
          allMergedFromIds.add(shot.id);
        }
      }
      const mergedFromArray = Array.from(allMergedFromIds);

      // 更新第一个分镜的 sceneContent 和 mergedFrom
      await tx.run(
        'UPDATE videos SET sceneContent = ?, title = ?, mergedFrom = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
        [mergedContent, mergedContent, JSON.stringify(mergedFromArray), firstShot.id]
      );
    });

    // 返回合并后的分镜
    const merged = await storyboardAsync.get('SELECT * FROM videos WHERE id = ?', [firstShot.id]);
    const mergedMedia = await storyboardAsync.all('SELECT * FROM shot_media WHERE shotId = ? ORDER BY sortOrder ASC', [firstShot.id]);
    return { ...formatShot(merged), media: mergedMedia };
  }
};

// ========== shot_media（分镜参考画面） ==========
const shotMedia = {
  getByShotId: async (shotId) => {
    return await storyboardAsync.all(
      'SELECT * FROM shot_media WHERE shotId = ? ORDER BY sortOrder ASC, id ASC',
      [shotId]
    );
  },

  getByUrlAndShotId: async (url, shotId) => {
    return await storyboardAsync.get(
      'SELECT * FROM shot_media WHERE url = ? AND shotId = ? LIMIT 1',
      [url, shotId]
    );
  },

  create: async (item) => {
    const maxRow = await storyboardAsync.get(
      'SELECT COALESCE(MAX(sortOrder), -1) as maxSort FROM shot_media WHERE shotId = ?',
      [item.shotId]
    );
    const nextSort = (maxRow ? maxRow.maxSort : -1) + 1;

    const r = await storyboardAsync.run(
      'INSERT INTO shot_media (shotId, url, type, filename, size, duration, sortOrder, source, startTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        item.shotId, item.url, item.type || 'image', item.filename || '',
        item.size || 0, item.duration || null,
        item.sortOrder !== undefined ? item.sortOrder : nextSort,
        item.source || 'upload',
        item.startTime !== undefined ? item.startTime : 0
      ]
    );
    return { id: r.lastID, sortOrder: nextSort, ...item };
  },

  delete: async (id) => {
    const r = await storyboardAsync.run('DELETE FROM shot_media WHERE id = ?', [id]);
    return r.changes > 0;
  },

  updateSort: async (shotId, items) => {
    for (const item of items) {
      await storyboardAsync.run(
        'UPDATE shot_media SET sortOrder = ? WHERE id = ? AND shotId = ?',
        [item.sortOrder, item.id, shotId]
      );
    }
    return true;
  },

  getBySceneId: async (sceneId) => {
    return await storyboardAsync.all(
      `SELECT sm.* FROM shot_media sm
       INNER JOIN videos v ON sm.shotId = v.id
       WHERE v.sceneId = ? AND v.deleted = 0 AND sm.type = 'image'
       ORDER BY sm.id DESC`,
      [sceneId]
    );
  },

  getByLocation: async (projectId, location) => {
    if (!location || !location.trim()) return [];
    const normalized = location.trim().toLowerCase();
    return await storyboardAsync.all(
      `SELECT sm.* FROM shot_media sm
       INNER JOIN videos v ON sm.shotId = v.id
       WHERE v.projectId = ? AND v.deleted = 0 AND sm.type = 'image'
         AND LOWER(TRIM(v.location)) = ?
       ORDER BY sm.id DESC`,
      [projectId, normalized]
    );
  }
};

// ========== settings（系统设置） ==========
const settings = {
  getAll: async () => {
    const rows = await storyboardAsync.all('SELECT * FROM settings');
    const result = {};
    rows.forEach(row => {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        result[row.key] = row.value;
      }
    });
    return result;
  },

  get: async (key) => {
    const row = await storyboardAsync.get('SELECT * FROM settings WHERE key = ?', [key]);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  },

  set: async (key, value) => {
    const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const existing = await storyboardAsync.get('SELECT key FROM settings WHERE key = ?', [key]);
    if (existing) {
      await storyboardAsync.run(
        'UPDATE settings SET value = ?, updatedAt = CURRENT_TIMESTAMP WHERE key = ?',
        [valStr, key]
      );
    } else {
      await storyboardAsync.run(
        'INSERT INTO settings (key, value) VALUES (?, ?)',
        [key, valStr]
      );
    }
    return true;
  },

  bulkSet: async (settings) => {
    for (const key of Object.keys(settings)) {
      await settings.set(key, settings[key]);
    }
    return true;
  }
};

// ========== ai_tasks（AI 异步任务） ==========
const aiTasks = {
  create: async (task) => {
    const id = task.id || crypto.randomUUID();
    await storyboardAsync.run(
      'INSERT INTO ai_tasks (id, type, status, projectId, input, progress) VALUES (?, ?, ?, ?, ?, ?)',
      [
        id, task.type, task.status || 'pending',
        task.projectId || null,
        task.input ? JSON.stringify(task.input) : null,
        task.progress || 0
      ]
    );
    return { id, ...task };
  },

  get: async (id) => {
    const row = await storyboardAsync.get('SELECT * FROM ai_tasks WHERE id = ?', [id]);
    if (!row) return null;
    return {
      ...row,
      input: row.input ? JSON.parse(row.input) : null,
      output: row.output ? JSON.parse(row.output) : null
    };
  },

  update: async (id, updates) => {
    const sets = [];
    const vals = [];
    const fields = ['status', 'progress', 'error'];
    fields.forEach(f => {
      if (updates[f] !== undefined) {
        sets.push(f + ' = ?');
        vals.push(updates[f]);
      }
    });
    if (updates.output !== undefined) {
      sets.push('output = ?');
      vals.push(JSON.stringify(updates.output));
    }
    if (sets.length === 0) return false;
    sets.push('updatedAt = CURRENT_TIMESTAMP');
    vals.push(id);
    const r = await storyboardAsync.run('UPDATE ai_tasks SET ' + sets.join(', ') + ' WHERE id = ?', vals);
    return r.changes > 0;
  }
};

// ========== ai_usage_logs（AI 费用统计） ==========
const aiUsage = {
  record: async (log) => {
    const r = await storyboardAsync.run(
      `INSERT INTO ai_usage_logs 
       (taskId, type, model, provider, promptTokens, completionTokens, totalTokens, imageCount, estimatedCost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.taskId || null,
        log.type,
        log.model,
        log.provider,
        log.promptTokens || 0,
        log.completionTokens || 0,
        log.totalTokens || 0,
        log.imageCount || 0,
        log.estimatedCost || 0
      ]
    );
    return { id: r.lastID, ...log };
  },

  getStats: async (period = 'month') => {
    let dateFilter = '';
    if (period === 'month') {
      dateFilter = "WHERE createdAt >= datetime('now', 'start of month')";
    } else if (period === 'week') {
      dateFilter = "WHERE createdAt >= datetime('now', '-7 days')";
    } else if (period === 'all') {
      dateFilter = '';
    }

    const totalRow = await storyboardAsync.get(
      `SELECT COALESCE(SUM(estimatedCost), 0) as totalCost FROM ai_usage_logs ${dateFilter}`
    );

    const typeRows = await storyboardAsync.all(
      `SELECT type, COALESCE(SUM(estimatedCost), 0) as cost FROM ai_usage_logs ${dateFilter} GROUP BY type`
    );

    const modelRows = await storyboardAsync.all(
      `SELECT model, provider, 
              COALESCE(SUM(promptTokens), 0) as promptTokens,
              COALESCE(SUM(completionTokens), 0) as completionTokens,
              COALESCE(SUM(totalTokens), 0) as totalTokens,
              COALESCE(SUM(imageCount), 0) as imageCount,
              COALESCE(SUM(estimatedCost), 0) as cost
       FROM ai_usage_logs ${dateFilter}
       GROUP BY model, provider
       ORDER BY cost DESC`
    );

    const breakdown = { chat: 0, image: 0, video_split: 0 };
    typeRows.forEach(r => { if (breakdown[r.type] !== undefined) breakdown[r.type] = r.cost; });

    return {
      totalCost: totalRow ? totalRow.totalCost : 0,
      breakdown,
      modelStats: modelRows
    };
  }
};

// ========== transcode_tasks（转码任务持久化） ==========
const transcodeTasks = {
  create: async (task) => {
    await storyboardAsync.run(
      `INSERT INTO transcode_tasks (id, jobId, requestId, status, progress, videoUrl, outputUrl, outputObject, projectId, options)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.jobId || null,
        task.requestId || null,
        task.status || 'pending',
        task.progress || 0,
        task.videoUrl || null,
        task.outputUrl || null,
        task.outputObject || null,
        task.projectId || null,
        task.options ? JSON.stringify(task.options) : null
      ]
    );
    return task;
  },

  get: async (id) => {
    const row = await storyboardAsync.get('SELECT * FROM transcode_tasks WHERE id = ?', [id]);
    if (!row) return null;
    return {
      ...row,
      options: row.options ? JSON.parse(row.options) : null
    };
  },

  getByStatus: async (status) => {
    const rows = await storyboardAsync.all('SELECT * FROM transcode_tasks WHERE status = ?', [status]);
    return rows.map(row => ({
      ...row,
      options: row.options ? JSON.parse(row.options) : null
    }));
  },

  getPendingAndProcessing: async () => {
    const rows = await storyboardAsync.all(
      "SELECT * FROM transcode_tasks WHERE status IN ('pending', 'processing')"
    );
    return rows.map(row => ({
      ...row,
      options: row.options ? JSON.parse(row.options) : null
    }));
  },

  update: async (id, updates) => {
    const sets = [];
    const vals = [];
    const fields = ['jobId', 'requestId', 'status', 'progress', 'outputUrl', 'outputObject', 'error', 'lastQueriedAt'];
    fields.forEach(f => {
      if (updates[f] !== undefined) {
        sets.push(f + ' = ?');
        vals.push(updates[f]);
      }
    });
    if (sets.length === 0) return false;
    sets.push('updatedAt = CURRENT_TIMESTAMP');
    vals.push(id);
    const r = await storyboardAsync.run('UPDATE transcode_tasks SET ' + sets.join(', ') + ' WHERE id = ?', vals);
    return r.changes > 0;
  },

  delete: async (id) => {
    const r = await storyboardAsync.run('DELETE FROM transcode_tasks WHERE id = ?', [id]);
    return r.changes > 0;
  }
};

// ========== digital_assets（数字资产：演员/道具/场景） ==========
const digitalAssets = {
  getByProjectId: async (projectId, type = null) => {
    let sql = 'SELECT * FROM digital_assets WHERE projectId = ?';
    const params = [projectId];
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    sql += ' ORDER BY createdAt DESC, id ASC';
    const assets = await storyboardAsync.all(sql, params);

    // 为每个资产加载图片列表
    for (const asset of assets) {
      const images = await storyboardAsync.all(
        'SELECT * FROM digital_asset_images WHERE assetId = ? ORDER BY sortOrder ASC, id ASC',
        [asset.id]
      );
      asset.images = images;
      // 保持 imageUrl 兼容（取第一张）
      if (images.length > 0 && !asset.imageUrl) {
        asset.imageUrl = images[0].imageUrl;
      }
    }
    return assets;
  },

  getById: async (id) => {
    const asset = await storyboardAsync.get('SELECT * FROM digital_assets WHERE id = ?', [id]);
    if (asset) {
      const images = await storyboardAsync.all(
        'SELECT * FROM digital_asset_images WHERE assetId = ? ORDER BY sortOrder ASC, id ASC',
        [id]
      );
      asset.images = images;
    }
    return asset;
  },

  create: async ({ projectId, type, name, imagePrompt, imageUrl }) => {
    const result = await storyboardAsync.run(
      'INSERT INTO digital_assets (projectId, type, name, imagePrompt, imageUrl) VALUES (?, ?, ?, ?, ?)',
      [projectId, type, name, imagePrompt || '', imageUrl || '']
    );
    const newAsset = { id: result.lastID, projectId, type, name, imagePrompt: imagePrompt || '', imageUrl: imageUrl || '', createdAt: new Date().toISOString(), images: [] };

    // 如果有 imageUrl，也添加到 images 表
    if (imageUrl && imageUrl.trim()) {
      await storyboardAsync.run(
        'INSERT INTO digital_asset_images (assetId, imageUrl, sortOrder) VALUES (?, ?, 0)',
        [result.lastID, imageUrl]
      );
      newAsset.images = [{ id: 0, assetId: result.lastID, imageUrl, sortOrder: 0, createdAt: new Date().toISOString() }];
    }
    return newAsset;
  },

  update: async (id, { name, imagePrompt, imageUrl }) => {
    const fields = [];
    const vals = [];
    if (name !== undefined) { fields.push('name=?'); vals.push(name); }
    if (imagePrompt !== undefined) { fields.push('imagePrompt=?'); vals.push(imagePrompt); }
    if (imageUrl !== undefined) { fields.push('imageUrl=?'); vals.push(imageUrl); }
    if (fields.length === 0) return false;
    vals.push(id);
    const r = await storyboardAsync.run('UPDATE digital_assets SET ' + fields.join(', ') + ' WHERE id = ?', vals);
    return r.changes > 0;
  },

  delete: async (id) => {
    const r = await storyboardAsync.run('DELETE FROM digital_assets WHERE id = ?', [id]);
    return r.changes > 0;
  },

  // ========== 图片管理 ==========
  addImage: async (assetId, imageUrl, size = 0) => {
    // 检查是否超过 10 张限制
    const countRow = await storyboardAsync.get(
      'SELECT COUNT(*) as cnt FROM digital_asset_images WHERE assetId = ?',
      [assetId]
    );
    if (countRow?.cnt >= 10) {
      throw new Error('最多只能添加 10 张图片');
    }

    // 先获取当前最大 sortOrder
    const maxRow = await storyboardAsync.get(
      'SELECT MAX(sortOrder) as maxSort FROM digital_asset_images WHERE assetId = ?',
      [assetId]
    );
    const sortOrder = (maxRow?.maxSort || 0) + 1;

    const result = await storyboardAsync.run(
      'INSERT INTO digital_asset_images (assetId, imageUrl, size, sortOrder) VALUES (?, ?, ?, ?)',
      [assetId, imageUrl, size || 0, sortOrder]
    );

    // 如果是第一张图，更新主表的 imageUrl
    const newCountRow = await storyboardAsync.get(
      'SELECT COUNT(*) as cnt FROM digital_asset_images WHERE assetId = ?',
      [assetId]
    );
    if (newCountRow?.cnt === 1) {
      await storyboardAsync.run(
        'UPDATE digital_assets SET imageUrl = ? WHERE id = ?',
        [imageUrl, assetId]
      );
    }

    return { id: result.lastID, assetId, imageUrl, size: size || 0, sortOrder, createdAt: new Date().toISOString() };
  },

  deleteImage: async (assetId, imageId) => {
    const r = await storyboardAsync.run(
      'DELETE FROM digital_asset_images WHERE id = ? AND assetId = ?',
      [imageId, assetId]
    );
    if (r.changes > 0) {
      // 如果删完后还有图片，更新主表 imageUrl 为第一张
      const firstImage = await storyboardAsync.get(
        'SELECT imageUrl FROM digital_asset_images WHERE assetId = ? ORDER BY sortOrder ASC, id ASC LIMIT 1',
        [assetId]
      );
      await storyboardAsync.run(
        'UPDATE digital_assets SET imageUrl = ? WHERE id = ?',
        [firstImage?.imageUrl || '', assetId]
      );
    }
    return r.changes > 0;
  },

  getImages: async (assetId) => {
    return await storyboardAsync.all(
      'SELECT * FROM digital_asset_images WHERE assetId = ? ORDER BY sortOrder ASC, id ASC',
      [assetId]
    );
  }
};

module.exports = {
  // 以下为企业官网时代遗留模块，已废弃，仅供向后兼容
  // portfolioItems,
  // featuredWorks,
  // homeContent,
  // teamMembers,
  // categoriesDetails,
  // storyboard 视频片段管理模块（当前使用）
  items,
  projects,
  scenes,
  shotMedia,
  settings,
  aiTasks,
  aiUsage,
  transcodeTasks,
  digitalAssets,
  storyboardAsync,
  db
};
