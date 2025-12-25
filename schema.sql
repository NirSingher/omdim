-- Omdim Database Schema

-- Assigned users to dailies
CREATE TABLE IF NOT EXISTS participants (
  id SERIAL PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  daily_name TEXT NOT NULL,
  schedule_name TEXT NOT NULL,
  time_override TIME,  -- null = use schedule default
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(slack_user_id, daily_name)
);

-- Daily submissions
CREATE TABLE IF NOT EXISTS submissions (
  id SERIAL PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  daily_name TEXT NOT NULL,
  submitted_at TIMESTAMP DEFAULT NOW(),
  date DATE NOT NULL,  -- the standup date
  yesterday_completed JSONB,  -- ["item1", "item2"]
  yesterday_incomplete JSONB, -- ["item3"]
  unplanned JSONB,            -- ["item4"]
  today_plans JSONB,          -- ["plan1", "plan2"]
  blockers TEXT,
  custom_answers JSONB,       -- {"question": "answer"}
  slack_message_ts TEXT,      -- posted message ID
  UNIQUE(slack_user_id, daily_name, date)
);

-- Track prompt status
CREATE TABLE IF NOT EXISTS prompts (
  id SERIAL PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  daily_name TEXT NOT NULL,
  date DATE NOT NULL,
  last_prompted_at TIMESTAMP,
  submitted BOOLEAN DEFAULT FALSE,
  UNIQUE(slack_user_id, daily_name, date)
);

-- Cached Slack user profiles (reduces API calls)
CREATE TABLE IF NOT EXISTS slack_users (
  slack_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  tz TEXT,
  tz_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Track individual work items for analytics
CREATE TABLE IF NOT EXISTS work_items (
  id SERIAL PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  daily_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, done, dropped, carried
  carry_count INTEGER NOT NULL DEFAULT 0,
  completed_date DATE,
  snoozed_until DATE,  -- null = not snoozed, date = hidden from bottlenecks until this date
  submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL
);

-- Migration for existing databases:
-- ALTER TABLE work_items ADD COLUMN IF NOT EXISTS snoozed_until DATE;

-- Out of Office periods
CREATE TABLE IF NOT EXISTS ooo (
  id SERIAL PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  daily_name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(slack_user_id, daily_name, start_date, end_date)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_participants_daily ON participants(daily_name);
CREATE INDEX IF NOT EXISTS idx_submissions_date ON submissions(date);
CREATE INDEX IF NOT EXISTS idx_submissions_user_daily ON submissions(slack_user_id, daily_name);
CREATE INDEX IF NOT EXISTS idx_prompts_date ON prompts(date);
CREATE INDEX IF NOT EXISTS idx_prompts_user_daily_date ON prompts(slack_user_id, daily_name, date);
CREATE INDEX IF NOT EXISTS idx_slack_users_updated ON slack_users(updated_at);
CREATE INDEX IF NOT EXISTS idx_work_items_user_daily ON work_items(slack_user_id, daily_name);
CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_carry ON work_items(carry_count) WHERE carry_count >= 3;
CREATE INDEX IF NOT EXISTS idx_ooo_lookup ON ooo(slack_user_id, daily_name, start_date, end_date);
