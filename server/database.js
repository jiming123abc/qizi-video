const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

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
    // Create tables
    db.run(`
      CREATE TABLE IF NOT EXISTS portfolio_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        tag TEXT,
        shortDesc TEXT,
        fullDesc TEXT,
        img TEXT,
        images TEXT,
        videoUrl TEXT,
        type TEXT DEFAULT 'image',
        color TEXT,
        bgGlow TEXT,
        hidden INTEGER DEFAULT 0,
        sortOrder INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Check if portfolio_items table has the images column, if not add it
    db.all('PRAGMA table_info(portfolio_items)', (err, columns) => {
      if (err) {
        console.error('Error checking portfolio_items columns:', err);
        return;
      }

      const columnNames = columns.map(col => col.name);
      
      if (!columnNames.includes('images')) {
        db.run('ALTER TABLE portfolio_items ADD COLUMN images TEXT', (err) => {
          if (err) {
            console.error('Error adding images column to portfolio_items:', err);
          } else {
            console.log('Added images column to portfolio_items');
          }
        });
      }

      if (!columnNames.includes('hidden')) {
        db.run('ALTER TABLE portfolio_items ADD COLUMN hidden INTEGER DEFAULT 0', (err) => {
          if (err) {
            console.error('Error adding hidden column to portfolio_items:', err);
          } else {
            console.log('Added hidden column to portfolio_items');
          }
        });
      }
    });

    db.run(`
      CREATE TABLE IF NOT EXISTS featured_works (
        id TEXT PRIMARY KEY,
        portfolioId INTEGER NOT NULL,
        sortOrder INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (portfolioId) REFERENCES portfolio_items(id) ON DELETE CASCADE
      )
    `);
// Create home_content table with all required columns
    db.run(`
      CREATE TABLE IF NOT EXISTS home_content (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        heroTitle TEXT,
        heroGradientTitle TEXT,
        heroSubtitle TEXT,
        heroSlides TEXT,
        heroImage TEXT,
        shareTitle TEXT,
        shareDescription TEXT,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, () => {
      // Add missing columns if table already exists
      db.all('PRAGMA table_info(home_content)', (err, columns) => {
        if (err) {
          console.error('Error checking home_content columns:', err);
          return;
        }
        const columnNames = columns.map(col => col.name);
        
        const addColumnIfNotExists = (columnName, columnDef) => {
          if (!columnNames.includes(columnName)) {
            db.run(`ALTER TABLE home_content ADD COLUMN ${columnName} ${columnDef}`, (err) => {
              if (err) {
                console.error(`Error adding ${columnName} column:`, err);
              } else {
                console.log(`Added ${columnName} column to home_content`);
              }
            });
          }
        };
        
        addColumnIfNotExists('heroGradientTitle', 'TEXT');
        addColumnIfNotExists('heroImage', 'TEXT');
        addColumnIfNotExists('shareTitle', 'TEXT');
        addColumnIfNotExists('shareDescription', 'TEXT');
      });
    });
  
    db.run(`
      CREATE TABLE IF NOT EXISTS team_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        role TEXT,
        avatar TEXT,
        bio TEXT,
        fullDesc TEXT,
        sortOrder INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS categories_details (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        coverImage TEXT,
        icon TEXT,
        sortOrder INTEGER DEFAULT 0,
        tag TEXT,
        color TEXT,
        bgGlow TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert initial data with a small delay to ensure tables are ready
    setTimeout(insertInitialData, 500);
  });
}

function insertInitialData() {
  db.get('SELECT COUNT(*) as count FROM portfolio_items', (err, row) => {
    if (err) {
      console.error('Error checking portfolio_items:', err);
      return;
    }
    if (row.count === 0) {
      const initialPortfolio = [
        {
          title: "AI智能广告片",
          category: "AI影像创作",
          tag: "新品",
          shortDesc: "用AI一键生成专业广告视频",
          fullDesc: "探索AI驱动的创意影像生成",
          img: "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?q=80&w=800&auto=format&fit=crop",
          type: "image",
          color: "from-blue-500 to-cyan-600",
          bgGlow: "bg-blue-500/20",
          sortOrder: 0
        }
      ];

      const insertStmt = db.prepare('INSERT INTO portfolio_items (title, category, tag, shortDesc, fullDesc, img, type, color, bgGlow, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      initialPortfolio.forEach((item) => {
        insertStmt.run(item.title, item.category, item.tag, item.shortDesc, item.fullDesc, item.img, item.type, item.color, item.bgGlow, item.sortOrder);
      });
      insertStmt.finalize();
      console.log('Initial portfolio items inserted');
    }
  });



  db.get('SELECT COUNT(*) as count FROM home_content', (err, row) => {
    if (err) {
      console.error('Error checking home_content:', err);
      return;
    }
    if (row.count === 0) {
      const defaultSlides = [
        { id: 1, img: '/images/hero-video.png', label: 'Neural Stream', title: 'Ethereal Segment 01' },
        { id: 2, img: '/images/ai-digital-human.png', label: 'Digital Human', title: 'Avatar Segment 02' },
        { id: 3, img: '/images/ai-film-production.png', label: 'Film Production', title: 'Cinematic Segment 03' }
      ];

      db.run(
        'INSERT INTO home_content (id, heroTitle, heroGradientTitle, heroSubtitle, heroSlides, heroImage, shareTitle, shareDescription) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          1,
          '开启未来的',
          '视界 Matrix',
          '通过 AIGC 重新定义数字影像。我们将人类的情感与神经计算相结合，打造跨越维度的奇迹。',
          JSON.stringify(defaultSlides),
          '/images/hero-home.png',
          '大连柒子文化发展有限公司',
          '诚信立足 创新致远'
        ],
        (err) => {
          if (err) console.error('Error inserting home content:', err);
          else console.log('Initial home content inserted');
        }
      );
    } else {
      console.log('Home content already exists, skipping initialization');
    }
  });

  db.get('SELECT COUNT(*) as count FROM team_members', (err, row) => {
    if (err) {
      console.error('Error checking team_members:', err);
      return;
    }
    if (row.count === 0) {
      const initialTeam = [
        {
          name: "Aris Vane",
          role: "Chief Architect",
          avatar: "/images/neon-avatar.png",
          bio: "Neural network optimization and ethereal render engine lead.",
          fullDesc: "Aris Vane is the visionary behind the Septem Ethereal Engine.",
          sortOrder: 0
        }
      ];

      const insertStmt = db.prepare('INSERT INTO team_members (name, role, avatar, bio, fullDesc, sortOrder) VALUES (?, ?, ?, ?, ?, ?)');
      initialTeam.forEach((member) => {
        insertStmt.run(member.name, member.role, member.avatar, member.bio, member.fullDesc, member.sortOrder);
      });
      insertStmt.finalize();
      console.log('Initial team members inserted');
    }
  });

  db.get('SELECT COUNT(*) as count FROM categories_details', (err, row) => {
    if (err) {
      console.error('Error checking categories_details:', err);
      return;
    }
    if (row.count === 0) {
      const initialCategoriesDetails = [
        {
          id: "cb1",
          name: "AI 数字人定制",
          description: "基于最前沿的神经网络渲染技术",
          coverImage: "/images/ai-digital-human.png",
          icon: "&lt;svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'&gt;&lt;path d='M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z'&gt;&lt;/path&gt;&lt;circle cx='7' cy='13' r='1'&gt;&lt;/circle&gt;&lt;circle cx='17' cy='13' r='1'&gt;&lt;/circle&gt;&lt;/svg&gt;",
          sortOrder: 0,
          tag: "数字人",
          color: "text-secondary",
          bgGlow: "bg-secondary/20"
        },
        {
          id: "cb2",
          name: "电影级 AI 制作",
          description: "重塑视频工业流程",
          coverImage: "/images/ai-film-production.png",
          icon: "&lt;svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'&gt;&lt;rect x='2' y='2' width='20' height='20' rx='2.18' ry='2.18'&gt;&lt;/rect&gt;&lt;line x1='7' y1='2' x2='7' y2='22'&gt;&lt;/line&gt;&lt;line x1='17' y1='2' x2='17' y2='22'&gt;&lt;/line&gt;&lt;line x1='2' y1='12' x2='22' y2='12'&gt;&lt;/line&gt;&lt;line x1='2' y1='7' x2='7' y2='7'&gt;&lt;/line&gt;&lt;line x1='2' y1='17' x2='7' y2='17'&gt;&lt;/line&gt;&lt;line x1='17' y1='17' x2='22' y2='17'&gt;&lt;/line&gt;&lt;line x1='17' y1='7' x2='22' y2='7'&gt;&lt;/line&gt;&lt;/svg&gt;",
          sortOrder: 1,
          tag: "影视制作",
          color: "text-primary",
          bgGlow: "bg-primary/20"
        },
        {
          id: "cb3",
          name: "社交平台短视频 AI",
          description: "深度理解社交媒体流量密码",
          coverImage: "/images/ai-short-video.png",
          icon: "&lt;svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'&gt;&lt;rect x='5' y='2' width='14' height='20' rx='2' ry='2'&gt;&lt;/rect&gt;&lt;path d='M12 18h.01'&gt;&lt;/path&gt;&lt;line x1='7' y1='6' x2='17' y2='6'&gt;&lt;/line&gt;&lt;/svg&gt;",
          sortOrder: 2,
          tag: "短视频",
          color: "text-tertiary",
          bgGlow: "bg-tertiary/20"
        },
        {
          id: "cb4",
          name: "神经网络技术栈",
          description: "自主研发的底层引擎",
          coverImage: "/images/ai-tech-stack.png",
          icon: "&lt;svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'&gt;&lt;circle cx='12' cy='12' r='10'&gt;&lt;/circle&gt;&lt;circle cx='12' cy='12' r='6'&gt;&lt;/circle&gt;&lt;circle cx='12' cy='12' r='2'&gt;&lt;/circle&gt;&lt;/svg&gt;",
          sortOrder: 3,
          tag: "技术栈",
          color: "text-secondary-fixed-dim",
          bgGlow: "bg-secondary/20"
        }
      ];

      const insertStmt = db.prepare('INSERT INTO categories_details (id, name, description, coverImage, icon, sortOrder, tag, color, bgGlow) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      initialCategoriesDetails.forEach((cat) => {
        insertStmt.run(cat.id, cat.name, cat.description, cat.coverImage, cat.icon, cat.sortOrder, cat.tag, cat.color, cat.bgGlow);
      });
      insertStmt.finalize();
      console.log('Initial categories details inserted');
    }
  });
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

    // 6. 迁移：sortOrder 回填 + 默认项目创建
    //    用最后一条 run() 的回调确保所有上述 DDL 已完成
    video2Db.get('SELECT 1 as ok', function(_err, _row) {
      // 先确保 sortOrder 有值
      video2Db.get('SELECT COUNT(*) as cnt FROM videos WHERE sortOrder IS NULL', function(err2, r) {
        if (!err2 && r && r.cnt > 0) {
          fillSortOrder();
        }
        // 迁移默认项目
        migrateDefaultProject(function() {
          video2DbSetReady();
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
const video2Items = {
  getAll: async () => {
    // 向后兼容：返回全部非删除视频
    return await video2Async.all(
      'SELECT * FROM videos WHERE deleted = 0 ORDER BY sortOrder ASC, id ASC'
    );
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
    return await video2Async.all(sql, params);
  },
  getByStatus: async (status) => {
    return await video2Async.all(
      'SELECT * FROM videos WHERE status = ? AND deleted = 0 ORDER BY sortOrder ASC, id ASC',
      [status]
    );
  },
  getStats: async (projectId) => {
    const whereProject = projectId !== undefined ? ' AND projectId = ?' : '';
    const params = projectId !== undefined ? [projectId] : [];
    const all = await video2Async.all(
      'SELECT status, COUNT(*) as cnt FROM videos WHERE deleted = 0' + whereProject + ' GROUP BY status',
      params
    );
    const map = { pending: 0, done: 0, total: 0, trash: 0 };
    all.forEach(r => {
      map[r.status] = r.cnt;
      map.total += r.cnt;
    });
    const trash = await video2Async.get(
      'SELECT COUNT(*) as cnt FROM videos WHERE deleted = 1' + whereProject,
      params
    );
    map.trash = trash ? trash.cnt : 0;
    return map;
  },
  getById: async (id) => {
    return await video2Async.get('SELECT * FROM videos WHERE id = ?', [id]);
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
    return { id: result.lastID, sortOrder: nextSort, ...item };
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
  }
};

module.exports = {
  portfolioItems,
  featuredWorks,
  homeContent,
  teamMembers,
  categoriesDetails,
  video2Items,
  video2Projects,
  video2Scenes,
  db
};
