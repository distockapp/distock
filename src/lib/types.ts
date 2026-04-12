export interface DisboxFile {
  id: number;
  parent_id: number | null;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  content?: string; // JSON string array of Discord message IDs
  created_at: string;
  updated_at: string;
  children?: Record<string, DisboxFile>;
  path?: string; // Client-side augmented
}

export interface DisboxTree extends DisboxFile {
  children: Record<string, DisboxFile>;
}
