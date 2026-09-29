-- 認証主体の判定・RLS・閲覧用ビュー（10.3）
-- 読み取りは RLS で profile 境界に絞る。書き込み権限はクライアントへ一切付与しない。

-- ---------------------------------------------------------------------------
-- 認証主体ヘルパー
-- ---------------------------------------------------------------------------
create function private.is_app_user() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_users u where u.user_id = (select auth.uid()));
$$;

create function private.owns_profile(p_profile_id text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.app_users u on u.user_id = p.owner_id
    where p.id = p_profile_id and p.owner_id = (select auth.uid())
  );
$$;

-- レビューworker（detector/reviewer/notification_planner）として profile を扱えるか
create function private.worker_serves_profile(p_profile_id text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workers w
    join public.worker_profiles wp on wp.worker_id = w.id
    where w.auth_user_id = (select auth.uid())
      and wp.profile_id = p_profile_id
      and w.roles && array['detector', 'reviewer', 'notification_planner']::text[]
  );
$$;

create function private.can_read_profile(p_profile_id text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.owns_profile(p_profile_id) or private.worker_serves_profile(p_profile_id);
$$;

create function private.current_worker_id() returns text
language sql stable security definer
set search_path = ''
as $$
  select w.id from public.workers w where w.auth_user_id = (select auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- 権限: クライアントには SELECT のみ（必要なテーブルだけ）
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant usage on schema private to authenticated;
revoke all on all functions in schema private from public, anon;
grant execute on function
  private.is_app_user(),
  private.owns_profile(text),
  private.worker_serves_profile(text),
  private.can_read_profile(text),
  private.current_worker_id()
to authenticated;

grant select on
  public.app_settings,
  public.app_users,
  public.usage_pools,
  public.workers,
  public.profiles,
  public.worker_profiles,
  public.pull_requests,
  public.review_tasks,
  public.review_request_signals,
  public.review_jobs,
  public.review_attempts,
  public.review_results,
  public.task_operations,
  public.outbox_events,
  public.profile_sync_states,
  public.github_rate_limits
to authenticated;

alter table public.app_settings enable row level security;
alter table public.app_users enable row level security;
alter table public.usage_pools enable row level security;
alter table public.workers enable row level security;
alter table public.profiles enable row level security;
alter table public.worker_profiles enable row level security;
alter table public.pull_requests enable row level security;
alter table public.review_tasks enable row level security;
alter table public.review_request_signals enable row level security;
alter table public.review_jobs enable row level security;
alter table public.review_attempts enable row level security;
alter table public.review_results enable row level security;
alter table public.task_operations enable row level security;
alter table public.outbox_events enable row level security;
alter table public.profile_sync_states enable row level security;
alter table public.github_rate_limits enable row level security;

create policy app_settings_read on public.app_settings for select to authenticated
  using (private.is_app_user() or private.current_worker_id() is not null);

create policy app_users_read on public.app_users for select to authenticated
  using (user_id = (select auth.uid()));

create policy usage_pools_read on public.usage_pools for select to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.usage_pool_id = usage_pools.id and private.worker_serves_profile(p.id)
    )
  );

create policy workers_read on public.workers for select to authenticated
  using (owner_id = (select auth.uid()) or auth_user_id = (select auth.uid()));

create policy profiles_read on public.profiles for select to authenticated
  using (private.can_read_profile(id));

create policy worker_profiles_read on public.worker_profiles for select to authenticated
  using (private.can_read_profile(profile_id) or worker_id = private.current_worker_id());

create policy pull_requests_read on public.pull_requests for select to authenticated
  using (private.can_read_profile(profile_id));

create policy review_tasks_read on public.review_tasks for select to authenticated
  using (private.can_read_profile(profile_id));

create policy review_request_signals_read on public.review_request_signals for select to authenticated
  using (
    exists (
      select 1 from public.review_tasks t
      where t.id = review_request_signals.review_task_id and private.can_read_profile(t.profile_id)
    )
  );

create policy review_jobs_read on public.review_jobs for select to authenticated
  using (private.can_read_profile(profile_id));

create policy review_attempts_read on public.review_attempts for select to authenticated
  using (
    exists (
      select 1 from public.review_jobs j
      where j.id = review_attempts.job_id and private.can_read_profile(j.profile_id)
    )
  );

create policy review_results_read on public.review_results for select to authenticated
  using (private.can_read_profile(profile_id));

create policy task_operations_read on public.task_operations for select to authenticated
  using (actor_id = (select auth.uid()) or (profile_id is not null and private.owns_profile(profile_id)));

create policy outbox_events_read on public.outbox_events for select to authenticated
  using (
    private.can_read_profile(profile_id)
    or destination_worker_id = private.current_worker_id()
  );

create policy profile_sync_states_read on public.profile_sync_states for select to authenticated
  using (private.can_read_profile(profile_id));

create policy github_rate_limits_read on public.github_rate_limits for select to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1 from public.workers w
      where w.auth_user_id = (select auth.uid()) and w.owner_id = github_rate_limits.owner_id
    )
  );

-- ---------------------------------------------------------------------------
-- 表示状態（11.4）
-- GitHub状態・ジョブ状態・現在結果・確認済み対象・対応状態から導出する。
-- ---------------------------------------------------------------------------
create view public.task_overview
with (security_invoker = true)
as
select
  t.id as task_id,
  t.profile_id,
  p.name as profile_name,
  pr.id as pull_request_id,
  pr.github_host,
  pr.repository_id,
  pr.repository_full_name,
  pr.pr_number,
  pr.url as pr_url,
  pr.title as pr_title,
  pr.author_login as pr_author_login,
  pr.state as pr_state,
  pr.draft as pr_draft,
  pr.head_sha,
  pr.base_sha,
  pr.sync_status,
  pr.sync_error,
  pr.last_synced_at,
  t.reviewer_login,
  t.request_generation,
  t.request_state,
  t.human_state,
  t.done_reason,
  t.done_source,
  t.done_at,
  t.snoozed_until,
  t.revision,
  t.current_result_id,
  r.head_sha as result_head_sha,
  r.review_config_version as result_config_version,
  r.summary as result_summary,
  r.findings_count as result_findings_count,
  r.max_severity as result_max_severity,
  r.quality_status as result_quality_status,
  r.body_deleted_at as result_body_deleted_at,
  r.created_at as result_created_at,
  coalesce(
    r.id is not null and r.head_sha = pr.head_sha and r.review_config_version = p.review_config_version,
    false
  ) as result_is_current,
  coalesce(
    r.id is not null and (r.base_sha is distinct from pr.base_sha or r.pr_body_hash is distinct from pr.body_hash),
    false
  ) as premise_changed,
  t.acked_result_id,
  t.acked_generation,
  coalesce(t.acked_result_id = t.current_result_id and t.acked_generation = t.request_generation, false) as is_acked,
  j.id as current_job_id,
  j.status as current_job_status,
  j.error_class as current_job_error_class,
  j.not_before as current_job_not_before,
  p.paused as profile_paused,
  p.enabled as profile_enabled,
  case
    when t.human_state = 'done' then 'done'
    when pr.state <> 'open' or t.request_state = 'removed' then 'inactive'
    when pr.sync_status <> 'ok' or t.request_state = 'unknown' then 'waiting'
    when j.status in ('blocked', 'unknown', 'failed') then 'waiting'
    when r.id is not null and r.head_sha = pr.head_sha and r.review_config_version = p.review_config_version then
      case
        when t.acked_result_id = t.current_result_id and t.acked_generation = t.request_generation then 'in_review'
        else 'awaiting_ack'
      end
    when pr.draft or p.paused or not p.enabled then 'waiting'
    else 'preparing'
  end as display_state,
  case
    when t.human_state = 'done' or pr.state <> 'open' or t.request_state = 'removed' then null
    when pr.sync_status <> 'ok' then 'github_' || pr.sync_status
    when t.request_state = 'unknown' then 'github_request_unknown'
    when j.status in ('blocked', 'unknown', 'failed') then 'job_' || j.status || coalesce(':' || j.error_class, '')
    when r.id is not null and r.head_sha = pr.head_sha and r.review_config_version = p.review_config_version then null
    when pr.draft then 'pr_draft'
    when p.paused then 'profile_paused'
    when not p.enabled then 'profile_disabled'
    else null
  end as waiting_reason,
  -- 一覧の初期並び順（11.2）: 未確認の最新結果 → 対応中 → 終了・対応不要
  case
    when t.human_state = 'done' or pr.state <> 'open' or t.request_state = 'removed' then 2
    when r.id is not null and r.head_sha = pr.head_sha and r.review_config_version = p.review_config_version
         and not coalesce(t.acked_result_id = t.current_result_id and t.acked_generation = t.request_generation, false)
         and pr.sync_status = 'ok' and t.request_state = 'requested'
      then 0
    else 1
  end as sort_group,
  greatest(t.updated_at, pr.updated_at, coalesce(r.created_at, t.updated_at)) as updated_at
from public.review_tasks t
join public.pull_requests pr on pr.id = t.pull_request_id
join public.profiles p on p.id = t.profile_id
left join public.review_results r on r.id = t.current_result_id
left join lateral (
  select j2.*
  from public.review_jobs j2
  where j2.review_task_id = t.id
    and j2.head_sha = pr.head_sha
    and j2.review_config_version = p.review_config_version
  order by j2.manual_generation desc
  limit 1
) j on true;

grant select on public.task_overview to authenticated;
