-- 通知（13章）
-- 通知準備はレビュー実行ホストが通知枠ごとに行い、配送は通知クライアントが自分宛てのoutboxから行う。

-- 通知対象の判定（13.1）。鮮度（最終GitHub同期）は別に返す。
create function private.notification_candidates(p_profile_id text)
returns table (
  task_id uuid,
  result_id uuid,
  request_generation integer,
  head_sha text,
  pull_request_id uuid,
  repository_full_name text,
  pr_number integer,
  pr_title text,
  last_synced_at timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  select o.task_id, o.current_result_id, o.request_generation, o.head_sha, o.pull_request_id,
         o.repository_full_name, o.pr_number, o.pr_title, o.last_synced_at
  from public.task_overview o
  where o.profile_id = p_profile_id
    and o.display_state = 'awaiting_ack'
    and (o.snoozed_until is null or o.snoozed_until <= now())
    and o.result_body_deleted_at is null
    and o.human_state = 'open';
$$;

create function private.was_delivered(p_profile_id text, p_result_id uuid, p_generation integer)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.outbox_events e
    where e.profile_id = p_profile_id
      and e.event_type = 'review_results'
      and e.state = 'delivered'
      and e.payload -> 'items' @> jsonb_build_array(
        jsonb_build_object('result_id', p_result_id, 'request_generation', p_generation))
  );
$$;

-- ---------------------------------------------------------------------------
-- worker_plan_notification: 通知枠の通知をoutboxへ保存する（13.3の1）
-- 鮮度上限を超えた項目がある場合は needs_sync を返す。p_exclude_stale=true なら古い項目を除いて作る。
-- ---------------------------------------------------------------------------
create function public.worker_plan_notification(
  p_worker_id text,
  p_profile_id text,
  p_slot_at timestamptz,
  p_exclude_stale boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'notification_planner');
  v_profile public.profiles := private.require_worker_profile(v_worker, p_profile_id);
  v_min_synced timestamptz := now() - make_interval(secs => v_profile.notify_max_state_age_seconds);
  v_stale uuid[];
  v_items jsonb;
  v_new integer;
  v_total integer;
  v_event_id uuid;
  v_key text;
begin
  if v_profile.notify_destination_worker_id is null then
    return jsonb_build_object('status', 'no_destination');
  end if;
  if p_slot_at is null or p_slot_at > now() then
    raise exception 'kakari: slot must not be in the future' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct c.pull_request_id), array[]::uuid[]) into v_stale
  from private.notification_candidates(v_profile.id) c
  where c.last_synced_at is null or c.last_synced_at < v_min_synced;

  if cardinality(v_stale) > 0 and not p_exclude_stale then
    return jsonb_build_object('status', 'needs_sync', 'pull_request_ids', to_jsonb(v_stale));
  end if;

  select
    coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'task_id', c.task_id,
      'result_id', c.result_id,
      'request_generation', c.request_generation,
      'head_sha', c.head_sha,
      'previously_notified', private.was_delivered(v_profile.id, c.result_id, c.request_generation),
      'repository_full_name', case when v_profile.notify_detail_level in ('repository', 'title') then c.repository_full_name end,
      'pr_number', case when v_profile.notify_detail_level in ('repository', 'title') then c.pr_number end,
      'pr_title', case when v_profile.notify_detail_level = 'title' then c.pr_title end
    )) order by c.repository_full_name, c.pr_number), '[]'::jsonb)
  into v_items
  from private.notification_candidates(v_profile.id) c
  where c.last_synced_at >= v_min_synced
    and (v_profile.notify_repeat_until_acknowledged
         or not private.was_delivered(v_profile.id, c.result_id, c.request_generation));

  v_total := jsonb_array_length(v_items);

  insert into public.profile_sync_states as s (profile_id, last_planned_slot_at)
  values (v_profile.id, p_slot_at)
  on conflict (profile_id) do update
    set last_planned_slot_at = greatest(s.last_planned_slot_at, excluded.last_planned_slot_at), updated_at = now();

  if v_total = 0 then
    return jsonb_build_object('status', 'nothing', 'excluded_stale', cardinality(v_stale));
  end if;

  select count(*) into v_new from jsonb_array_elements(v_items) i
  where not (i ->> 'previously_notified')::boolean;

  v_key := v_profile.id || '|' || v_profile.notify_destination_worker_id || '|review_results|'
    || to_char(p_slot_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  insert into public.outbox_events (
    profile_id, event_type, idempotency_key, destination_worker_id, scheduled_slot_at, payload
  ) values (
    v_profile.id, 'review_results', v_key, v_profile.notify_destination_worker_id, p_slot_at,
    jsonb_build_object(
      'profile_id', v_profile.id,
      'profile_name', v_profile.name,
      'slot_at', p_slot_at,
      'detail_level', v_profile.notify_detail_level,
      'counts', jsonb_build_object('total', v_total, 'new', v_new, 'carried_over', v_total - v_new),
      'items', v_items
    )
  )
  on conflict (event_type, idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return jsonb_build_object('status', 'already_planned');
  end if;

  -- 逃した過去枠は一括送信しない（13.4）: 未配送の古い枠は新しい枠に置き換える
  update public.outbox_events
  set state = 'superseded', updated_at = now()
  where profile_id = v_profile.id and event_type = 'review_results'
    and destination_worker_id = v_profile.notify_destination_worker_id
    and state = 'pending' and id <> v_event_id;

  return jsonb_build_object('status', 'planned', 'event_id', v_event_id, 'count', v_total,
    'excluded_stale', cardinality(v_stale));
end;
$$;

-- ---------------------------------------------------------------------------
-- 運用通知（13.1）: 同一障害は1日1回以下
-- ---------------------------------------------------------------------------
create function public.worker_raise_ops_alert(
  p_worker_id text,
  p_profile_id text,
  p_kind text,
  p_message text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers;
  v_profile public.profiles;
  v_key text;
  v_event_id uuid;
begin
  select * into v_worker from public.workers w
  where w.id = p_worker_id and w.auth_user_id = (select auth.uid())
    and w.roles && array['detector', 'reviewer', 'notification_planner']::text[];
  if not found then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  v_profile := private.require_worker_profile(v_worker, p_profile_id);
  if p_kind !~ '^[a-z0-9_:.-]{1,64}$' then
    raise exception 'kakari: invalid alert kind' using errcode = '22023';
  end if;
  if v_profile.notify_destination_worker_id is null then
    return jsonb_build_object('status', 'no_destination');
  end if;
  v_key := v_profile.id || '|' || v_profile.notify_destination_worker_id || '|ops_alert|' || p_kind || '|'
    || to_char(now() at time zone v_profile.notify_timezone, 'YYYY-MM-DD');
  insert into public.outbox_events (profile_id, event_type, idempotency_key, destination_worker_id, payload)
  values (
    v_profile.id, 'ops_alert', v_key, v_profile.notify_destination_worker_id,
    jsonb_build_object('profile_id', v_profile.id, 'profile_name', v_profile.name, 'kind', p_kind,
      'message', left(p_message, 300))
  )
  on conflict (event_type, idempotency_key) do nothing
  returning id into v_event_id;
  return jsonb_build_object('status', case when v_event_id is null then 'suppressed' else 'queued' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 通知クライアント: 自分宛ての通知を取得権付きで取得する（13.3の2・3）
-- 表示直前に対象結果ID・依頼世代・現在head・ack・スヌーズを再確認する。
-- ---------------------------------------------------------------------------
create function public.notifier_claim_events(p_worker_id text, p_limit integer default 10)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'notifier');
  v_event public.outbox_events;
  v_profile public.profiles;
  v_valid jsonb;
  v_stale integer;
  v_new integer;
  v_total integer;
  v_token uuid;
  v_out jsonb := '[]'::jsonb;
begin
  update public.workers set last_seen_at = now() where id = v_worker.id;

  -- 取得後に配送記録がないまま期限切れ: 表示されたか不明なので自動再送しない（13.4）
  update public.outbox_events
  set state = 'unknown', delivery_error = 'claim expired without a delivery record', updated_at = now()
  where destination_worker_id = v_worker.id and state = 'claimed' and claim_expires_at < now();

  for v_event in
    select * from public.outbox_events e
    where e.destination_worker_id = v_worker.id and e.state = 'pending' and e.next_attempt_at <= now()
    order by e.created_at
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update skip locked
  loop
    select * into v_profile from public.profiles p where p.id = v_event.profile_id;

    if v_event.event_type = 'review_results' then
      with items as (
        select i as item
        from jsonb_array_elements(v_event.payload -> 'items') i
      ),
      checked as (
        select it.item,
               c.task_id is not null as still_valid,
               c.last_synced_at >= now() - make_interval(secs => v_profile.notify_max_state_age_seconds) as fresh
        from items it
        left join private.notification_candidates(v_event.profile_id) c
          on c.task_id = (it.item ->> 'task_id')::uuid
         and c.result_id = (it.item ->> 'result_id')::uuid
         and c.request_generation = (it.item ->> 'request_generation')::integer
         and c.head_sha = it.item ->> 'head_sha'
      )
      select coalesce(jsonb_agg(item) filter (where still_valid and fresh), '[]'::jsonb),
             count(*) filter (where still_valid and not fresh)
      into v_valid, v_stale
      from checked;

      if v_stale > 0 then
        -- GitHubの最終確認が古い: 実行ホストの再同期を待って保留する（13.3）
        if v_event.created_at < now() - interval '6 hours' then
          update public.outbox_events
          set state = 'cancelled', hold_reason = 'stale_timeout', updated_at = now()
          where id = v_event.id;
        else
          update public.outbox_events
          set hold_reason = 'stale', next_attempt_at = now() + interval '60 seconds', updated_at = now()
          where id = v_event.id;
        end if;
        continue;
      end if;

      v_total := jsonb_array_length(v_valid);
      if v_total = 0 then
        update public.outbox_events
        set state = 'cancelled', hold_reason = 'no_longer_applicable', updated_at = now()
        where id = v_event.id;
        continue;
      end if;
      select count(*) into v_new from jsonb_array_elements(v_valid) i
      where not coalesce((i ->> 'previously_notified')::boolean, false);

      v_event.payload := jsonb_set(
        jsonb_set(v_event.payload, '{items}', v_valid),
        '{counts}', jsonb_build_object('total', v_total, 'new', v_new, 'carried_over', v_total - v_new));
    end if;

    v_token := gen_random_uuid();
    update public.outbox_events
    set state = 'claimed',
        payload = v_event.payload,
        hold_reason = null,
        claim_token = v_token,
        claimed_at = now(),
        claim_expires_at = now() + interval '2 minutes',
        attempts = attempts + 1,
        updated_at = now()
    where id = v_event.id
    returning * into v_event;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'event_id', v_event.id,
      'event_type', v_event.event_type,
      'claim_token', v_token,
      'scheduled_slot_at', v_event.scheduled_slot_at,
      'payload', v_event.payload
    ));
  end loop;

  return v_out;
end;
$$;

-- OSへの表示要求の結果を記録する（13.3の4）。要求成功は確認済みを意味しない。
create function public.notifier_record_delivery(
  p_worker_id text,
  p_event_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_error text default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_worker public.workers := private.require_worker(p_worker_id, 'notifier');
  v_event public.outbox_events;
begin
  select * into v_event from public.outbox_events e
  where e.id = p_event_id and e.destination_worker_id = v_worker.id
  for update;
  if not found then
    raise exception 'kakari: forbidden' using errcode = '42501';
  end if;
  if v_event.state <> 'claimed' or v_event.claim_token is distinct from p_claim_token then
    return jsonb_build_object('ok', false, 'state', v_event.state);
  end if;
  if p_outcome = 'delivered' then
    update public.outbox_events
    set state = 'delivered', delivered_at = now(), delivery_error = null, claim_token = null, updated_at = now()
    where id = v_event.id;
  elsif p_outcome = 'failed' then
    -- 表示されていないことが確かな失敗だけを、間隔を空けて再試行する
    update public.outbox_events
    set state = case when attempts >= 3 then 'failed' else 'pending' end,
        next_attempt_at = now() + make_interval(mins => 5 * attempts),
        delivery_error = left(p_error, 1000),
        claim_token = null,
        updated_at = now()
    where id = v_event.id;
  elsif p_outcome = 'unknown' then
    update public.outbox_events
    set state = 'unknown', delivery_error = left(p_error, 1000), claim_token = null, updated_at = now()
    where id = v_event.id;
  else
    raise exception 'kakari: invalid outcome' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.worker_plan_notification(text, text, timestamptz, boolean)',
    'public.worker_raise_ops_alert(text, text, text, text)',
    'public.notifier_claim_events(text, integer)',
    'public.notifier_record_delivery(text, uuid, uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end;
$$;

revoke all on function
  private.notification_candidates(text),
  private.was_delivered(text, uuid, integer)
from public, anon, authenticated;
