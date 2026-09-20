-- AlterTable projects: add github_repo
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "github_repo" TEXT;

-- AlterTable environments: add git deployment tracking fields
ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "git_remote_url" TEXT;
ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "git_branch" TEXT DEFAULT 'main';
ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "git_current_commit" TEXT;
ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "git_last_deployed_at" TIMESTAMPTZ;
ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "deploy_webhook_token" TEXT;
