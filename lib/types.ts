export type Category =
  | 'core_dev'
  | 'communication'
  | 'meeting'
  | 'research'
  | 'admin'
  | 'design'
  | 'ai_tool'
  | 'entertainment'
  | 'idle'
  | 'other';

export interface ActivityRecord {
  id?: number;
  app_name: string;
  window_title: string;
  url: string;
  category: Category;
  start_time: string;
  end_time: string | null;
  duration_seconds: number;
  date: string;
}

export interface CategorySummary {
  category: Category;
  total_seconds: number;
  apps: AppSummary[];
}

export interface AppSummary {
  app_name: string;
  total_seconds: number;
  window_titles: string[];
}

export interface DailySummary {
  date: string;
  total_tracked_seconds: number;
  idle_seconds: number;
  categories: CategorySummary[];
  top_apps: AppSummary[];
}

export interface AutomationSuggestion {
  category: Category;
  task_description: string;
  time_spent_minutes: number;
  automation_type: string;
  agent_name: string;
  estimated_savings_minutes: number;
  priority: 'high' | 'medium' | 'low';
}

export interface AIInsight {
  id?: number;
  date: string;
  report_type: 'daily' | 'weekly';
  summary: string;
  time_breakdown: CategorySummary[];
  efficiency_score: number;
  suggestions: AutomationSuggestion[];
  action_items: string[];
  created_at: string;
}
