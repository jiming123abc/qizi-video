// 分镜数据结构
// 注意：url、filename、type、size、duration 为旧版单媒体时代遗留字段
// 新代码应优先使用 media 数组中的 ShotMedia 数据
export interface Shot {
  id: number;
  // ── 遗留单媒体字段（建议优先使用 media 数组）──
  title: string;
  filename: string;
  url: string;
  type: 'image' | 'video';
  size: number;
  duration?: number;
  // ── 通用字段 ──
  status: 'pending' | 'done';
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deleted?: number;
  deletedAt?: string;
  projectId?: number;
  sceneId?: number;
  shotNo?: string;
  coverUrl?: string;
  isCover?: number;
  reference?: boolean;

  sceneContent: string;
  actors: string;
  props: string;
  costume: string;
  location: string;
  focalLength: string;
  narration: string;
  cameraMovement: string;
  shotType: string;
  shotAngle: string;
  lighting: string;
  notes: string;
  estimatedDuration: string;
  aiImagePrompt: string;
  aiStylePrompt: string;
  mergedFrom: number[];

  media: ShotMedia[];
}

export interface ShotMedia {
  id: number;
  shotId: number;
  url: string;
  type: 'image' | 'video';
  filename: string;
  size: number;
  duration?: number;
  startTime?: number;
  sortOrder: number;
  source: 'upload' | 'ai_generated' | 'video_split';
  createdAt: string;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  coverUrl?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  videoCount?: number;
  shotCount?: number;
  totalSize?: number;
}

export interface Scene {
  id: number;
  projectId: number;
  name: string;
  sortOrder: number;
  scrollPosition?: number;
  createdAt: string;
  updatedAt: string;
  videoCount?: number;
}

export interface AiPlatform {
  id: string;              // 唯一标识，如 'geekai', 'siliconflow', 'custom_xxx'
  name: string;            // 显示名称，如 'GeekAI', '硅基流动'
  baseUrl: string;         // API base URL，如 'https://geekai.co/api/v1'
  apiKey: string;          // API Key（保存后脱敏，编辑时明文）
  docsUrl?: string;        // 技术文档链接
  builtIn?: boolean;       // 是否内置平台
}

export interface ModelConfig {
  model: string;
  quality?: string;
  provider: string;  // 引用 AiPlatform.id
  cost: 'free' | 'low' | 'mid' | 'mid_high' | 'high';
  supportsImageRef?: boolean;
  supportsVision?: boolean;  // 是否支持视觉输入（用于AI分析）
}

export interface Settings {
  llm_provider: string;
  llm_model: string;
  llm_fallback_chain: ModelConfig[];
  image_provider: string;
  image_model: string;
  image_quality: string;
  image_fallback_chain: ModelConfig[];
  geekai_api_key: string;
  siliconflow_api_key: string;
  default_image_size: string;
  export_include_images: boolean;
  export_format: string;
  video_target_bitrate_1080p: number;
  video_target_bitrate_720p: number;
  video_target_bitrate_480p: number;
  image_compress_threshold_kb: number;
  model_prices: Record<string, ModelPrice>;
  ai_platforms: AiPlatform[];           // AI平台统一管理
  analyze_llm_provider: string;         // AI分析使用的平台ID
  analyze_llm_model: string;            // AI分析使用的模型名
}

// any-audit：AI 任务输出（不同 task type 输出结构不同，shots 结构因任务而异）
export interface AiTaskOutput {
  type?: string;
  content?: string;
  shots?: unknown[];
  imageUrl?: string;
  uploaded?: boolean;
  estimatedCost?: number;
  sceneName?: string;
  sceneId?: number | null;
  media?: { url?: string };
}

export interface AiTask {
  id: string;
  type: 'script_parse' | 'image_gen' | 'video_split' | 'analyze_shot';
  status: 'pending' | 'processing' | 'done' | 'error';
  projectId?: number;
  input?: unknown;
  output?: AiTaskOutput;
  error?: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiUsageStats {
  totalCost: number;
  breakdown: {
    chat: number;
    image: number;
    video_split: number;
  };
  modelStats: Array<{
    model: string;
    provider: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    imageCount: number;
    cost: number;
  }>;
}

export interface DigitalAsset {
  id: number;
  projectId: number;
  type: 'actor' | 'prop' | 'scene';
  name: string;
  imagePrompt: string;
  imageUrl: string;
  createdAt: string;
  images?: DigitalAssetImage[];
}

export interface DigitalAssetImage {
  id: number;
  assetId: number;
  imageUrl: string;
  sortOrder: number;
  createdAt: string;
}

// P3-22：AI 生图历史记录（持久化到 ai_generated_images 表）
export interface AiGeneratedImage {
  id: number;
  ownerType: 'shot' | 'asset';
  ownerId: number;
  url: string;
  prompt: string;
  model: string;
  provider: string;
  size: string;
  fileSize: number;
  sortOrder: number;
  createdAt: string;
}

// P3-24：统一的参考图（来自数字资产或用户上传），供 AI 生图使用
export interface RefImage {
  id: string;          // 唯一 key
  url: string;         // 图片 URL（OSS）
  source: 'asset' | 'upload';  // 来源
  assetId?: number;    // 来自资产时记录
  assetName?: string;  // 用于 @引用 显示
  assetType?: 'actor' | 'prop' | 'scene';
}

// any-audit：挂起上传任务（ProjectListPage pendingUploadRef）
export interface PendingUpload {
  file: File;
  index: number;
  total: number;
  successCount: number;
  project: Project;
  usage?: 'project-reference' | 'project-cover' | 'project-video' | string;
}

// any-audit：场次统计（StoryboardPage scene-stats API 响应）
export interface SceneStat {
  id: number | null;
  done: number;
  total: number;
}

// any-audit：模型价格（types.ts model_prices 字段）
// 后端 server/database.js: { 'model-name': { input, output } }
export interface ModelPrice {
  input: number;
  output: number;
}

// any-audit：视频分割片段（VideoSplitDialog onSplit 回调 + result 数组）
export interface SplitShot {
  startTime: number;
  endTime: number;
  index: number;
}

// any-audit：AI 分镜任务输出（AIScriptDialog outputShots.map）
export interface AiScriptShot {
  shotType?: string;
  title?: string;
  sceneContent?: string;
  hasShotCut?: boolean;
  isStockOrEffect?: boolean;
  actors?: string;
  props?: string;
  costume?: string;
  location?: string;
  focalLength?: string;
  narration?: string;
  cameraMovement?: string;
  shotAngle?: string;
  lighting?: string;
  notes?: string;
  estimatedDuration?: string;
  aiImagePrompt?: string;
  sceneName?: string;
  sceneId?: number | null;
}

// any-audit：视频上传任务结果（ossUtils pollTaskStatus 返回值）
// 后端 server/index.js: { url, compressed, fileName, ossKey, fileSize }
export interface UploadTaskResult {
  url: string;
  compressed?: boolean;
  compressionFailed?: boolean;
  originalSizeKB?: number;
  compressedSizeKB?: number;
  fileName?: string;
  ossKey?: string;
  fileSize?: number;
}
