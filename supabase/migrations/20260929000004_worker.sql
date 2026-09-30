-- レビューworker用のDB関数（6章・7章・9章）
-- workerの認証主体と許可プロファイルをDB側で検証する。worker自身が名乗ったIDだけを信用しない。

create function private.require_worker(p_worker_id text, p_role text) returns public.workers
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_worker public.workers;
begin
  select * into v_worker from public.workers w
  where w.id = p_worker_id and w.auth_user_id = (select auth.uid());
  if not found or not (p_role = any (v_worker.roles)) then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  return v_worker;
end;
$$;

create function private.require_worker_profile(p_worker public.workers, p_profile_id text)
returns public.profiles
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  select p.* into v_profile
  from public.profiles p
  join public.worker_profiles wp on wp.profile_id = p.id and wp.worker_id = p_worker.id
  where p.id = p_profile_id and p.owner_id = p_worker.owner_id;
  if not found then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  return v_profile;
end;
$$;

-- 期限切れの実行権を結果不明へ移す（9.3）。並列枠は照合まで解放しない。
create function private.expire_leases() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.review_jobs
  set status = 'unknown',
      error_class = 'lease_expired',
      error_message = 'worker lease expired before the result was recorded',
      updated_at = now()
  where status = 'running' and lease_expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 生存通知
-- ---------------------------------------------------------------------------
create function public.worker_heartbeat(p_worker_id text, p_capabilities jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers;
begin
  select * into v_worker from public.workers w
  where w.id = p_worker_id and w.auth_user_id = (select auth.uid());
  if not found then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  update public.workers
  set last_seen_at = now(),
      capabilities = coalesce(p_capabilities, capabilities),
      updated_at = now()
  where id = v_worker.id;
  return jsonb_build_object(
    'worker_id', v_worker.id,
    'roles', to_jsonb(v_worker.roles),
    'profiles', coalesce((select jsonb_agg(wp.profile_id order by wp.profile_id)
                          from public.worker_profiles wp where wp.worker_id = v_worker.id), '[]'::jsonb),
    'now', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 対象レビュアーのGitHubユーザーIDを記録する（5.5）
-- ---------------------------------------------------------------------------
create function public.worker_set_reviewer_identity(p_worker_id text, p_profile_id text, p_github_id text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'detector');
  v_profile public.profiles := private.require_worker_profile(v_worker, p_profile_id);
begin
  if p_github_id is null or p_github_id !~ '^[0-9]+$' then
    raise exception 'kakari: invalid github id' using errcode = '22023';
  end if;
  if v_profile.reviewer_github_id is not null and v_profile.reviewer_github_id <> p_github_id then
    -- login の付け替えなどで別ユーザーになった。自動で履歴を移さない。
    raise exception 'kakari: reviewer github id changed (% -> %)', v_profile.reviewer_github_id, p_github_id
      using errcode = '22023';
  end if;
  update public.profiles set reviewer_github_id = p_github_id, updated_at = now() where id = v_profile.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 新規検出の結果を記録する
-- ---------------------------------------------------------------------------
create function public.worker_record_discovery(
  p_worker_id text,
  p_profile_id text,
  p_status text,
  p_error text,
  p_incomplete_scopes jsonb
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'detector');
  v_profile public.profiles := private.require_worker_profile(v_worker, p_profile_id);
begin
  insert into public.profile_sync_states as s (
    profile_id, last_discovery_at, last_discovery_success_at, discovery_status, discovery_error, incomplete_scopes, updated_at
  ) values (
    v_profile.id, now(), case when p_status = 'ok' then now() end, p_status, p_error,
    coalesce(p_incomplete_scopes, '[]'::jsonb), now()
  )
  on conflict (profile_id) do update set
    last_discovery_at = excluded.last_discovery_at,
    last_discovery_success_at = coalesce(excluded.last_discovery_success_at, s.last_discovery_success_at),
    discovery_status = excluded.discovery_status,
    discovery_error = excluded.discovery_error,
    incomplete_scopes = excluded.incomplete_scopes,
    updated_at = now();
end;
$$;

create function public.worker_record_rate_limits(p_worker_id text, p_rows jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers;
  v_row jsonb;
begin
  select * into v_worker from public.workers w
  where w.id = p_worker_id and w.auth_user_id = (select auth.uid())
    and w.roles && array['detector', 'reviewer', 'notification_planner']::text[];
  if not found then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    insert into public.github_rate_limits as g (
      owner_id, github_host, principal, resource, limit_value, remaining, reset_at, blocked_until, wait_reason, observed_at
    ) values (
      v_worker.owner_id, v_row ->> 'github_host', v_row ->> 'principal', v_row ->> 'resource',
      (v_row ->> 'limit')::integer, (v_row ->> 'remaining')::integer, (v_row ->> 'reset_at')::timestamptz,
      (v_row ->> 'blocked_until')::timestamptz, v_row ->> 'wait_reason', now()
    )
    on conflict (owner_id, github_host, principal, resource) do update set
      limit_value = excluded.limit_value,
      remaining = excluded.remaining,
      reset_at = excluded.reset_at,
      blocked_until = excluded.blocked_until,
      wait_reason = excluded.wait_reason,
      observed_at = now();
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- PRの状態とレビュー依頼の観測を記録する（6.3・6.4・7.4・12.3）
--
-- p_pr: github_host, repository_id, repository_full_name, pr_number, url, title, author_login,
--       head_sha, head_ref, base_sha, base_ref, body_hash, state, draft
-- p_request: reviewer_github_id, reviewer_login,
--       requested (true/false/null=不明),
--       request_event { id, created_at } | null   … GitHubのレビュー依頼イベント
--       review { id, submitted_at, state, commit_id } | null … 依頼後の本人の提出済みレビュー
-- ---------------------------------------------------------------------------
create function public.worker_sync_pull_request(
  p_worker_id text,
  p_profile_id text,
  p_pr jsonb,
  p_request jsonb
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'detector');
  v_profile public.profiles := private.require_worker_profile(v_worker, p_profile_id);
  v_settings public.app_settings;
  v_pr public.pull_requests;
  v_old_head text;
  v_task public.review_tasks;
  v_task_created boolean := false;
  v_generation_changed boolean := false;
  v_human_changed boolean := false;
  v_requested boolean := (p_request ->> 'requested')::boolean;
  v_event_id text := p_request #>> '{request_event,id}';
  v_event_at timestamptz := (p_request #>> '{request_event,created_at}')::timestamptz;
  v_review_id text := p_request #>> '{review,id}';
  v_observation text;
  v_last_event_at timestamptz;
  v_is_new_request boolean := false;
  v_eligible boolean;
  v_job_id uuid;
  v_job_created boolean := false;
  v_not_before timestamptz;
begin
  if v_profile.reviewer_github_id is null
     or v_profile.reviewer_github_id <> (p_request ->> 'reviewer_github_id') then
    raise exception 'kakari: reviewer does not match profile' using errcode = '22023';
  end if;
  if (p_pr ->> 'github_host') <> v_profile.github_host then
    raise exception 'kakari: github host does not match profile' using errcode = '22023';
  end if;
  if (p_pr ->> 'state') not in ('open', 'closed', 'merged') or coalesce(p_pr ->> 'head_sha', '') !~ '^[0-9a-f]{40,64}$' then
    raise exception 'kakari: invalid pull request payload' using errcode = '22023';
  end if;

  select * into v_settings from public.app_settings where id;

  select pr.head_sha into v_old_head
  from public.pull_requests pr
  where pr.profile_id = v_profile.id and pr.github_host = p_pr ->> 'github_host'
    and pr.repository_id = p_pr ->> 'repository_id' and pr.pr_number = (p_pr ->> 'pr_number')::integer;

  insert into public.pull_requests as pr (
    profile_id, github_host, repository_id, repository_full_name, pr_number, url, title, author_login,
    head_sha, head_ref, base_sha, base_ref, body_hash, state, draft, head_changed_at,
    sync_status, sync_error, last_synced_at, last_sync_attempt_at
  ) values (
    v_profile.id, p_pr ->> 'github_host', p_pr ->> 'repository_id', p_pr ->> 'repository_full_name',
    (p_pr ->> 'pr_number')::integer, p_pr ->> 'url', coalesce(p_pr ->> 'title', ''), p_pr ->> 'author_login',
    p_pr ->> 'head_sha', p_pr ->> 'head_ref', p_pr ->> 'base_sha', p_pr ->> 'base_ref', p_pr ->> 'body_hash',
    p_pr ->> 'state', coalesce((p_pr ->> 'draft')::boolean, false), now(),
    'ok', null, now(), now()
  )
  on conflict (profile_id, github_host, repository_id, pr_number) do update set
    repository_full_name = excluded.repository_full_name,
    url = excluded.url,
    title = excluded.title,
    author_login = excluded.author_login,
    head_sha = excluded.head_sha,
    head_ref = excluded.head_ref,
    base_sha = excluded.base_sha,
    base_ref = excluded.base_ref,
    body_hash = excluded.body_hash,
    state = excluded.state,
    draft = excluded.draft,
    head_changed_at = case when pr.head_sha is distinct from excluded.head_sha then now() else pr.head_changed_at end,
    sync_status = 'ok',
    sync_error = null,
    last_synced_at = now(),
    last_sync_attempt_at = now(),
    updated_at = now()
  returning * into v_pr;

  select * into v_task from public.review_tasks t
  where t.pull_request_id = v_pr.id and t.reviewer_github_id = p_request ->> 'reviewer_github_id'
  for update;

  if not found then
    -- Reviewer割当がない、または状態不明なら項目を作らない（AC-36）
    if v_requested is not true or v_pr.state <> 'open' then
      return jsonb_build_object('pull_request_id', v_pr.id, 'task_id', null, 'task_created', false);
    end if;
    insert into public.review_tasks (pull_request_id, profile_id, reviewer_github_id, reviewer_login)
    values (v_pr.id, v_profile.id, p_request ->> 'reviewer_github_id', p_request ->> 'reviewer_login')
    returning * into v_task;
    v_task_created := true;
    v_observation := coalesce('event:' || v_event_id, 'poll:' || v_task.id || ':1');
    insert into public.review_request_signals (
      review_task_id, github_observation_id, state, event_at, evidence, request_generation
    ) values (
      v_task.id, v_observation, 'requested', v_event_at, coalesce(p_request -> 'request_event', '{}'::jsonb), 1
    ) on conflict do nothing;
  else
    update public.review_tasks set reviewer_login = p_request ->> 'reviewer_login'
    where id = v_task.id and reviewer_login is distinct from p_request ->> 'reviewer_login';

    if v_requested is true then
      -- 再依頼の判定（6.4）: 新しい依頼イベント、または解除・対応終了（GitHub上のレビュー提出）後の依頼
      if v_event_id is not null then
        select max(s.event_at) into v_last_event_at
        from public.review_request_signals s
        where s.review_task_id = v_task.id and s.state = 'requested';
        v_is_new_request := not exists (
          select 1 from public.review_request_signals s
          where s.review_task_id = v_task.id and s.github_observation_id = 'event:' || v_event_id
        ) and (v_last_event_at is null or v_event_at > v_last_event_at)
          and (v_task.request_state = 'removed' or v_task.human_state = 'done' or v_last_event_at is not null);
      else
        v_is_new_request := v_task.request_state = 'removed'
          or (v_task.human_state = 'done' and v_task.done_source = 'github_review');
      end if;

      if v_is_new_request then
        v_observation := coalesce('event:' || v_event_id, 'poll:' || v_task.id || ':' || (v_task.request_generation + 1));
        update public.review_tasks
        set request_generation = request_generation + 1,
            request_state = 'requested',
            human_state = 'open',
            done_generation = null,
            done_reason = null,
            done_source = null,
            done_at = null,
            revision = revision + 1,
            updated_at = now()
        where id = v_task.id
        returning * into v_task;
        v_generation_changed := true;
        insert into public.review_request_signals (
          review_task_id, github_observation_id, state, event_at, evidence, request_generation
        ) values (
          v_task.id, v_observation, 'requested', v_event_at, coalesce(p_request -> 'request_event', '{}'::jsonb),
          v_task.request_generation
        ) on conflict do nothing;
      else
        -- 現在の依頼世代に属する依頼イベントとして記録し、次回以降の再依頼判定の基準にする
        if v_event_id is not null then
          insert into public.review_request_signals (
            review_task_id, github_observation_id, state, event_at, evidence, request_generation
          ) values (
            v_task.id, 'event:' || v_event_id, 'requested', v_event_at, p_request -> 'request_event',
            v_task.request_generation
          ) on conflict do nothing;
        end if;
        if v_task.request_state <> 'requested' then
          update public.review_tasks set request_state = 'requested', updated_at = now()
          where id = v_task.id returning * into v_task;
        end if;
      end if;
    elsif v_requested is false then
      -- 依頼が外れた: 本人がレビューを提出していれば対応終了、そうでなければ依頼解除（12.3）
      if v_review_id is not null then
        insert into public.review_request_signals (
          review_task_id, github_observation_id, state, event_at, evidence, request_generation
        ) values (
          v_task.id, 'review:' || v_review_id, 'reviewed', (p_request #>> '{review,submitted_at}')::timestamptz,
          p_request -> 'review', v_task.request_generation
        ) on conflict do nothing;
        if v_task.human_state <> 'done' then
          update public.review_tasks
          set human_state = 'done',
              done_generation = request_generation,
              done_reason = 'github_review_submitted',
              done_source = 'github_review',
              done_at = now(),
              request_state = 'removed',
              revision = revision + 1,
              updated_at = now()
          where id = v_task.id
          returning * into v_task;
          v_human_changed := true;
        elsif v_task.request_state <> 'removed' then
          update public.review_tasks set request_state = 'removed', updated_at = now()
          where id = v_task.id returning * into v_task;
        end if;
      elsif v_task.request_state <> 'removed' then
        insert into public.review_request_signals (
          review_task_id, github_observation_id, state, evidence, request_generation
        ) values (
          v_task.id, 'removed:' || v_task.request_generation, 'removed', '{}'::jsonb, v_task.request_generation
        ) on conflict do nothing;
        update public.review_tasks set request_state = 'removed', updated_at = now()
        where id = v_task.id returning * into v_task;
      end if;
    else
      if v_task.request_state = 'requested' then
        update public.review_tasks set request_state = 'unknown', updated_at = now()
        where id = v_task.id returning * into v_task;
      end if;
    end if;
  end if;

  -- ジョブ管理（7.1・7.4）
  v_eligible := v_profile.enabled and not v_profile.paused
    and v_task.human_state = 'open' and v_task.request_state = 'requested'
    and v_pr.state = 'open' and not v_pr.draft;

  -- 新しいhead・設定のジョブで置き換えられた未開始ジョブを取り下げる
  update public.review_jobs
  set status = 'superseded', updated_at = now(), finished_at = now()
  where review_task_id = v_task.id and status = 'queued'
    and (head_sha <> v_pr.head_sha or review_config_version <> v_profile.review_config_version);

  if v_eligible then
    if not exists (
      select 1 from public.review_jobs j
      where j.review_task_id = v_task.id and j.head_sha = v_pr.head_sha
        and j.review_config_version = v_profile.review_config_version and j.status = 'succeeded'
    ) then
      v_not_before := coalesce(v_pr.head_changed_at, now()) + make_interval(secs => v_settings.debounce_seconds);
      insert into public.review_jobs (
        review_task_id, profile_id, head_sha, base_sha, review_config_version, provider, manual_generation,
        status, not_before
      ) values (
        v_task.id, v_profile.id, v_pr.head_sha, v_pr.base_sha, v_profile.review_config_version,
        v_profile.provider, 0, 'queued', v_not_before
      )
      on conflict (review_task_id, head_sha, review_config_version, manual_generation) do nothing
      returning id into v_job_id;
      v_job_created := v_job_id is not null;

      if not v_job_created then
        -- 取り下げ・取消済みのジョブだけを実行待ちへ戻す。running/blocked/unknown/failed は戻さない。
        update public.review_jobs
        set status = 'queued', not_before = greatest(v_not_before, now()), error_class = null,
            error_message = null, finished_at = null, updated_at = now()
        where review_task_id = v_task.id and head_sha = v_pr.head_sha
          and review_config_version = v_profile.review_config_version and manual_generation = 0
          and status in ('superseded', 'cancelled')
        returning id into v_job_id;
      end if;
    end if;
  else
    update public.review_jobs
    set status = 'cancelled',
        error_class = case
          when v_pr.state <> 'open' then 'pr_' || v_pr.state
          when v_task.human_state = 'done' then 'task_done'
          when v_task.request_state = 'removed' then 'request_removed'
          when v_pr.draft then 'pr_draft'
          else 'not_eligible'
        end,
        updated_at = now(),
        finished_at = now()
    where review_task_id = v_task.id and status = 'queued'
      and (v_pr.state <> 'open' or v_task.human_state = 'done' or v_task.request_state = 'removed' or v_pr.draft);
  end if;

  return jsonb_build_object(
    'pull_request_id', v_pr.id,
    'task_id', v_task.id,
    'task_created', v_task_created,
    'generation_changed', v_generation_changed,
    'human_state_changed', v_human_changed,
    'head_changed', v_old_head is not null and v_old_head <> v_pr.head_sha,
    'request_generation', v_task.request_generation,
    'job_id', v_job_id,
    'job_created', v_job_created
  );
end;
$$;

-- 状態取得に失敗したPRを保留にする（6.3）。レビュー完了・対象外には変えない。
create function public.worker_mark_pull_request_sync_failed(
  p_worker_id text,
  p_pull_request_id uuid,
  p_status text,
  p_error text
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'detector');
  v_pr public.pull_requests;
begin
  select * into v_pr from public.pull_requests pr where pr.id = p_pull_request_id;
  if not found then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  perform private.require_worker_profile(v_worker, v_pr.profile_id);
  if p_status not in ('unknown', 'rate_limited', 'forbidden', 'not_found', 'auth_error') then
    raise exception 'kakari: invalid sync status' using errcode = '22023';
  end if;
  update public.pull_requests
  set sync_status = p_status, sync_error = left(p_error, 1000), last_sync_attempt_at = now(), updated_at = now()
  where id = v_pr.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 実行権の取得（9.2）
-- ロック順序: app_settings → review_jobs（SKIP LOCKED） → usage_pools
-- ---------------------------------------------------------------------------
create function public.worker_acquire_job(p_worker_id text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'reviewer');
  v_settings public.app_settings;
  v_running integer;
  v_daily integer;
  v_day_start timestamptz;
  v_candidate record;
  v_pool public.usage_pools;
  v_pool_running integer;
  v_attempt public.review_attempts;
  v_job public.review_jobs;
  v_token uuid;
  v_pool_blocked boolean := false;
begin
  perform private.expire_leases();

  select * into v_settings from public.app_settings where id for update;

  select count(*) into v_running from public.review_jobs where slot_held;
  if v_running >= v_settings.max_concurrent_reviews then
    return jsonb_build_object('status', 'no_capacity', 'running', v_running);
  end if;

  v_day_start := (date_trunc('day', now() at time zone v_settings.timezone)) at time zone v_settings.timezone;
  select count(*) into v_daily from public.review_attempts a
  where a.reserved_at >= v_day_start and a.launch_state <> 'not_launched';
  if v_daily >= v_settings.max_auto_starts_per_day then
    return jsonb_build_object('status', 'daily_limit', 'started_today', v_daily);
  end if;

  for v_candidate in
    select j.id as job_id, p.usage_pool_id
    from public.review_jobs j
    join public.review_tasks t on t.id = j.review_task_id
    join public.pull_requests pr on pr.id = t.pull_request_id
    join public.profiles p on p.id = j.profile_id
    join public.worker_profiles wp on wp.profile_id = p.id and wp.worker_id = v_worker.id
    where j.status = 'queued'
      and j.not_before <= now()
      and p.owner_id = v_worker.owner_id
      and p.enabled and not p.paused
      and t.human_state = 'open' and t.request_state = 'requested'
      and pr.state = 'open' and not pr.draft and pr.sync_status = 'ok'
      and pr.head_sha = j.head_sha
      and j.review_config_version = p.review_config_version
    order by j.manual_generation desc, j.not_before, j.created_at
    for update of j skip locked
  loop
    select * into v_pool from public.usage_pools up where up.id = v_candidate.usage_pool_id for update;
    if v_pool.blocked_manual or (v_pool.blocked_until is not null and v_pool.blocked_until > now()) then
      v_pool_blocked := true;
      continue;
    end if;
    select count(*) into v_pool_running
    from public.review_jobs j2 join public.profiles p2 on p2.id = j2.profile_id
    where j2.slot_held and p2.usage_pool_id = v_pool.id;
    if v_pool_running >= v_pool.max_concurrent then
      continue;
    end if;

    v_token := gen_random_uuid();
    select * into v_job from public.review_jobs where id = v_candidate.job_id;

    insert into public.review_attempts (
      job_id, attempt_number, worker_id, lease_token, provider, usage_pool_id, head_sha, base_sha
    ) values (
      v_job.id, v_job.attempt_count + 1, v_worker.id, v_token, v_job.provider, v_pool.id, v_job.head_sha, v_job.base_sha
    ) returning * into v_attempt;

    update public.review_jobs
    set status = 'running',
        worker_id = v_worker.id,
        lease_token = v_token,
        lease_expires_at = now() + make_interval(secs => v_settings.lease_seconds),
        current_attempt_id = v_attempt.id,
        attempt_count = attempt_count + 1,
        slot_held = true,
        error_class = null,
        error_message = null,
        updated_at = now()
    where id = v_job.id
    returning * into v_job;

    return jsonb_build_object(
      'status', 'acquired',
      'job', to_jsonb(v_job) - 'lease_token',
      'execution_id', v_attempt.execution_id,
      'attempt_number', v_attempt.attempt_number,
      'lease_token', v_token,
      'lease_expires_at', v_job.lease_expires_at,
      'execution_timeout_seconds', v_settings.execution_timeout_seconds,
      'usage_pool_id', v_pool.id
    );
  end loop;

  return jsonb_build_object('status', case when v_pool_blocked then 'pool_blocked' else 'idle' end);
end;
$$;

-- 実行権・試行を検証して行ロックを取る
create function private.lock_attempt(p_worker public.workers, p_execution_id uuid, p_lease_token uuid)
returns public.review_attempts
language plpgsql security definer
set search_path = ''
as $$
declare
  v_attempt public.review_attempts;
begin
  select * into v_attempt from public.review_attempts a where a.execution_id = p_execution_id;
  if not found or v_attempt.worker_id <> p_worker.id or v_attempt.lease_token <> p_lease_token then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  perform 1 from public.review_jobs j where j.id = v_attempt.job_id for update;
  select * into v_attempt from public.review_attempts a where a.execution_id = p_execution_id for update;
  return v_attempt;
end;
$$;

create function public.worker_renew_lease(p_worker_id text, p_execution_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'reviewer');
  v_attempt public.review_attempts := private.lock_attempt(v_worker, p_execution_id, p_lease_token);
  v_settings public.app_settings;
  v_job public.review_jobs;
begin
  select * into v_settings from public.app_settings where id;
  select * into v_job from public.review_jobs j where j.id = v_attempt.job_id;
  if v_job.status <> 'running' or v_job.lease_token <> p_lease_token or v_job.lease_expires_at <= now() then
    return jsonb_build_object('ok', false, 'status', v_job.status);
  end if;
  update public.review_jobs
  set lease_expires_at = now() + make_interval(secs => v_settings.lease_seconds), updated_at = now()
  where id = v_job.id
  returning * into v_job;
  update public.workers set last_seen_at = now() where id = v_worker.id;
  return jsonb_build_object('ok', true, 'lease_expires_at', v_job.lease_expires_at);
end;
$$;

-- CLI起動直前に、固定した入力と起動を記録する
create function public.worker_mark_launched(
  p_worker_id text,
  p_execution_id uuid,
  p_lease_token uuid,
  p_snapshot jsonb
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'reviewer');
  v_attempt public.review_attempts := private.lock_attempt(v_worker, p_execution_id, p_lease_token);
  v_job public.review_jobs;
begin
  select * into v_job from public.review_jobs j where j.id = v_attempt.job_id;
  if v_job.status <> 'running' or v_job.lease_token <> p_lease_token or v_job.lease_expires_at <= now()
     or v_attempt.launch_state <> 'reserved' then
    return jsonb_build_object('ok', false, 'status', v_job.status);
  end if;
  if (p_snapshot ->> 'head_sha') is distinct from v_job.head_sha then
    raise exception 'kakari: snapshot head does not match job' using errcode = '22023';
  end if;
  update public.review_attempts
  set launch_state = 'launched',
      launched_at = now(),
      base_sha = p_snapshot ->> 'base_sha',
      merge_base_sha = p_snapshot ->> 'merge_base_sha',
      input_manifest = p_snapshot -> 'manifest',
      input_hash = p_snapshot ->> 'input_hash',
      cli_version = p_snapshot ->> 'cli_version'
  where id = v_attempt.id;
  return jsonb_build_object('ok', true);
end;
$$;

-- 利用枠を保留にする（8.5）。p_until が null なら手動再開が必要。
create function private.block_pool(p_pool_id text, p_until timestamptz, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.usage_pools
  set blocked_until = p_until,
      blocked_manual = p_until is null,
      blocked_reason = left(p_reason, 500),
      updated_at = now()
  where id = p_pool_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- CLIを起動せずに実行権を返す（起動前チェックで中断した場合）
-- p_disposition: requeue | superseded | cancelled | blocked | failed
-- ---------------------------------------------------------------------------
create function public.worker_release_job(
  p_worker_id text,
  p_execution_id uuid,
  p_lease_token uuid,
  p_disposition text,
  p_error_class text,
  p_error_message text,
  p_retry_after_seconds integer default null,
  p_pool_block jsonb default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'reviewer');
  v_attempt public.review_attempts := private.lock_attempt(v_worker, p_execution_id, p_lease_token);
  v_settings public.app_settings;
  v_job public.review_jobs;
  v_status text;
begin
  select * into v_settings from public.app_settings where id;
  select * into v_job from public.review_jobs j where j.id = v_attempt.job_id;
  if v_attempt.launch_state <> 'reserved' or v_attempt.outcome is not null then
    raise exception 'kakari: attempt already launched or finished' using errcode = '22023';
  end if;
  if v_job.current_attempt_id <> v_attempt.id or v_job.status not in ('running', 'unknown') then
    return jsonb_build_object('ok', false, 'status', v_job.status);
  end if;

  v_status := case p_disposition
    when 'requeue' then case when v_job.auto_retry_count >= v_settings.max_auto_retries then 'failed' else 'queued' end
    when 'superseded' then 'superseded'
    when 'cancelled' then 'cancelled'
    when 'blocked' then 'blocked'
    when 'failed' then 'failed'
    else null
  end;
  if v_status is null then
    raise exception 'kakari: invalid disposition' using errcode = '22023';
  end if;

  update public.review_attempts
  set launch_state = 'not_launched', outcome = 'not_launched', finished_at = now(),
      error_class = p_error_class, error_message = left(p_error_message, 2000)
  where id = v_attempt.id;

  update public.review_jobs
  set status = v_status,
      slot_held = false,
      lease_token = null,
      lease_expires_at = null,
      auto_retry_count = auto_retry_count + case when p_disposition = 'requeue' then 1 else 0 end,
      not_before = case when v_status = 'queued'
        then now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 60), 1)) else not_before end,
      error_class = p_error_class,
      error_message = left(p_error_message, 2000),
      finished_at = case when v_status in ('queued', 'blocked') then null else now() end,
      updated_at = now()
  where id = v_job.id;

  if p_pool_block is not null then
    perform private.block_pool(v_attempt.usage_pool_id, (p_pool_block ->> 'until')::timestamptz,
      p_pool_block ->> 'reason');
  end if;

  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 結果確定のトランザクション（10.2）
-- p_payload: outcome (succeeded|failed|timeout), provider_session_id, cli_version, usage,
--            error_class, error_message, pool_block {until, reason},
--            result { structured, quality_status, summary, result, raw_output, findings_count,
--                     max_severity, result_hash, pr_body_hash }
-- ---------------------------------------------------------------------------
create function public.worker_complete_attempt(
  p_worker_id text,
  p_execution_id uuid,
  p_lease_token uuid,
  p_payload jsonb
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'reviewer');
  v_attempt public.review_attempts := private.lock_attempt(v_worker, p_execution_id, p_lease_token);
  v_job public.review_jobs;
  v_task public.review_tasks;
  v_pr public.pull_requests;
  v_profile public.profiles;
  v_current public.review_results;
  v_result_id uuid;
  v_outcome text := p_payload ->> 'outcome';
  v_late boolean;
  v_adopt boolean := false;
  v_job_status text;
begin
  if v_outcome not in ('succeeded', 'failed', 'timeout') then
    raise exception 'kakari: invalid outcome' using errcode = '22023';
  end if;

  select * into v_job from public.review_jobs j where j.id = v_attempt.job_id;

  -- 本人の再試行で放棄された試行の結果は復旧用に保持するだけで採用しない
  if v_attempt.outcome in ('abandoned', 'not_launched') then
    update public.review_attempts set late = true, late_payload = p_payload where id = v_attempt.id;
    return jsonb_build_object('status', 'rejected', 'reason', 'attempt_' || v_attempt.outcome, 'job_status', v_job.status);
  end if;

  -- 同じ結果の再送（DB保存の再試行）には記録済みの内容を返す
  if v_attempt.outcome is not null then
    select r.id into v_result_id from public.review_results r where r.attempt_id = v_attempt.id;
    return jsonb_build_object('status', 'already_recorded', 'result_id', v_result_id, 'job_status', v_job.status);
  end if;

  -- 現在の試行で、実行中（有効な実行権）または結果不明のジョブだけが結果を確定できる。
  -- 別の試行へ移ったあとの古いtokenでは上書きしない（AC-11）。
  if v_job.current_attempt_id <> v_attempt.id
     or not (
       (v_job.status = 'running' and v_job.lease_token = p_lease_token and v_job.lease_expires_at > now())
       or v_job.status = 'unknown'
     ) then
    update public.review_attempts set late = true, late_payload = p_payload where id = v_attempt.id;
    return jsonb_build_object('status', 'rejected', 'reason', 'stale_lease', 'job_status', v_job.status);
  end if;
  v_late := v_job.status = 'unknown';

  select * into v_task from public.review_tasks t where t.id = v_job.review_task_id for update;
  select * into v_pr from public.pull_requests pr where pr.id = v_task.pull_request_id;
  select * into v_profile from public.profiles p where p.id = v_task.profile_id;

  if v_outcome = 'succeeded' then
    if (p_payload #>> '{result,result_hash}') is null then
      raise exception 'kakari: result hash is required' using errcode = '22023';
    end if;
    insert into public.review_results (
      attempt_id, job_id, review_task_id, profile_id, head_sha, base_sha, merge_base_sha, pr_body_hash,
      review_config_version, manual_generation, provider, cli_version, structured, quality_status, summary,
      result, raw_output, findings_count, max_severity, result_hash
    ) values (
      v_attempt.id, v_job.id, v_task.id, v_task.profile_id, v_job.head_sha,
      coalesce(v_attempt.base_sha, v_job.base_sha), v_attempt.merge_base_sha,
      p_payload #>> '{result,pr_body_hash}', v_job.review_config_version, v_job.manual_generation,
      v_job.provider, coalesce(p_payload ->> 'cli_version', v_attempt.cli_version),
      coalesce((p_payload #>> '{result,structured}')::boolean, false),
      coalesce(p_payload #>> '{result,quality_status}', 'unstructured'),
      p_payload #>> '{result,summary}', p_payload #> '{result,result}', p_payload #>> '{result,raw_output}',
      (p_payload #>> '{result,findings_count}')::integer, p_payload #>> '{result,max_severity}',
      p_payload #>> '{result,result_hash}'
    ) returning id into v_result_id;

    v_job_status := 'succeeded';

    -- 採用ルール: 最新head・現在設定の結果を優先し、同じhead・設定では手動世代の新しい結果を優先する
    select * into v_current from public.review_results r where r.id = v_task.current_result_id;
    if v_current.id is null then
      v_adopt := true;
    elsif v_job.head_sha = v_pr.head_sha and v_job.review_config_version = v_profile.review_config_version then
      v_adopt := not (
        v_current.head_sha = v_job.head_sha
        and v_current.review_config_version = v_job.review_config_version
        and v_current.manual_generation > v_job.manual_generation
      );
    elsif v_current.head_sha = v_pr.head_sha and v_current.review_config_version = v_profile.review_config_version then
      v_adopt := false;
    else
      v_adopt := true;
    end if;

    if v_adopt then
      update public.review_tasks
      set current_result_id = v_result_id, revision = revision + 1, updated_at = now()
      where id = v_task.id;
    end if;
  elsif coalesce(p_payload ->> 'error_class', '') in ('usage_limit', 'auth') then
    v_job_status := 'blocked';
    perform private.block_pool(v_attempt.usage_pool_id, (p_payload #>> '{pool_block,until}')::timestamptz,
      coalesce(p_payload #>> '{pool_block,reason}', p_payload ->> 'error_class'));
  else
    -- 起動後の失敗・タイムアウトは追加消費の可能性があるため自動再試行しない（9.5）
    v_job_status := 'failed';
  end if;

  update public.review_attempts
  set outcome = v_outcome,
      finished_at = now(),
      provider_session_id = p_payload ->> 'provider_session_id',
      cli_version = coalesce(p_payload ->> 'cli_version', cli_version),
      usage = p_payload -> 'usage',
      error_class = p_payload ->> 'error_class',
      error_message = left(p_payload ->> 'error_message', 2000),
      late = v_late
  where id = v_attempt.id;

  update public.review_jobs
  set status = v_job_status,
      adopted_result_id = coalesce(v_result_id, adopted_result_id),
      slot_held = false,
      lease_token = null,
      lease_expires_at = null,
      error_class = case when v_job_status = 'succeeded' then null else p_payload ->> 'error_class' end,
      error_message = case when v_job_status = 'succeeded' then null else left(p_payload ->> 'error_message', 2000) end,
      finished_at = case when v_job_status = 'blocked' then null else now() end,
      updated_at = now()
  where id = v_job.id;

  return jsonb_build_object(
    'status', 'recorded',
    'job_status', v_job_status,
    'result_id', v_result_id,
    'adopted', v_adopt,
    'late', v_late
  );
end;
$$;

-- 結果不明のジョブを照合結果に従って確定する（kakari reconcile）
-- p_resolution: not_launched（CLI未起動を確認）| failed（起動後に結果なしで終了を確認）
create function public.worker_resolve_unknown(
  p_worker_id text,
  p_execution_id uuid,
  p_lease_token uuid,
  p_resolution text,
  p_error_message text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'reviewer');
  v_attempt public.review_attempts := private.lock_attempt(v_worker, p_execution_id, p_lease_token);
  v_job public.review_jobs;
begin
  select * into v_job from public.review_jobs j where j.id = v_attempt.job_id;
  if v_job.status <> 'unknown' or v_job.current_attempt_id <> v_attempt.id or v_attempt.outcome is not null then
    return jsonb_build_object('ok', false, 'status', v_job.status);
  end if;
  if p_resolution = 'not_launched' then
    update public.review_attempts
    set launch_state = 'not_launched', outcome = 'not_launched', finished_at = now(),
        error_message = left(p_error_message, 2000)
    where id = v_attempt.id;
    update public.review_jobs
    set status = 'queued', not_before = now(), slot_held = false, lease_token = null, lease_expires_at = null,
        error_class = null, error_message = null, updated_at = now()
    where id = v_job.id;
  elsif p_resolution = 'failed' then
    update public.review_attempts
    set outcome = 'failed', finished_at = now(), error_class = 'reconciled_failed',
        error_message = left(p_error_message, 2000)
    where id = v_attempt.id;
    update public.review_jobs
    set status = 'failed', slot_held = false, lease_token = null, lease_expires_at = null,
        error_class = 'reconciled_failed', error_message = left(p_error_message, 2000),
        finished_at = now(), updated_at = now()
    where id = v_job.id;
  else
    raise exception 'kakari: invalid resolution' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 利用枠を保留にする（CLI起動前の preflight で認証・利用枠の問題を検出した場合など）
create function public.worker_block_usage_pool(
  p_worker_id text,
  p_pool_id text,
  p_until timestamptz,
  p_reason text
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'reviewer');
begin
  if not exists (
    select 1 from public.profiles p
    join public.worker_profiles wp on wp.profile_id = p.id and wp.worker_id = v_worker.id
    where p.usage_pool_id = p_pool_id
  ) then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  perform private.block_pool(p_pool_id, p_until, p_reason);
end;
$$;

-- 保存期限による本文削除（14.3）。重複防止用メタデータは残す。
create function public.worker_apply_retention(p_worker_id text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'reviewer');
  v_results integer;
  v_logs integer;
begin
  update public.review_results r
  set result = null, raw_output = null, summary = null, body_deleted_at = now()
  from public.profiles p
  join public.worker_profiles wp on wp.profile_id = p.id and wp.worker_id = v_worker.id
  where p.id = r.profile_id
    and r.body_deleted_at is null
    and r.created_at < now() - make_interval(days => p.retention_results_days);
  get diagnostics v_results = row_count;

  update public.review_attempts a
  set error_message = null, late_payload = null, input_manifest = null
  from public.review_jobs j
  join public.profiles p on p.id = j.profile_id
  join public.worker_profiles wp on wp.profile_id = p.id and wp.worker_id = v_worker.id
  where j.id = a.job_id
    and a.finished_at < now() - make_interval(days => p.retention_logs_days)
    and (a.error_message is not null or a.late_payload is not null or a.input_manifest is not null);
  get diagnostics v_logs = row_count;

  return jsonb_build_object('results_body_deleted', v_results, 'attempt_logs_cleared', v_logs);
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.worker_heartbeat(text, jsonb)',
    'public.worker_set_reviewer_identity(text, text, text)',
    'public.worker_record_discovery(text, text, text, text, jsonb)',
    'public.worker_record_rate_limits(text, jsonb)',
    'public.worker_sync_pull_request(text, text, jsonb, jsonb)',
    'public.worker_mark_pull_request_sync_failed(text, uuid, text, text)',
    'public.worker_acquire_job(text)',
    'public.worker_renew_lease(text, uuid, uuid)',
    'public.worker_mark_launched(text, uuid, uuid, jsonb)',
    'public.worker_release_job(text, uuid, uuid, text, text, text, integer, jsonb)',
    'public.worker_complete_attempt(text, uuid, uuid, jsonb)',
    'public.worker_resolve_unknown(text, uuid, uuid, text, text)',
    'public.worker_block_usage_pool(text, text, timestamptz, text)',
    'public.worker_apply_retention(text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.is_app_user(),
  private.owns_profile(text),
  private.worker_serves_profile(text),
  private.can_read_profile(text),
  private.current_worker_id()
to authenticated;
