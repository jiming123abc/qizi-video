import type { AiTaskOutput } from './types';

export interface AiTaskUpdate {
  id: string;
  type: string;
  status: string;
  progress: number;
  error?: string;
  output?: AiTaskOutput;
  createdAt: string;
  updatedAt: string;
}
