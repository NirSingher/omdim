-- Standup Bot Database Schema

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

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_participants_daily ON participants(daily_name);
CREATE INDEX IF NOT EXISTS idx_submissions_date ON submissions(date);
CREATE INDEX IF NOT EXISTS idx_submissions_user_daily ON submissions(slack_user_id, daily_name);
CREATE INDEX IF NOT EXISTS idx_prompts_date ON prompts(date);
CREATE INDEX IF NOT EXISTS idx_prompts_user_daily_date ON prompts(slack_user_id, daily_name, date);
