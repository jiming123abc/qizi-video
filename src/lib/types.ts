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
  shotIndex: number;

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

export interface ModelConfig {
  model: string;
  quality?: string;
  provider: 'geekai' | 'siliconflow';
  cost: 'free' | 'low' | 'mid' | 'mid_high' | 'high';
  supportsImageRef?: boolean;
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
  model_prices: Record<string, any>;
}

export interface AiTask {
  id: string;
  type: 'script_parse' | 'image_gen' | 'video_split';
  status: 'pending' | 'processing' | 'done' | 'error';
  projectId?: number;
  input?: any;
  output?: any;
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
