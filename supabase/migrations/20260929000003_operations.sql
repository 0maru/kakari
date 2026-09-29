-- 本人の操作（10.4 UI・CLI共通の操作契約）
-- 認可・現在状態・対象結果・依頼世代・revision を検証し、更新と task_operations への記録を
-- 同じトランザクションで行う。同じ operation ID の再送には記録済みの応答を返す。

-- ---------------------------------------------------------------------------
-- 共通ヘルパー
-- ---------------------------------------------------------------------------
create function private.require_app_user() returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not exists (select 1 from public.app_users u where u.user_id = v_uid) then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- 既存の操作記録を返す。同じ operation ID で異なる内容なら拒否する。
create function private.find_operation(p_actor uuid, p_operation_id text, p_request_hash text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_op public.task_operations;
begin
  if p_operation_id is null or char_length(p_operation_id) not between 8 and 128 then
    raise exception 'kakari: invalid operation id' using errcode = '22023';
  end if;
  -- 同じ操作IDの同時送信を直列化する
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_operation_id, 0));
  select * into v_op from public.task_operations o
  where o.actor_id = p_actor and o.operation_id = p_operation_id;
  if not found then
    return null;
  end if;
  if v_op.request_hash <> p_request_hash then
    raise exception 'kakari: operation id reused with different request' using errcode = '22023';
  end if;
  return v_op.response || jsonb_build_object('replayed', true);
end;
$$;

create function private.record_operation(
  p_actor uuid,
  p_operation_id text,
  p_op_type text,
  p_task_id uuid,
  p_profile_id text,
  p_request_hash text,
  p_revision_before bigint,
  p_revision_after bigint,
  p_outcome text,
  p_response jsonb,
  p_target_result_id uuid default null,
  p_target_generation integer default null,
  p_target_job_id uuid default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_response jsonb := p_response || jsonb_build_object('status', p_outcome, 'operation_id', p_operation_id);
begin
  insert into public.task_operations (
    actor_id, operation_id, op_type, review_task_id, profile_id, target_result_id, target_generation,
    target_job_id, request_hash, revision_before, revision_after, outcome, response
  ) values (
    p_actor, p_operation_id, p_op_type, p_task_id, p_profile_id, p_target_result_id, p_target_generation,
    p_target_job_id, p_request_hash, p_revision_before, p_revision_after, p_outcome, v_response
  );
  return v_response || jsonb_build_object('replayed', false);
end;
$$;

create function private.request_hash(p_payload jsonb) returns text
language sql immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
$$;

-- 本人が操作できるレビュー項目を行ロック付きで取得する
create function private.lock_owned_task(p_task_id uuid) returns public.review_tasks
language plpgsql security definer
set search_path = ''
as $$
declare
  v_task public.review_tasks;
begin
  select * into v_task from public.review_tasks t where t.id = p_task_id for update;
  if not found or not private.owns_profile(v_task.profile_id) then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  return v_task;
end;
$$;

-- ---------------------------------------------------------------------------
-- acknowledge_result: 指定した結果を確認済みにする（12.2）
-- ---------------------------------------------------------------------------
create function public.acknowledge_result(
  p_task_id uuid,
  p_result_id uuid,
  p_request_generation integer,
  p_expected_revision bigint,
  p_operation_id text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_app_user();
  v_hash text := private.request_hash(jsonb_build_object(
    'op', 'acknowledge_result', 'task', p_task_id, 'result', p_result_id,
    'generation', p_request_generation, 'revision', p_expected_revision));
  v_prev jsonb;
  v_task public.review_tasks;
  v_result_task uuid;
  v_new_revision bigint;
begin
  v_prev := private.find_operation(v_actor, p_operation_id, v_hash);
  if v_prev is not null then
    return v_prev;
  end if;

  v_task := private.lock_owned_task(p_task_id);

  select r.review_task_id into v_result_task from public.review_results r where r.id = p_result_id;
  if v_result_task is null or v_result_task <> v_task.id then
    raise exception 'kakari: result does not belong to task' using errcode = '22023';
  end if;
  if p_request_generation is null or p_request_generation < 1 or p_request_generation > v_task.request_generation then
    raise exception 'kakari: invalid request generation' using errcode = '22023';
  end if;

  if v_task.revision <> p_expected_revision then
    return private.record_operation(v_actor, p_operation_id, 'acknowledge_result', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'conflict',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision),
      p_result_id, p_request_generation);
  end if;

  -- 現在結果・現在の依頼世代に一致する場合だけ確認済み参照を更新する。古い結果は履歴のみ。
  if p_result_id is distinct from v_task.current_result_id or p_request_generation <> v_task.request_generation then
    return private.record_operation(v_actor, p_operation_id, 'acknowledge_result', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'recorded_only',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision),
      p_result_id, p_request_generation);
  end if;

  if v_task.acked_result_id = p_result_id and v_task.acked_generation = p_request_generation then
    return private.record_operation(v_actor, p_operation_id, 'acknowledge_result', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'applied',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision, 'changed', false),
      p_result_id, p_request_generation);
  end if;

  update public.review_tasks
  set acked_result_id = p_result_id,
      acked_generation = p_request_generation,
      acked_at = now(),
      revision = revision + 1,
      updated_at = now()
  where id = v_task.id
  returning revision into v_new_revision;

  return private.record_operation(v_actor, p_operation_id, 'acknowledge_result', v_task.id, v_task.profile_id,
    v_hash, v_task.revision, v_new_revision, 'applied',
    jsonb_build_object('task_id', v_task.id, 'revision', v_new_revision, 'changed', true),
    p_result_id, p_request_generation);
end;
$$;

-- ---------------------------------------------------------------------------
-- set_task_snooze: 通知の停止期限を変更する（12.4）。p_until が null なら解除。
-- ---------------------------------------------------------------------------
create function public.set_task_snooze(
  p_task_id uuid,
  p_until timestamptz,
  p_expected_revision bigint,
  p_operation_id text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_app_user();
  v_hash text := private.request_hash(jsonb_build_object(
    'op', 'set_task_snooze', 'task', p_task_id, 'until', p_until, 'revision', p_expected_revision));
  v_prev jsonb;
  v_task public.review_tasks;
  v_new_revision bigint;
begin
  v_prev := private.find_operation(v_actor, p_operation_id, v_hash);
  if v_prev is not null then
    return v_prev;
  end if;

  if p_until is not null and (p_until <= now() or p_until > now() + interval '366 days') then
    raise exception 'kakari: snooze deadline must be in the future (within 1 year)' using errcode = '22023';
  end if;

  v_task := private.lock_owned_task(p_task_id);

  if v_task.revision <> p_expected_revision then
    return private.record_operation(v_actor, p_operation_id, 'set_task_snooze', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'conflict',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision));
  end if;

  update public.review_tasks
  set snoozed_until = p_until,
      revision = revision + 1,
      updated_at = now()
  where id = v_task.id
  returning revision into v_new_revision;

  return private.record_operation(v_actor, p_operation_id, 'set_task_snooze', v_task.id, v_task.profile_id,
    v_hash, v_task.revision, v_new_revision, 'applied',
    jsonb_build_object('task_id', v_task.id, 'revision', v_new_revision, 'snoozed_until', p_until));
end;
$$;

-- ---------------------------------------------------------------------------
-- complete_review_task: 現在の依頼への人間の対応を終了する（12.3）。GitHubへは何もしない。
-- ---------------------------------------------------------------------------
create function public.complete_review_task(
  p_task_id uuid,
  p_request_generation integer,
  p_reason text,
  p_expected_revision bigint,
  p_operation_id text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_app_user();
  v_hash text := private.request_hash(jsonb_build_object(
    'op', 'complete_review_task', 'task', p_task_id, 'generation', p_request_generation,
    'reason', p_reason, 'revision', p_expected_revision));
  v_prev jsonb;
  v_task public.review_tasks;
  v_new_revision bigint;
begin
  v_prev := private.find_operation(v_actor, p_operation_id, v_hash);
  if v_prev is not null then
    return v_prev;
  end if;

  if p_reason is null or char_length(btrim(p_reason)) = 0 or char_length(p_reason) > 500 then
    raise exception 'kakari: reason is required (max 500 chars)' using errcode = '22023';
  end if;

  v_task := private.lock_owned_task(p_task_id);

  if v_task.revision <> p_expected_revision then
    return private.record_operation(v_actor, p_operation_id, 'complete_review_task', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'conflict',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision),
      null, p_request_generation);
  end if;

  if p_request_generation <> v_task.request_generation then
    return private.record_operation(v_actor, p_operation_id, 'complete_review_task', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'conflict',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision,
        'message', 'request generation changed'),
      null, p_request_generation);
  end if;

  if v_task.human_state = 'done' then
    return private.record_operation(v_actor, p_operation_id, 'complete_review_task', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'applied',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision, 'changed', false),
      null, p_request_generation);
  end if;

  update public.review_tasks
  set human_state = 'done',
      done_generation = v_task.request_generation,
      done_reason = btrim(p_reason),
      done_source = 'manual',
      done_at = now(),
      revision = revision + 1,
      updated_at = now()
  where id = v_task.id
  returning revision into v_new_revision;

  -- 当該依頼の未開始ジョブを止める。実行中の結果は履歴として保存される。
  update public.review_jobs
  set status = 'cancelled', error_class = 'task_done', updated_at = now(), finished_at = now()
  where review_task_id = v_task.id and status = 'queued';

  return private.record_operation(v_actor, p_operation_id, 'complete_review_task', v_task.id, v_task.profile_id,
    v_hash, v_task.revision, v_new_revision, 'applied',
    jsonb_build_object('task_id', v_task.id, 'revision', v_new_revision, 'changed', true),
    null, p_request_generation);
end;
$$;

-- ---------------------------------------------------------------------------
-- request_review_retry: 失敗・保留・結果不明のジョブの再試行を要求する（9.5）
-- 起動済みの可能性がある場合は p_confirm.acknowledge_possible_extra_usage=true が必要。
-- ---------------------------------------------------------------------------
create function public.request_review_retry(
  p_job_id uuid,
  p_expected_revision bigint,
  p_confirm jsonb,
  p_operation_id text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_app_user();
  v_hash text := private.request_hash(jsonb_build_object(
    'op', 'request_review_retry', 'job', p_job_id, 'revision', p_expected_revision,
    'confirm', coalesce(p_confirm, '{}'::jsonb)));
  v_prev jsonb;
  v_job public.review_jobs;
  v_task public.review_tasks;
  v_pr public.pull_requests;
  v_launched boolean;
begin
  v_prev := private.find_operation(v_actor, p_operation_id, v_hash);
  if v_prev is not null then
    return v_prev;
  end if;

  select * into v_job from public.review_jobs j where j.id = p_job_id;
  if not found then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  v_task := private.lock_owned_task(v_job.review_task_id);
  select * into v_job from public.review_jobs j where j.id = p_job_id for update;
  select * into v_pr from public.pull_requests pr where pr.id = v_task.pull_request_id;

  if v_task.revision <> p_expected_revision then
    return private.record_operation(v_actor, p_operation_id, 'request_review_retry', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'conflict',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision, 'job_id', v_job.id),
      null, null, v_job.id);
  end if;

  if v_job.status not in ('failed', 'blocked', 'unknown') then
    return private.record_operation(v_actor, p_operation_id, 'request_review_retry', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'rejected',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision, 'job_id', v_job.id,
        'message', 'job is not retryable in status ' || v_job.status),
      null, null, v_job.id);
  end if;

  if v_job.head_sha is distinct from v_pr.head_sha then
    return private.record_operation(v_actor, p_operation_id, 'request_review_retry', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'rejected',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision, 'job_id', v_job.id,
        'message', 'job targets an old head'),
      null, null, v_job.id);
  end if;

  select exists (
    select 1 from public.review_attempts a
    where a.job_id = v_job.id and a.launch_state in ('launched', 'reserved') and a.outcome is distinct from 'not_launched'
  ) into v_launched;

  if (v_launched or v_job.status = 'unknown')
     and coalesce((p_confirm ->> 'acknowledge_possible_extra_usage')::boolean, false) is not true then
    -- 承認が必要な応答は記録しない（承認付きで同じ操作IDを再送できるようにするため）
    return jsonb_build_object('status', 'confirmation_required', 'operation_id', p_operation_id,
      'task_id', v_task.id, 'revision', v_task.revision, 'job_id', v_job.id,
      'message', 'the AI CLI may already have been launched; retrying can consume additional usage',
      'replayed', false);
  end if;

  update public.review_jobs
  set status = 'queued',
      not_before = now(),
      slot_held = false,
      lease_token = null,
      lease_expires_at = null,
      error_class = null,
      error_message = null,
      updated_at = now(),
      finished_at = null
  where id = v_job.id;

  -- 結果不明のまま残っていた試行は放棄扱いにする
  update public.review_attempts
  set outcome = 'abandoned', finished_at = coalesce(finished_at, now())
  where job_id = v_job.id and outcome is null;

  return private.record_operation(v_actor, p_operation_id, 'request_review_retry', v_task.id, v_task.profile_id,
    v_hash, v_task.revision, v_task.revision, 'applied',
    jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision, 'job_id', v_job.id),
    null, null, v_job.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- request_manual_review: 追加消費の承認を記録し、手動世代を作る（9.5）
-- ---------------------------------------------------------------------------
create function public.request_manual_review(
  p_job_id uuid,
  p_reason text,
  p_expected_revision bigint,
  p_confirm jsonb,
  p_operation_id text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_app_user();
  v_hash text := private.request_hash(jsonb_build_object(
    'op', 'request_manual_review', 'job', p_job_id, 'reason', p_reason, 'revision', p_expected_revision,
    'confirm', coalesce(p_confirm, '{}'::jsonb)));
  v_prev jsonb;
  v_job public.review_jobs;
  v_task public.review_tasks;
  v_pr public.pull_requests;
  v_profile public.profiles;
  v_generation integer;
  v_new_job_id uuid;
  v_new_revision bigint;
begin
  v_prev := private.find_operation(v_actor, p_operation_id, v_hash);
  if v_prev is not null then
    return v_prev;
  end if;

  if p_reason is null or char_length(btrim(p_reason)) = 0 or char_length(p_reason) > 500 then
    raise exception 'kakari: reason is required (max 500 chars)' using errcode = '22023';
  end if;

  select * into v_job from public.review_jobs j where j.id = p_job_id;
  if not found then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  v_task := private.lock_owned_task(v_job.review_task_id);
  select * into v_pr from public.pull_requests pr where pr.id = v_task.pull_request_id;
  select * into v_profile from public.profiles p where p.id = v_task.profile_id;

  if v_task.revision <> p_expected_revision then
    return private.record_operation(v_actor, p_operation_id, 'request_manual_review', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'conflict',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision, 'job_id', v_job.id),
      null, null, v_job.id);
  end if;

  if v_job.head_sha is distinct from v_pr.head_sha or v_pr.state <> 'open' then
    return private.record_operation(v_actor, p_operation_id, 'request_manual_review', v_task.id, v_task.profile_id,
      v_hash, v_task.revision, v_task.revision, 'rejected',
      jsonb_build_object('task_id', v_task.id, 'revision', v_task.revision, 'job_id', v_job.id,
        'message', 'job does not target the current head of an open pull request'),
      null, null, v_job.id);
  end if;

  if coalesce((p_confirm ->> 'acknowledge_extra_usage')::boolean, false) is not true then
    return jsonb_build_object('status', 'confirmation_required', 'operation_id', p_operation_id,
      'task_id', v_task.id, 'revision', v_task.revision, 'job_id', v_job.id,
      'head_sha', v_job.head_sha, 'provider', v_profile.provider,
      'message', 'a manual re-review consumes additional usage', 'replayed', false);
  end if;

  select coalesce(max(j.manual_generation), 0) + 1 into v_generation
  from public.review_jobs j
  where j.review_task_id = v_task.id
    and j.head_sha = v_job.head_sha
    and j.review_config_version = v_profile.review_config_version;

  insert into public.review_jobs (
    review_task_id, profile_id, head_sha, base_sha, review_config_version, provider,
    manual_generation, manual_reason, requested_by, status, not_before
  ) values (
    v_task.id, v_task.profile_id, v_job.head_sha, v_pr.base_sha, v_profile.review_config_version,
    v_profile.provider, v_generation, btrim(p_reason), v_actor, 'queued', now()
  ) returning id into v_new_job_id;

  update public.review_tasks set revision = revision + 1, updated_at = now()
  where id = v_task.id
  returning revision into v_new_revision;

  return private.record_operation(v_actor, p_operation_id, 'request_manual_review', v_task.id, v_task.profile_id,
    v_hash, v_task.revision, v_new_revision, 'applied',
    jsonb_build_object('task_id', v_task.id, 'revision', v_new_revision, 'job_id', v_new_job_id,
      'manual_generation', v_generation),
    null, null, v_new_job_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- set_profile_paused: プロファイルの新規自動レビューを停止/再開する（16.2）
-- ---------------------------------------------------------------------------
create function public.set_profile_paused(
  p_profile_id text,
  p_paused boolean,
  p_operation_id text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_app_user();
  v_hash text := private.request_hash(jsonb_build_object(
    'op', 'set_profile_paused', 'profile', p_profile_id, 'paused', p_paused));
  v_prev jsonb;
begin
  v_prev := private.find_operation(v_actor, p_operation_id, v_hash);
  if v_prev is not null then
    return v_prev;
  end if;
  if not private.owns_profile(p_profile_id) then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  update public.profiles set paused = p_paused, updated_at = now() where id = p_profile_id;
  return private.record_operation(v_actor, p_operation_id, 'set_profile_paused', null, p_profile_id,
    v_hash, null, null, 'applied', jsonb_build_object('profile_id', p_profile_id, 'paused', p_paused));
end;
$$;

-- ---------------------------------------------------------------------------
-- clear_usage_pool_block: 復帰時刻が不明な利用枠の保留を手動で解除する（8.5）
-- ---------------------------------------------------------------------------
create function public.clear_usage_pool_block(
  p_pool_id text,
  p_operation_id text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_app_user();
  v_hash text := private.request_hash(jsonb_build_object('op', 'clear_usage_pool_block', 'pool', p_pool_id));
  v_prev jsonb;
begin
  v_prev := private.find_operation(v_actor, p_operation_id, v_hash);
  if v_prev is not null then
    return v_prev;
  end if;
  if not exists (select 1 from public.usage_pools up where up.id = p_pool_id and up.owner_id = v_actor) then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  update public.usage_pools
  set blocked_until = null, blocked_manual = false, blocked_reason = null, updated_at = now()
  where id = p_pool_id;
  -- 利用枠の保留で止まっていたジョブを実行待ちへ戻す
  update public.review_jobs j
  set status = 'queued', not_before = now(), error_class = null, error_message = null, updated_at = now()
  from public.profiles p
  where p.id = j.profile_id and p.usage_pool_id = p_pool_id
    and j.status = 'blocked' and j.error_class in ('usage_limit', 'auth');
  return private.record_operation(v_actor, p_operation_id, 'clear_usage_pool_block', null, null,
    v_hash, null, null, 'applied', jsonb_build_object('pool_id', p_pool_id));
end;
$$;

revoke all on function
  public.acknowledge_result(uuid, uuid, integer, bigint, text),
  public.set_task_snooze(uuid, timestamptz, bigint, text),
  public.complete_review_task(uuid, integer, text, bigint, text),
  public.request_review_retry(uuid, bigint, jsonb, text),
  public.request_manual_review(uuid, text, bigint, jsonb, text),
  public.set_profile_paused(text, boolean, text),
  public.clear_usage_pool_block(text, text)
from public, anon;

grant execute on function
  public.acknowledge_result(uuid, uuid, integer, bigint, text),
  public.set_task_snooze(uuid, timestamptz, bigint, text),
  public.complete_review_task(uuid, integer, text, bigint, text),
  public.request_review_retry(uuid, bigint, jsonb, text),
  public.request_manual_review(uuid, text, bigint, jsonb, text),
  public.set_profile_paused(text, boolean, text),
  public.clear_usage_pool_block(text, text)
to authenticated;
