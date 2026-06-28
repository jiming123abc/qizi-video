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

    // video2 相关表在下方 video2InitDatabase 中创建
  });
}

function insertInitialData() {
  console.log('[legacy] 跳过企业官网旧表初始数据插入（video2 为独立数据库）');
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

// ==================== video2 独立数据库（视频片段管理） ====================

const video2DbPath = path.join(__dirname, 'video2.db');
const video2Db = new sqlite3.Database(video2DbPath, (err) => {
  if (err) {
    console.error('[video2] 打开数据库失败:', err.message);
  } else {
    console.log('[video2] 已连接 SQLite 数据库');
    initVideo2Database();
  }
});

// video2 数据库就绪标志（所有 DDL 完成后才为 true）
let video2DbReady = false;
const video2DbWaiters = [];

function video2DbOnReady(cb) {
  if (video2DbReady) { cb && cb(); return; }
  if (cb) video2DbWaiters.push(cb);
}
function video2DbSetReady() {
  if (video2DbReady) return;
  video2DbReady = true;
  const list = video2DbWaiters.splice(0, video2DbWaiters.length);
  list.forEach(function(cb) { try { cb(); } catch (e) {} });
  console.log('[video2] 表结构已就绪');
}

function initVideo2Database() {
  video2Db.serialize(() => {
    // 1. 创建 videos 表（完整新结构，包括所有新列：type/coverUrl/isCover/reference）
    video2Db.run(`
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
    video2Db.run(`ALTER TABLE videos ADD COLUMN shotNo TEXT`, (err) => {
      // 如果列已存在或表不存在，忽略错误
    });

    // ========== 分镜升级：新增 videos 表专业字段 ==========
    const shotColumns = [
      'sceneContent TEXT DEFAULT \'\'',
      'actors TEXT DEFAULT \'\'',
      'props TEXT DEFAULT \'\'',
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
      'mergedFrom TEXT DEFAULT \'\'',
      'shotIndex INTEGER DEFAULT 0'
    ];
    shotColumns.forEach(function(colDef) {
      video2Db.run(`ALTER TABLE videos ADD COLUMN ${colDef}`, function(err) {
        if (err && String(err.message).indexOf(ignoredMsg) === -1) {
          console.error('[video2] 新增分镜字段失败:', colDef, err.message);
        }
      });
    });

    // ========== shot_media 表（分镜参考画面） ==========
    video2Db.run(`
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
    video2Db.run('CREATE INDEX IF NOT EXISTS idx_shot_media_shot ON shot_media(shotId)');

    // ========== settings 表（系统设置） ==========
    video2Db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ========== ai_tasks 表（AI 异步任务） ==========
    video2Db.run(`
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
    video2Db.run(`
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
    video2Db.run('CREATE INDEX IF NOT EXISTS idx_usage_created ON ai_usage_logs(createdAt)');

    // ========== transcode_tasks 表（转码任务持久化） ==========
    video2Db.run(`
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
    video2Db.run('CREATE INDEX IF NOT EXISTS idx_transcode_status ON transcode_tasks(status)');
    video2Db.run('CREATE INDEX IF NOT EXISTS idx_transcode_project ON transcode_tasks(projectId)');

    // 2. 创建 projects 表
    video2Db.run(`
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
    video2Db.run(`
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
    const ignoredMsg = 'duplicate column name';
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
      video2Db.run(sql, function(err) {
        if (err && String(err.message).indexOf(ignoredMsg) === -1) {
          console.error('[video2] ALTER TABLE 失败:', err.message);
        }
      });
    });

    // 5. 创建索引
    video2Db.run('CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status)');
    video2Db.run('CREATE INDEX IF NOT EXISTS idx_videos_sort ON videos(sortOrder)');
    video2Db.run('CREATE INDEX IF NOT EXISTS idx_videos_deleted ON videos(deleted)');
    video2Db.run('CREATE INDEX IF NOT EXISTS idx_videos_project ON videos(projectId)');
    video2Db.run('CREATE INDEX IF NOT EXISTS idx_videos_scene ON videos(sceneId)');
    video2Db.run('CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(projectId)');

    // 6. 迁移：sortOrder 回填 + 默认项目创建 + 分镜数据迁移
    //    用最后一条 run() 的回调确保所有上述 DDL 已完成
    video2Db.get('SELECT 1 as ok', function(_err, _row) {
      // 先确保 sortOrder 有值
      video2Db.get('SELECT COUNT(*) as cnt FROM videos WHERE sortOrder IS NULL', function(err2, r) {
        if (!err2 && r && r.cnt > 0) {
          fillSortOrder();
        }
        // 迁移默认项目
        migrateDefaultProject(function() {
          // 分镜升级数据迁移
          migrateShotData(function() {
            // 初始化系统设置
            initDefaultSettings(function() {
              video2DbSetReady();
            });
          });
        });
      });
    });
  });
}

function fillSortOrder() {
  video2Db.all('SELECT id FROM videos ORDER BY createdAt ASC, id ASC', function(err2, rows) {
    if (err2) {
      console.error('[video2] 查询视频列表失败:', err2.message);
      return;
    }
    (rows || []).forEach(function(r, i) {
      video2Db.run('UPDATE videos SET sortOrder = ? WHERE id = ?', [i, r.id]);
    });
    console.log('[video2] sortOrder 填充完成，共 ' + (rows ? rows.length : 0) + ' 条');
  });
}

// ========== 分镜数据迁移 ==========
function migrateShotData(callback) {
  // 1. 将 title 迁移到 sceneContent
  video2Db.run(
    'UPDATE videos SET sceneContent = title WHERE sceneContent IS NULL OR sceneContent = ?',
    [''],
    function(err) {
      if (err) console.error('[video2] 迁移 sceneContent 失败:', err.message);
      else if (this.changes > 0) console.log('[video2] 已迁移 sceneContent: ' + this.changes + ' 条');
    }
  );

  // 2. 将有 url 的视频迁移到 shot_media 表
  video2Db.all(
    "SELECT id, url, type, filename, size, duration FROM videos WHERE url IS NOT NULL AND url != ''",
    function(err, rows) {
      if (err) {
        console.error('[video2] 查询待迁移视频失败:', err.message);
        callback && callback();
        return;
      }

      // 检查是否已经迁移过
      video2Db.get('SELECT COUNT(*) as cnt FROM shot_media', function(err2, r) {
        if (!err2 && r && r.cnt === 0 && rows && rows.length > 0) {
          let migrated = 0;
          const stmt = video2Db.prepare(
            'INSERT INTO shot_media (shotId, url, type, filename, size, duration, sortOrder, source) VALUES (?, ?, ?, ?, ?, ?, 0, \'upload\')'
          );
          rows.forEach(function(row) {
            if (row.url) {
              stmt.run(row.id, row.url, row.type || 'video', row.filename || '', row.size || 0, row.duration || null, function(err3) {
                if (!err3) migrated++;
              });
            }
          });
          stmt.finalize(function() {
            console.log('[video2] 已迁移 shot_media: ' + migrated + ' 条');
            recalcShotIndex(callback);
          });
        } else {
          recalcShotIndex(callback);
        }
      });
    }
  );
}

// 重新计算所有分镜的 shotIndex
function recalcShotIndex(callback) {
  video2Db.all(
    'SELECT id, projectId, sceneId FROM videos WHERE deleted = 0 ORDER BY projectId ASC, sceneId ASC, sortOrder ASC, id ASC',
    function(err, rows) {
      if (err) {
        console.error('[video2] 计算 shotIndex 失败:', err.message);
        callback && callback();
        return;
      }

      const stmt = video2Db.prepare('UPDATE videos SET shotIndex = ? WHERE id = ?');
      let currentProj = null;
      let currentScene = null;
      let idx = 0;

      (rows || []).forEach(function(row) {
        if (row.projectId !== currentProj || row.sceneId !== currentScene) {
          idx = 1;
          currentProj = row.projectId;
          currentScene = row.sceneId;
        } else {
          idx++;
        }
        stmt.run(idx, row.id);
      });

      stmt.finalize(function() {
        console.log('[video2] shotIndex 计算完成: ' + (rows ? rows.length : 0) + ' 条');
        callback && callback();
      });
    }
  );
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
    video2Db.get('SELECT key FROM settings WHERE key = ?', [key], function(err, row) {
      if (!row) {
        video2Db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?)',
          [key, defaults[key]],
          function(err2) {
            if (!err2) inserted++;
            remaining--;
            if (remaining === 0) {
              console.log('[video2] 已初始化 settings: ' + inserted + ' 条');
              callback && callback();
            }
          }
        );
      } else {
        remaining--;
        if (remaining === 0) {
          console.log('[video2] settings 已存在，跳过初始化');
          callback && callback();
        }
      }
    });
  });
}

function migrateDefaultProject(callback) {
  video2Db.get('SELECT COUNT(*) as cnt FROM projects', function(err, row) {
    if (err) {
      console.error('[video2] 检查 projects 表失败:', err.message);
      callback && callback();
      return;
    }
    if (row && row.cnt === 0) {
      // 插入"默认项目"
      video2Db.run(
        "INSERT INTO projects (name, description, sortOrder) VALUES ('默认项目', '自动创建的默认项目，所有历史视频归入此处', 0)",
        function(insErr) {
          if (insErr) {
            console.error('[video2] 创建默认项目失败:', insErr.message);
            callback && callback();
            return;
          }
          const defaultProjectId = this.lastID;
          video2Db.run(
            'UPDATE videos SET projectId = ? WHERE projectId IS NULL',
            [defaultProjectId],
            function(upErr) {
              if (upErr) {
                console.error('[video2] 迁移历史视频到默认项目失败:', upErr.message);
              } else {
                console.log('[video2] 已创建默认项目(ID=' + defaultProjectId + ')，历史视频已迁移');
              }
              callback && callback();
            }
          );
        }
      );
    } else {
      callback && callback();
    }
  });
}

const video2Async = {
  get: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      video2DbOnReady(() => {
        video2Db.get(sql, params, (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
    });
  },
  all: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      video2DbOnReady(() => {
        video2Db.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    });
  },
  run: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      video2DbOnReady(() => {
        video2Db.run(sql, params, function(err) {
          if (err) reject(err);
          else resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    });
  }
};

// ── video2Projects ──────────────────────────────────────────────
const video2Projects = {
  getAll: async () => {
    const projects = await video2Async.all(
      'SELECT * FROM projects ORDER BY sortOrder ASC, id ASC'
    );
    // 附加视频数与占用空间
    const result = [];
    for (const p of projects) {
      const stats = await video2Async.get(
        'SELECT COUNT(*) as cnt, COALESCE(SUM(size),0) as totalSize FROM videos WHERE projectId = ? AND deleted = 0',
        [p.id]
      );
      result.push({
        ...p,
        videoCount: stats ? stats.cnt : 0,
        totalSize: stats ? stats.totalSize : 0
      });
    }
    return result;
  },
  getById: async (id) => {
    return await video2Async.get('SELECT * FROM projects WHERE id = ?', [id]);
  },
  create: async ({ name, description, coverUrl }) => {
    const maxRow = await video2Async.get('SELECT MAX(sortOrder) as maxSort FROM projects');
    const nextSort = ((maxRow && maxRow.maxSort != null) ? maxRow.maxSort : -1) + 1;
    const DEFAULT_COVER = 'data:image/svg+xml;utf8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 225"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#ec4899"/></linearGradient></defs><rect width="400" height="225" fill="url(#g)"/></svg>');
    const finalCoverUrl = coverUrl || DEFAULT_COVER;
    const result = await video2Async.run(
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
    await video2Async.run('UPDATE projects SET ' + fields.join(', ') + ' WHERE id = ?', vals);
    return true;
  },
  updateSort: async (orders) => {
    for (const item of orders) {
      await video2Async.run(
        'UPDATE projects SET sortOrder = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
        [item.sortOrder, item.id]
      );
    }
    return true;
  },
  delete: async (id) => {
    // 获取该项目下所有视频 url（用于调用方清理 OSS）
    const videos = await video2Async.all(
      'SELECT url FROM videos WHERE projectId = ?',
      [id]
    );
    await video2Async.run('DELETE FROM scenes WHERE projectId = ?', [id]);
    await video2Async.run('DELETE FROM projects WHERE id = ?', [id]);
    return videos; // 返回视频 URL 列表，由调用方清理 OSS
  }
};

// ── video2Scenes ──────────────────────────────────────────────
const video2Scenes = {
  getByProjectId: async (projectId) => {
    const scenes = await video2Async.all(
      'SELECT * FROM scenes WHERE projectId = ? ORDER BY sortOrder ASC, id ASC',
      [projectId]
    );
    const result = [];
    for (const s of scenes) {
      const stats = await video2Async.get(
        'SELECT COUNT(*) as cnt FROM videos WHERE sceneId = ? AND deleted = 0',
        [s.id]
      );
      result.push({
        ...s,
        videoCount: stats ? stats.cnt : 0
      });
    }
    return result;
  },
  create: async ({ projectId, name }) => {
    const maxRow = await video2Async.get(
      'SELECT MAX(sortOrder) as maxSort FROM scenes WHERE projectId = ?',
      [projectId]
    );
    const nextSort = ((maxRow && maxRow.maxSort != null) ? maxRow.maxSort : -1) + 1;
    const result = await video2Async.run(
      'INSERT INTO scenes (projectId, name, sortOrder) VALUES (?, ?, ?)',
      [projectId, name, nextSort]
    );
    return { id: result.lastID, projectId, name, sortOrder: nextSort, videoCount: 0 };
  },
  update: async (id, { name, scrollPosition }) => {
    const fields = [];
    const vals = [];
    if (name !== undefined) { fields.push('name=?'); vals.push(name); }
    if (scrollPosition !== undefined) { fields.push('scrollPosition=?'); vals.push(scrollPosition); }
    if (fields.length === 0) return;
    fields.push('updatedAt=CURRENT_TIMESTAMP');
    vals.push(id);
    await video2Async.run('UPDATE scenes SET ' + fields.join(', ') + ' WHERE id = ?', vals);
    return true;
  },
  updateSort: async (orders) => {
    for (const item of orders) {
      await video2Async.run(
        'UPDATE scenes SET sortOrder = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
        [item.sortOrder, item.id]
      );
    }
    return true;
  },
  delete: async (id) => {
    // 该场次下视频归到未分类
    await video2Async.run('UPDATE videos SET sceneId = NULL WHERE sceneId = ?', [id]);
    await video2Async.run('DELETE FROM scenes WHERE id = ?', [id]);
    return true;
  }
};

// ── video2Items（扩展）────────────────────────────────────────
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

const video2Items = {
  getAll: async () => {
    const rows = await video2Async.all(
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
    const rows = await video2Async.all(sql, params);
    return rows.map(formatShot);
  },
  getByStatus: async (status) => {
    const rows = await video2Async.all(
      'SELECT * FROM videos WHERE status = ? AND deleted = 0 ORDER BY sortOrder ASC, id ASC',
      [status]
    );
    return rows.map(formatShot);
  },
  getStats: async ({ projectId, sceneId } = {}) => {
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
    const all = await video2Async.all(
      'SELECT status, COUNT(*) as cnt FROM videos ' + whereClause + ' GROUP BY status',
      params
    );
    const map = { pending: 0, done: 0, total: 0, trash: 0, unclassified: 0 };
    all.forEach(r => {
      map[r.status] = r.cnt;
      map.total += r.cnt;
    });
    const trashWhere = projectId !== undefined ? ' WHERE deleted = 1 AND projectId = ?' : ' WHERE deleted = 1';
    const trashParams = projectId !== undefined ? [projectId] : [];
    const trash = await video2Async.get(
      'SELECT COUNT(*) as cnt FROM videos' + trashWhere,
      trashParams
    );
    map.trash = trash ? trash.cnt : 0;
    let unclassifiedWhere = 'WHERE deleted = 0 AND sceneId IS NULL';
    const unclassifiedParams = [];
    if (projectId !== undefined) { unclassifiedWhere += ' AND projectId = ?'; unclassifiedParams.push(projectId); }
    const unclassified = await video2Async.get(
      'SELECT COUNT(*) as cnt FROM videos ' + unclassifiedWhere,
      unclassifiedParams
    );
    map.unclassified = unclassified ? unclassified.cnt : 0;
    return map;
  },
  getSceneStats: async (projectId) => {
    const rows = await video2Async.all(
      `SELECT v.sceneId, s.name as sceneName, v.status, COUNT(*) as cnt
       FROM videos v
       LEFT JOIN scenes s ON v.sceneId = s.id
       WHERE v.projectId = ? AND v.deleted = 0 AND v.status != 'trash'
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
    const project = await video2Async.get('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!project) return null;
    const scenes = await video2Async.all(
      'SELECT id, name, sortOrder, createdAt, updatedAt FROM scenes WHERE projectId = ? ORDER BY sortOrder IS NULL, sortOrder ASC, id ASC',
      [projectId]
    );
    const shots = await video2Async.all(
      `SELECT id, title, filename, url, status, size, duration, sortOrder, projectId, sceneId, type, coverUrl, reference,
              narration, sceneContent, actors, location, shotNo, shotType, cameraMovement, shotAngle, durationSeconds,
              props, notes, deleted, deletedAt, createdAt, updatedAt, mergedFrom, aiImageTaskId, aiImagePrompt,
              focalLength, lighting, estimatedDuration, aiStylePrompt, shotIndex
       FROM videos WHERE projectId = ? AND deleted = 0
       ORDER BY sortOrder IS NULL, sortOrder ASC, id ASC`,
      [projectId]
    );
    const shotIds = shots.map(s => s.id);
    let media = [];
    if (shotIds.length > 0) {
      const placeholders = shotIds.map(() => '?').join(',');
      media = await video2Async.all(
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
      const result = await video2Async.run(
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
      const existing = await video2Async.get('SELECT * FROM projects WHERE id = ?', [targetProjectId]);
      if (!existing) throw new Error('目标项目不存在');
    }

    const sceneIdMap = {};
    if (scenes && scenes.length > 0) {
      for (const s of scenes) {
        const result = await video2Async.run(
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
        const result = await video2Async.run(
          `INSERT INTO videos (title, filename, url, status, size, duration, sortOrder, projectId, sceneId, type, coverUrl, reference,
            narration, sceneContent, actors, location, shotNo, shotType, cameraMovement, shotAngle, durationSeconds,
            props, notes, mergedFrom, aiImageTaskId, aiImagePrompt, focalLength, lighting, estimatedDuration,
            aiStylePrompt, shotIndex)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sh.title, sh.filename, sh.url, sh.status || 'pending', sh.size || 0, sh.duration || 0,
            sh.sortOrder ?? null, newProjectId, newSceneId, sh.type || 'video',
            sh.coverUrl || null, sh.reference || 0,
            sh.narration || null, sh.sceneContent || null, sh.actors || null, sh.location || null,
            sh.shotNo || null, sh.shotType || null, sh.cameraMovement || null, sh.shotAngle || null,
            sh.durationSeconds || null, sh.props || null, sh.notes || null,
            sh.mergedFrom || null, sh.aiImageTaskId || null, sh.aiImagePrompt || null,
            sh.focalLength || null, sh.lighting || null, sh.estimatedDuration || null,
            sh.aiStylePrompt || null, sh.shotIndex || 0
          ]
        );
        shotIdMap[sh.id] = result.lastID;
      }
    }

    if (media && media.length > 0) {
      for (const m of media) {
        const newShotId = shotIdMap[m.shotId];
        if (!newShotId) continue;
        await video2Async.run(
          'INSERT INTO shot_media (shotId, url, type, filename, size, duration, sortOrder, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            newShotId, m.url, m.type || 'image', m.filename || '',
            m.size || 0, m.duration || null, m.sortOrder ?? 0, m.source || 'upload'
          ]
        );
      }
    }

    return { projectId: newProjectId, sceneIdMap, shotIdMap };
  },
  getById: async (id) => {
    const row = await video2Async.get('SELECT * FROM videos WHERE id = ?', [id]);
    return formatShot(row);
  },
  create: async (item) => {
    const maxRow = await video2Async.get(
      'SELECT MAX(sortOrder) as maxSort FROM videos WHERE deleted = 0 AND (reference IS NULL OR reference = 0)'
    );
    const nextSort = ((maxRow && maxRow.maxSort != null) ? maxRow.maxSort : -1) + 1;
    const result = await video2Async.run(
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
    const result = await video2Async.run(
      'UPDATE videos SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id]
    );
    return result.changes > 0;
  },
  updateShotNo: async (id, shotNo) => {
    const result = await video2Async.run(
      'UPDATE videos SET shotNo = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [shotNo || null, id]
    );
    return result.changes > 0;
  },
  updateTitle: async (id, title) => {
    const result = await video2Async.run(
      'UPDATE videos SET title = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [title, id]
    );
    return result.changes > 0;
  },
  updateSort: async (orders) => {
    for (const item of orders) {
      await video2Async.run(
        'UPDATE videos SET sortOrder = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
        [item.sortOrder, item.id]
      );
    }
    return true;
  },
  // 软删除（移入垃圾桶）
  softDelete: async (id) => {
    const result = await video2Async.run(
      'UPDATE videos SET deleted = 1, deletedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [id]
    );
    return result.changes > 0;
  },
  // 从垃圾桶恢复
  restore: async (id) => {
    const result = await video2Async.run(
      'UPDATE videos SET deleted = 0, deletedAt = NULL, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [id]
    );
    return result.changes > 0;
  },
  // 彻底删除（DB 记录，由调用方清理 OSS）
  hardDelete: async (id) => {
    const result = await video2Async.run('DELETE FROM videos WHERE id = ?', [id]);
    return result.changes > 0;
  },
  // 批量软删除
  batchSoftDelete: async (ids) => {
    const placeholders = ids.map(() => '?').join(',');
    const result = await video2Async.run(
      `UPDATE videos SET deleted = 1, deletedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      ids
    );
    return result.changes;
  },
  // 批量恢复
  batchRestore: async (ids) => {
    const placeholders = ids.map(() => '?').join(',');
    const result = await video2Async.run(
      `UPDATE videos SET deleted = 0, deletedAt = NULL, updatedAt = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      ids
    );
    return result.changes;
  },
  // 批量彻底删除（返回被删视频的 URL 列表）
  batchHardDelete: async (ids) => {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await video2Async.all(
      `SELECT url FROM videos WHERE id IN (${placeholders})`,
      ids
    );
    await video2Async.run(
      `DELETE FROM videos WHERE id IN (${placeholders})`,
      ids
    );
    return rows.map(r => r.url);
  },
  // 批量移动到场次
  batchChangeScene: async (ids, sceneId) => {
    const placeholders = ids.map(() => '?').join(',');
    const result = await video2Async.run(
      `UPDATE videos SET sceneId = ?, updatedAt = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      [sceneId, ...ids]
    );
    return result.changes;
  },
  // 兼容旧 API（硬删除，保留给 server.js 旧 DELETE 路由的兼容实现）
  delete: async (id) => {
    const result = await video2Async.run('DELETE FROM videos WHERE id = ?', [id]);
    return result.changes > 0;
  },
  // 原子设置封面：先清除同项目的旧 isCover=1，再设置当前记录
  setCover: async (projectId, videoId) => {
    await video2Async.run('UPDATE videos SET isCover = 0, updatedAt = CURRENT_TIMESTAMP WHERE projectId = ? AND isCover = 1', [projectId]);
    const r = await video2Async.run('UPDATE videos SET isCover = 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [videoId]);
    return r.changes > 0;
  },
  // 取消某条视频的封面标记
  unsetCover: async (videoId) => {
    const r = await video2Async.run('UPDATE videos SET isCover = 0, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [videoId]);
    return r.changes > 0;
  },

  // 分镜升级：更新分镜字段（支持批量字段更新）
  updateShotFields: async (id, fields) => {
    const allowedFields = [
      'sceneContent', 'actors', 'props', 'location', 'focalLength',
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
    const r = await video2Async.run('UPDATE videos SET ' + sets.join(', ') + ' WHERE id = ?', vals);
    return r.changes > 0;
  },

  // 分镜升级：创建空白分镜（无参考画面）
  createShot: async (item) => {
    const maxRow = await video2Async.get(
      'SELECT MAX(sortOrder) as maxSort FROM videos WHERE deleted = 0 AND projectId = ?' + (item.sceneId !== undefined ? ' AND sceneId ' + (item.sceneId === null ? 'IS NULL' : '= ?') : ''),
      item.sceneId !== undefined && item.sceneId !== null ? [item.projectId, item.sceneId] : [item.projectId]
    );
    const nextSort = ((maxRow && maxRow.maxSort != null) ? maxRow.maxSort : -1) + 1;

    const r = await video2Async.run(
      `INSERT INTO videos 
       (title, filename, url, status, size, duration, sortOrder, projectId, sceneId, type, 
        sceneContent, actors, props, location, focalLength, narration, 
        cameraMovement, shotType, shotAngle, lighting, notes, estimatedDuration,
        aiImagePrompt, aiStylePrompt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const newId = r.lastID;

    // 重新计算 shotIndex
    await recalcShotIndexPromise(item.projectId);

    return formatShot({ id: newId, sortOrder: nextSort, ...item });
  },

  // 分镜升级：合并分镜
  mergeShots: async (shotIds) => {
    if (!shotIds || shotIds.length < 2) throw new Error('至少需要2个分镜才能合并');

    const shots = await video2Async.all(
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
    const mediaCount = await video2Async.get(
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

    // 合并后第一个分镜保留，其他分镜的media迁移过来
    let sortOffset = 0;
    for (const shot of otherShots) {
      // 获取该分镜的media最大sortOrder
      const maxSortRow = await video2Async.get(
        'SELECT COALESCE(MAX(sortOrder), -1) as maxSort FROM shot_media WHERE shotId = ?',
        [firstShot.id]
      );
      const baseSort = (maxSortRow ? maxSortRow.maxSort : -1) + 1;

      // 迁移media
      const media = await video2Async.all('SELECT * FROM shot_media WHERE shotId = ? ORDER BY sortOrder ASC', [shot.id]);
      for (let i = 0; i < media.length; i++) {
        await video2Async.run(
          'INSERT INTO shot_media (shotId, url, type, filename, size, duration, sortOrder, source, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [firstShot.id, media[i].url, media[i].type, media[i].filename, media[i].size, media[i].duration, baseSort + i, media[i].source, media[i].createdAt]
        );
      }

      // 删除被合并的分镜
      await video2Async.run('DELETE FROM videos WHERE id = ?', [shot.id]);
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
    await video2Async.run(
      'UPDATE videos SET sceneContent = ?, title = ?, mergedFrom = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
      [mergedContent, mergedContent, JSON.stringify(mergedFromArray), firstShot.id]
    );

    // 重新计算 shotIndex
    await recalcShotIndexPromise(projectId);

    // 返回合并后的分镜
    const merged = await video2Async.get('SELECT * FROM videos WHERE id = ?', [firstShot.id]);
    const mergedMedia = await video2Async.all('SELECT * FROM shot_media WHERE shotId = ? ORDER BY sortOrder ASC', [firstShot.id]);
    return { ...formatShot(merged), media: mergedMedia };
  }
};

// ========== shot_media（分镜参考画面） ==========
const video2ShotMedia = {
  getByShotId: async (shotId) => {
    return await video2Async.all(
      'SELECT * FROM shot_media WHERE shotId = ? ORDER BY sortOrder ASC, id ASC',
      [shotId]
    );
  },

  create: async (item) => {
    const maxRow = await video2Async.get(
      'SELECT COALESCE(MAX(sortOrder), -1) as maxSort FROM shot_media WHERE shotId = ?',
      [item.shotId]
    );
    const nextSort = (maxRow ? maxRow.maxSort : -1) + 1;

    const r = await video2Async.run(
      'INSERT INTO shot_media (shotId, url, type, filename, size, duration, sortOrder, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        item.shotId, item.url, item.type || 'image', item.filename || '',
        item.size || 0, item.duration || null,
        item.sortOrder !== undefined ? item.sortOrder : nextSort,
        item.source || 'upload'
      ]
    );
    return { id: r.lastID, sortOrder: nextSort, ...item };
  },

  delete: async (id) => {
    const r = await video2Async.run('DELETE FROM shot_media WHERE id = ?', [id]);
    return r.changes > 0;
  },

  updateSort: async (shotId, items) => {
    for (const item of items) {
      await video2Async.run(
        'UPDATE shot_media SET sortOrder = ? WHERE id = ? AND shotId = ?',
        [item.sortOrder, item.id, shotId]
      );
    }
    return true;
  },

  getBySceneId: async (sceneId) => {
    return await video2Async.all(
      `SELECT sm.* FROM shot_media sm
       INNER JOIN videos v ON sm.shotId = v.id
       WHERE v.sceneId = ? AND v.deleted = 0 AND sm.type = 'image'
       ORDER BY sm.id DESC`,
      [sceneId]
    );
  }
};

// ========== settings（系统设置） ==========
const video2Settings = {
  getAll: async () => {
    const rows = await video2Async.all('SELECT * FROM settings');
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
    const row = await video2Async.get('SELECT * FROM settings WHERE key = ?', [key]);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  },

  set: async (key, value) => {
    const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const existing = await video2Async.get('SELECT key FROM settings WHERE key = ?', [key]);
    if (existing) {
      await video2Async.run(
        'UPDATE settings SET value = ?, updatedAt = CURRENT_TIMESTAMP WHERE key = ?',
        [valStr, key]
      );
    } else {
      await video2Async.run(
        'INSERT INTO settings (key, value) VALUES (?, ?)',
        [key, valStr]
      );
    }
    return true;
  },

  bulkSet: async (settings) => {
    for (const key of Object.keys(settings)) {
      await video2Settings.set(key, settings[key]);
    }
    return true;
  }
};

// ========== ai_tasks（AI 异步任务） ==========
const video2AiTasks = {
  create: async (task) => {
    const id = task.id || crypto.randomUUID();
    await video2Async.run(
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
    const row = await video2Async.get('SELECT * FROM ai_tasks WHERE id = ?', [id]);
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
    const r = await video2Async.run('UPDATE ai_tasks SET ' + sets.join(', ') + ' WHERE id = ?', vals);
    return r.changes > 0;
  }
};

// ========== ai_usage_logs（AI 费用统计） ==========
const video2AiUsage = {
  record: async (log) => {
    const r = await video2Async.run(
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

    const totalRow = await video2Async.get(
      `SELECT COALESCE(SUM(estimatedCost), 0) as totalCost FROM ai_usage_logs ${dateFilter}`
    );

    const typeRows = await video2Async.all(
      `SELECT type, COALESCE(SUM(estimatedCost), 0) as cost FROM ai_usage_logs ${dateFilter} GROUP BY type`
    );

    const modelRows = await video2Async.all(
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
const video2TranscodeTasks = {
  create: async (task) => {
    await video2Async.run(
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
    const row = await video2Async.get('SELECT * FROM transcode_tasks WHERE id = ?', [id]);
    if (!row) return null;
    return {
      ...row,
      options: row.options ? JSON.parse(row.options) : null
    };
  },

  getByStatus: async (status) => {
    const rows = await video2Async.all('SELECT * FROM transcode_tasks WHERE status = ?', [status]);
    return rows.map(row => ({
      ...row,
      options: row.options ? JSON.parse(row.options) : null
    }));
  },

  getPendingAndProcessing: async () => {
    const rows = await video2Async.all(
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
    const fields = ['status', 'progress', 'outputUrl', 'outputObject', 'error'];
    fields.forEach(f => {
      if (updates[f] !== undefined) {
        sets.push(f + ' = ?');
        vals.push(updates[f]);
      }
    });
    if (sets.length === 0) return false;
    sets.push('updatedAt = CURRENT_TIMESTAMP');
    vals.push(id);
    const r = await video2Async.run('UPDATE transcode_tasks SET ' + sets.join(', ') + ' WHERE id = ?', vals);
    return r.changes > 0;
  },

  delete: async (id) => {
    const r = await video2Async.run('DELETE FROM transcode_tasks WHERE id = ?', [id]);
    return r.changes > 0;
  }
};

// 辅助：Promise 版重新计算 shotIndex
function recalcShotIndexPromise(projectId) {
  return new Promise(function(resolve) {
    recalcShotIndex(resolve);
  });
}

module.exports = {
  // 以下为企业官网时代遗留模块，已废弃，仅供向后兼容
  // portfolioItems,
  // featuredWorks,
  // homeContent,
  // teamMembers,
  // categoriesDetails,
  // video2 视频片段管理模块（当前使用）
  video2Items,
  video2Projects,
  video2Scenes,
  video2ShotMedia,
  video2Settings,
  video2AiTasks,
  video2AiUsage,
  video2TranscodeTasks,
  db
};
