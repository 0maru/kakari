export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: { extensions?: Json; operationName?: string; query?: string; variables?: Json };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      app_settings: {
        Row: {
          debounce_seconds: number;
          execution_timeout_seconds: number;
          id: boolean;
          lease_seconds: number;
          max_auto_retries: number;
          max_auto_starts_per_day: number;
          max_concurrent_reviews: number;
          timezone: string;
          updated_at: string;
        };
        Insert: {
          debounce_seconds?: number;
          execution_timeout_seconds?: number;
          id?: boolean;
          lease_seconds?: number;
          max_auto_retries?: number;
          max_auto_starts_per_day?: number;
          max_concurrent_reviews?: number;
          timezone?: string;
          updated_at?: string;
        };
        Update: {
          debounce_seconds?: number;
          execution_timeout_seconds?: number;
          id?: boolean;
          lease_seconds?: number;
          max_auto_retries?: number;
          max_auto_starts_per_day?: number;
          max_concurrent_reviews?: number;
          timezone?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      app_users: {
        Row: {
          created_at: string;
          display_name: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          display_name?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          display_name?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      github_rate_limits: {
        Row: {
          blocked_until: string | null;
          github_host: string;
          limit_value: number | null;
          observed_at: string;
          owner_id: string;
          principal: string;
          remaining: number | null;
          reset_at: string | null;
          resource: string;
          wait_reason: string | null;
        };
        Insert: {
          blocked_until?: string | null;
          github_host: string;
          limit_value?: number | null;
          observed_at?: string;
          owner_id: string;
          principal: string;
          remaining?: number | null;
          reset_at?: string | null;
          resource: string;
          wait_reason?: string | null;
        };
        Update: {
          blocked_until?: string | null;
          github_host?: string;
          limit_value?: number | null;
          observed_at?: string;
          owner_id?: string;
          principal?: string;
          remaining?: number | null;
          reset_at?: string | null;
          resource?: string;
          wait_reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'github_rate_limits_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'app_users';
            referencedColumns: ['user_id'];
          },
        ];
      };
      outbox_events: {
        Row: {
          attempts: number;
          claim_expires_at: string | null;
          claim_token: string | null;
          claimed_at: string | null;
          created_at: string;
          delivered_at: string | null;
          delivery_error: string | null;
          destination_worker_id: string;
          event_type: string;
          hold_reason: string | null;
          id: string;
          idempotency_key: string;
          next_attempt_at: string;
          payload: NonNullable<Json>;
          profile_id: string;
          scheduled_slot_at: string | null;
          state: string;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          claim_expires_at?: string | null;
          claim_token?: string | null;
          claimed_at?: string | null;
          created_at?: string;
          delivered_at?: string | null;
          delivery_error?: string | null;
          destination_worker_id: string;
          event_type: string;
          hold_reason?: string | null;
          id?: string;
          idempotency_key: string;
          next_attempt_at?: string;
          payload: NonNullable<Json>;
          profile_id: string;
          scheduled_slot_at?: string | null;
          state?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          claim_expires_at?: string | null;
          claim_token?: string | null;
          claimed_at?: string | null;
          created_at?: string;
          delivered_at?: string | null;
          delivery_error?: string | null;
          destination_worker_id?: string;
          event_type?: string;
          hold_reason?: string | null;
          id?: string;
          idempotency_key?: string;
          next_attempt_at?: string;
          payload?: NonNullable<Json>;
          profile_id?: string;
          scheduled_slot_at?: string | null;
          state?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'outbox_events_destination_worker_id_fkey';
            columns: ['destination_worker_id'];
            isOneToOne: false;
            referencedRelation: 'workers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'outbox_events_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      profile_sync_states: {
        Row: {
          discovery_error: string | null;
          discovery_status: string | null;
          incomplete_scopes: NonNullable<Json>;
          last_discovery_at: string | null;
          last_discovery_success_at: string | null;
          last_planned_slot_at: string | null;
          profile_id: string;
          updated_at: string;
        };
        Insert: {
          discovery_error?: string | null;
          discovery_status?: string | null;
          incomplete_scopes?: NonNullable<Json>;
          last_discovery_at?: string | null;
          last_discovery_success_at?: string | null;
          last_planned_slot_at?: string | null;
          profile_id: string;
          updated_at?: string;
        };
        Update: {
          discovery_error?: string | null;
          discovery_status?: string | null;
          incomplete_scopes?: NonNullable<Json>;
          last_discovery_at?: string | null;
          last_discovery_success_at?: string | null;
          last_planned_slot_at?: string | null;
          profile_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'profile_sync_states_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      profiles: {
        Row: {
          auth_mode: string;
          created_at: string;
          enabled: boolean;
          github_host: string;
          id: string;
          name: string;
          notify_destination_worker_id: string | null;
          notify_detail_level: string;
          notify_max_state_age_seconds: number;
          notify_repeat_until_acknowledged: boolean;
          notify_times: string[];
          notify_timezone: string;
          notify_weekdays: string[];
          owner_id: string;
          paused: boolean;
          provider: string;
          retention_logs_days: number;
          retention_results_days: number;
          review_config_version: string;
          reviewer_github_id: string | null;
          reviewer_login: string;
          updated_at: string;
          usage_pool_id: string;
        };
        Insert: {
          auth_mode?: string;
          created_at?: string;
          enabled?: boolean;
          github_host: string;
          id: string;
          name: string;
          notify_destination_worker_id?: string | null;
          notify_detail_level?: string;
          notify_max_state_age_seconds?: number;
          notify_repeat_until_acknowledged?: boolean;
          notify_times?: string[];
          notify_timezone?: string;
          notify_weekdays?: string[];
          owner_id: string;
          paused?: boolean;
          provider: string;
          retention_logs_days?: number;
          retention_results_days?: number;
          review_config_version: string;
          reviewer_github_id?: string | null;
          reviewer_login: string;
          updated_at?: string;
          usage_pool_id: string;
        };
        Update: {
          auth_mode?: string;
          created_at?: string;
          enabled?: boolean;
          github_host?: string;
          id?: string;
          name?: string;
          notify_destination_worker_id?: string | null;
          notify_detail_level?: string;
          notify_max_state_age_seconds?: number;
          notify_repeat_until_acknowledged?: boolean;
          notify_times?: string[];
          notify_timezone?: string;
          notify_weekdays?: string[];
          owner_id?: string;
          paused?: boolean;
          provider?: string;
          retention_logs_days?: number;
          retention_results_days?: number;
          review_config_version?: string;
          reviewer_github_id?: string | null;
          reviewer_login?: string;
          updated_at?: string;
          usage_pool_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'profiles_notify_destination_worker_id_fkey';
            columns: ['notify_destination_worker_id'];
            isOneToOne: false;
            referencedRelation: 'workers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'profiles_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'app_users';
            referencedColumns: ['user_id'];
          },
          {
            foreignKeyName: 'profiles_usage_pool_id_fkey';
            columns: ['usage_pool_id'];
            isOneToOne: false;
            referencedRelation: 'usage_pools';
            referencedColumns: ['id'];
          },
        ];
      };
      pull_requests: {
        Row: {
          author_login: string | null;
          base_ref: string | null;
          base_sha: string | null;
          body_hash: string | null;
          created_at: string;
          draft: boolean;
          github_host: string;
          head_changed_at: string | null;
          head_ref: string | null;
          head_sha: string | null;
          id: string;
          last_sync_attempt_at: string | null;
          last_synced_at: string | null;
          pr_number: number;
          profile_id: string;
          repository_full_name: string;
          repository_id: string;
          state: string;
          sync_error: string | null;
          sync_status: string;
          title: string;
          updated_at: string;
          url: string;
        };
        Insert: {
          author_login?: string | null;
          base_ref?: string | null;
          base_sha?: string | null;
          body_hash?: string | null;
          created_at?: string;
          draft?: boolean;
          github_host: string;
          head_changed_at?: string | null;
          head_ref?: string | null;
          head_sha?: string | null;
          id?: string;
          last_sync_attempt_at?: string | null;
          last_synced_at?: string | null;
          pr_number: number;
          profile_id: string;
          repository_full_name: string;
          repository_id: string;
          state: string;
          sync_error?: string | null;
          sync_status?: string;
          title?: string;
          updated_at?: string;
          url: string;
        };
        Update: {
          author_login?: string | null;
          base_ref?: string | null;
          base_sha?: string | null;
          body_hash?: string | null;
          created_at?: string;
          draft?: boolean;
          github_host?: string;
          head_changed_at?: string | null;
          head_ref?: string | null;
          head_sha?: string | null;
          id?: string;
          last_sync_attempt_at?: string | null;
          last_synced_at?: string | null;
          pr_number?: number;
          profile_id?: string;
          repository_full_name?: string;
          repository_id?: string;
          state?: string;
          sync_error?: string | null;
          sync_status?: string;
          title?: string;
          updated_at?: string;
          url?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'pull_requests_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      review_attempts: {
        Row: {
          attempt_number: number;
          base_sha: string | null;
          cli_version: string | null;
          error_class: string | null;
          error_message: string | null;
          execution_id: string;
          finished_at: string | null;
          head_sha: string;
          id: string;
          input_hash: string | null;
          input_manifest: Json | null;
          job_id: string;
          late: boolean;
          late_payload: Json | null;
          launch_state: string;
          launched_at: string | null;
          lease_token: string;
          merge_base_sha: string | null;
          outcome: string | null;
          provider: string;
          provider_session_id: string | null;
          reserved_at: string;
          usage: Json | null;
          usage_pool_id: string;
          worker_id: string;
        };
        Insert: {
          attempt_number: number;
          base_sha?: string | null;
          cli_version?: string | null;
          error_class?: string | null;
          error_message?: string | null;
          execution_id?: string;
          finished_at?: string | null;
          head_sha: string;
          id?: string;
          input_hash?: string | null;
          input_manifest?: Json | null;
          job_id: string;
          late?: boolean;
          late_payload?: Json | null;
          launch_state?: string;
          launched_at?: string | null;
          lease_token: string;
          merge_base_sha?: string | null;
          outcome?: string | null;
          provider: string;
          provider_session_id?: string | null;
          reserved_at?: string;
          usage?: Json | null;
          usage_pool_id: string;
          worker_id: string;
        };
        Update: {
          attempt_number?: number;
          base_sha?: string | null;
          cli_version?: string | null;
          error_class?: string | null;
          error_message?: string | null;
          execution_id?: string;
          finished_at?: string | null;
          head_sha?: string;
          id?: string;
          input_hash?: string | null;
          input_manifest?: Json | null;
          job_id?: string;
          late?: boolean;
          late_payload?: Json | null;
          launch_state?: string;
          launched_at?: string | null;
          lease_token?: string;
          merge_base_sha?: string | null;
          outcome?: string | null;
          provider?: string;
          provider_session_id?: string | null;
          reserved_at?: string;
          usage?: Json | null;
          usage_pool_id?: string;
          worker_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'review_attempts_job_id_fkey';
            columns: ['job_id'];
            isOneToOne: false;
            referencedRelation: 'review_jobs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_attempts_job_id_fkey';
            columns: ['job_id'];
            isOneToOne: false;
            referencedRelation: 'task_overview';
            referencedColumns: ['current_job_id'];
          },
        ];
      };
      review_jobs: {
        Row: {
          adopted_result_id: string | null;
          attempt_count: number;
          auto_retry_count: number;
          base_sha: string | null;
          created_at: string;
          current_attempt_id: string | null;
          error_class: string | null;
          error_message: string | null;
          finished_at: string | null;
          head_sha: string;
          id: string;
          lease_expires_at: string | null;
          lease_token: string | null;
          manual_generation: number;
          manual_reason: string | null;
          not_before: string;
          profile_id: string;
          provider: string;
          requested_by: string | null;
          review_config_version: string;
          review_task_id: string;
          slot_held: boolean;
          status: string;
          updated_at: string;
          worker_id: string | null;
        };
        Insert: {
          adopted_result_id?: string | null;
          attempt_count?: number;
          auto_retry_count?: number;
          base_sha?: string | null;
          created_at?: string;
          current_attempt_id?: string | null;
          error_class?: string | null;
          error_message?: string | null;
          finished_at?: string | null;
          head_sha: string;
          id?: string;
          lease_expires_at?: string | null;
          lease_token?: string | null;
          manual_generation?: number;
          manual_reason?: string | null;
          not_before?: string;
          profile_id: string;
          provider: string;
          requested_by?: string | null;
          review_config_version: string;
          review_task_id: string;
          slot_held?: boolean;
          status?: string;
          updated_at?: string;
          worker_id?: string | null;
        };
        Update: {
          adopted_result_id?: string | null;
          attempt_count?: number;
          auto_retry_count?: number;
          base_sha?: string | null;
          created_at?: string;
          current_attempt_id?: string | null;
          error_class?: string | null;
          error_message?: string | null;
          finished_at?: string | null;
          head_sha?: string;
          id?: string;
          lease_expires_at?: string | null;
          lease_token?: string | null;
          manual_generation?: number;
          manual_reason?: string | null;
          not_before?: string;
          profile_id?: string;
          provider?: string;
          requested_by?: string | null;
          review_config_version?: string;
          review_task_id?: string;
          slot_held?: boolean;
          status?: string;
          updated_at?: string;
          worker_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'review_jobs_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_jobs_review_task_id_fkey';
            columns: ['review_task_id'];
            isOneToOne: false;
            referencedRelation: 'review_tasks';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_jobs_review_task_id_fkey';
            columns: ['review_task_id'];
            isOneToOne: false;
            referencedRelation: 'task_overview';
            referencedColumns: ['task_id'];
          },
          {
            foreignKeyName: 'review_jobs_worker_id_fkey';
            columns: ['worker_id'];
            isOneToOne: false;
            referencedRelation: 'workers';
            referencedColumns: ['id'];
          },
        ];
      };
      review_request_signals: {
        Row: {
          event_at: string | null;
          evidence: NonNullable<Json>;
          github_observation_id: string;
          id: string;
          kind: string;
          observed_at: string;
          request_generation: number;
          review_task_id: string;
          state: string;
        };
        Insert: {
          event_at?: string | null;
          evidence?: NonNullable<Json>;
          github_observation_id: string;
          id?: string;
          kind?: string;
          observed_at?: string;
          request_generation: number;
          review_task_id: string;
          state: string;
        };
        Update: {
          event_at?: string | null;
          evidence?: NonNullable<Json>;
          github_observation_id?: string;
          id?: string;
          kind?: string;
          observed_at?: string;
          request_generation?: number;
          review_task_id?: string;
          state?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'review_request_signals_review_task_id_fkey';
            columns: ['review_task_id'];
            isOneToOne: false;
            referencedRelation: 'review_tasks';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_request_signals_review_task_id_fkey';
            columns: ['review_task_id'];
            isOneToOne: false;
            referencedRelation: 'task_overview';
            referencedColumns: ['task_id'];
          },
        ];
      };
      review_results: {
        Row: {
          attempt_id: string;
          base_sha: string | null;
          body_deleted_at: string | null;
          cli_version: string | null;
          created_at: string;
          findings_count: number | null;
          head_sha: string;
          id: string;
          job_id: string;
          manual_generation: number;
          max_severity: string | null;
          merge_base_sha: string | null;
          pr_body_hash: string | null;
          profile_id: string;
          provider: string;
          quality_status: string;
          raw_output: string | null;
          result: Json | null;
          result_hash: string;
          review_config_version: string;
          review_task_id: string;
          structured: boolean;
          summary: string | null;
        };
        Insert: {
          attempt_id: string;
          base_sha?: string | null;
          body_deleted_at?: string | null;
          cli_version?: string | null;
          created_at?: string;
          findings_count?: number | null;
          head_sha: string;
          id?: string;
          job_id: string;
          manual_generation: number;
          max_severity?: string | null;
          merge_base_sha?: string | null;
          pr_body_hash?: string | null;
          profile_id: string;
          provider: string;
          quality_status: string;
          raw_output?: string | null;
          result?: Json | null;
          result_hash: string;
          review_config_version: string;
          review_task_id: string;
          structured: boolean;
          summary?: string | null;
        };
        Update: {
          attempt_id?: string;
          base_sha?: string | null;
          body_deleted_at?: string | null;
          cli_version?: string | null;
          created_at?: string;
          findings_count?: number | null;
          head_sha?: string;
          id?: string;
          job_id?: string;
          manual_generation?: number;
          max_severity?: string | null;
          merge_base_sha?: string | null;
          pr_body_hash?: string | null;
          profile_id?: string;
          provider?: string;
          quality_status?: string;
          raw_output?: string | null;
          result?: Json | null;
          result_hash?: string;
          review_config_version?: string;
          review_task_id?: string;
          structured?: boolean;
          summary?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'review_results_attempt_id_fkey';
            columns: ['attempt_id'];
            isOneToOne: true;
            referencedRelation: 'review_attempts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_results_job_id_fkey';
            columns: ['job_id'];
            isOneToOne: false;
            referencedRelation: 'review_jobs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_results_job_id_fkey';
            columns: ['job_id'];
            isOneToOne: false;
            referencedRelation: 'task_overview';
            referencedColumns: ['current_job_id'];
          },
          {
            foreignKeyName: 'review_results_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_results_review_task_id_fkey';
            columns: ['review_task_id'];
            isOneToOne: false;
            referencedRelation: 'review_tasks';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_results_review_task_id_fkey';
            columns: ['review_task_id'];
            isOneToOne: false;
            referencedRelation: 'task_overview';
            referencedColumns: ['task_id'];
          },
        ];
      };
      review_tasks: {
        Row: {
          acked_at: string | null;
          acked_generation: number | null;
          acked_result_id: string | null;
          created_at: string;
          current_result_id: string | null;
          done_at: string | null;
          done_generation: number | null;
          done_reason: string | null;
          done_source: string | null;
          human_state: string;
          id: string;
          profile_id: string;
          pull_request_id: string;
          request_generation: number;
          request_kind: string;
          request_state: string;
          reviewer_github_id: string;
          reviewer_login: string;
          revision: number;
          snoozed_until: string | null;
          updated_at: string;
        };
        Insert: {
          acked_at?: string | null;
          acked_generation?: number | null;
          acked_result_id?: string | null;
          created_at?: string;
          current_result_id?: string | null;
          done_at?: string | null;
          done_generation?: number | null;
          done_reason?: string | null;
          done_source?: string | null;
          human_state?: string;
          id?: string;
          profile_id: string;
          pull_request_id: string;
          request_generation?: number;
          request_kind?: string;
          request_state?: string;
          reviewer_github_id: string;
          reviewer_login: string;
          revision?: number;
          snoozed_until?: string | null;
          updated_at?: string;
        };
        Update: {
          acked_at?: string | null;
          acked_generation?: number | null;
          acked_result_id?: string | null;
          created_at?: string;
          current_result_id?: string | null;
          done_at?: string | null;
          done_generation?: number | null;
          done_reason?: string | null;
          done_source?: string | null;
          human_state?: string;
          id?: string;
          profile_id?: string;
          pull_request_id?: string;
          request_generation?: number;
          request_kind?: string;
          request_state?: string;
          reviewer_github_id?: string;
          reviewer_login?: string;
          revision?: number;
          snoozed_until?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'review_tasks_acked_result_fk';
            columns: ['acked_result_id'];
            isOneToOne: false;
            referencedRelation: 'review_results';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_tasks_current_result_fk';
            columns: ['current_result_id'];
            isOneToOne: false;
            referencedRelation: 'review_results';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_tasks_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_tasks_pull_request_id_fkey';
            columns: ['pull_request_id'];
            isOneToOne: false;
            referencedRelation: 'pull_requests';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_tasks_pull_request_id_fkey';
            columns: ['pull_request_id'];
            isOneToOne: false;
            referencedRelation: 'task_overview';
            referencedColumns: ['pull_request_id'];
          },
        ];
      };
      task_operations: {
        Row: {
          actor_id: string;
          created_at: string;
          id: string;
          op_type: string;
          operation_id: string;
          outcome: string;
          profile_id: string | null;
          request_hash: string;
          response: NonNullable<Json>;
          review_task_id: string | null;
          revision_after: number | null;
          revision_before: number | null;
          target_generation: number | null;
          target_job_id: string | null;
          target_result_id: string | null;
        };
        Insert: {
          actor_id: string;
          created_at?: string;
          id?: string;
          op_type: string;
          operation_id: string;
          outcome: string;
          profile_id?: string | null;
          request_hash: string;
          response: NonNullable<Json>;
          review_task_id?: string | null;
          revision_after?: number | null;
          revision_before?: number | null;
          target_generation?: number | null;
          target_job_id?: string | null;
          target_result_id?: string | null;
        };
        Update: {
          actor_id?: string;
          created_at?: string;
          id?: string;
          op_type?: string;
          operation_id?: string;
          outcome?: string;
          profile_id?: string | null;
          request_hash?: string;
          response?: NonNullable<Json>;
          review_task_id?: string | null;
          revision_after?: number | null;
          revision_before?: number | null;
          target_generation?: number | null;
          target_job_id?: string | null;
          target_result_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'task_operations_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'task_operations_review_task_id_fkey';
            columns: ['review_task_id'];
            isOneToOne: false;
            referencedRelation: 'review_tasks';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'task_operations_review_task_id_fkey';
            columns: ['review_task_id'];
            isOneToOne: false;
            referencedRelation: 'task_overview';
            referencedColumns: ['task_id'];
          },
        ];
      };
      usage_pools: {
        Row: {
          blocked_manual: boolean;
          blocked_reason: string | null;
          blocked_until: string | null;
          created_at: string;
          id: string;
          max_concurrent: number;
          owner_id: string;
          provider: string;
          updated_at: string;
        };
        Insert: {
          blocked_manual?: boolean;
          blocked_reason?: string | null;
          blocked_until?: string | null;
          created_at?: string;
          id: string;
          max_concurrent?: number;
          owner_id: string;
          provider: string;
          updated_at?: string;
        };
        Update: {
          blocked_manual?: boolean;
          blocked_reason?: string | null;
          blocked_until?: string | null;
          created_at?: string;
          id?: string;
          max_concurrent?: number;
          owner_id?: string;
          provider?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'usage_pools_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'app_users';
            referencedColumns: ['user_id'];
          },
        ];
      };
      worker_profiles: {
        Row: {
          profile_id: string;
          worker_id: string;
        };
        Insert: {
          profile_id: string;
          worker_id: string;
        };
        Update: {
          profile_id?: string;
          worker_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'worker_profiles_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'worker_profiles_worker_id_fkey';
            columns: ['worker_id'];
            isOneToOne: false;
            referencedRelation: 'workers';
            referencedColumns: ['id'];
          },
        ];
      };
      workers: {
        Row: {
          auth_user_id: string | null;
          capabilities: NonNullable<Json>;
          created_at: string;
          id: string;
          last_seen_at: string | null;
          owner_id: string;
          roles: string[];
          updated_at: string;
        };
        Insert: {
          auth_user_id?: string | null;
          capabilities?: NonNullable<Json>;
          created_at?: string;
          id: string;
          last_seen_at?: string | null;
          owner_id: string;
          roles: string[];
          updated_at?: string;
        };
        Update: {
          auth_user_id?: string | null;
          capabilities?: NonNullable<Json>;
          created_at?: string;
          id?: string;
          last_seen_at?: string | null;
          owner_id?: string;
          roles?: string[];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'workers_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'app_users';
            referencedColumns: ['user_id'];
          },
        ];
      };
    };
    Views: {
      task_overview: {
        Row: {
          acked_generation: number | null;
          acked_result_id: string | null;
          base_sha: string | null;
          current_job_error_class: string | null;
          current_job_id: string | null;
          current_job_not_before: string | null;
          current_job_status: string | null;
          current_result_id: string | null;
          display_state: string | null;
          done_at: string | null;
          done_reason: string | null;
          done_source: string | null;
          github_host: string | null;
          head_sha: string | null;
          human_state: string | null;
          is_acked: boolean | null;
          last_synced_at: string | null;
          pr_author_login: string | null;
          pr_draft: boolean | null;
          pr_number: number | null;
          pr_state: string | null;
          pr_title: string | null;
          pr_url: string | null;
          premise_changed: boolean | null;
          profile_enabled: boolean | null;
          profile_id: string | null;
          profile_name: string | null;
          profile_paused: boolean | null;
          pull_request_id: string | null;
          repository_full_name: string | null;
          repository_id: string | null;
          request_generation: number | null;
          request_state: string | null;
          result_body_deleted_at: string | null;
          result_config_version: string | null;
          result_created_at: string | null;
          result_findings_count: number | null;
          result_head_sha: string | null;
          result_is_current: boolean | null;
          result_max_severity: string | null;
          result_quality_status: string | null;
          result_summary: string | null;
          reviewer_login: string | null;
          revision: number | null;
          snoozed_until: string | null;
          sort_group: number | null;
          sync_error: string | null;
          sync_status: string | null;
          task_id: string | null;
          updated_at: string | null;
          waiting_reason: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'review_tasks_acked_result_fk';
            columns: ['acked_result_id'];
            isOneToOne: false;
            referencedRelation: 'review_results';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_tasks_current_result_fk';
            columns: ['current_result_id'];
            isOneToOne: false;
            referencedRelation: 'review_results';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_tasks_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Functions: {
      acknowledge_result: {
        Args: {
          p_expected_revision: number;
          p_operation_id: string;
          p_request_generation: number;
          p_result_id: string;
          p_task_id: string;
        };
        Returns: Json;
      };
      clear_usage_pool_block: {
        Args: { p_operation_id: string; p_pool_id: string };
        Returns: Json;
      };
      complete_review_task: {
        Args: {
          p_expected_revision: number;
          p_operation_id: string;
          p_reason: string;
          p_request_generation: number;
          p_task_id: string;
        };
        Returns: Json;
      };
      notifier_claim_events: { Args: { p_limit?: number; p_worker_id: string }; Returns: Json };
      notifier_record_delivery: {
        Args: {
          p_claim_token: string;
          p_error?: string;
          p_event_id: string;
          p_outcome: string;
          p_worker_id: string;
        };
        Returns: Json;
      };
      request_manual_review: {
        Args: {
          p_confirm: Json;
          p_expected_revision: number;
          p_job_id: string;
          p_operation_id: string;
          p_reason: string;
        };
        Returns: Json;
      };
      request_review_retry: {
        Args: {
          p_confirm: Json;
          p_expected_revision: number;
          p_job_id: string;
          p_operation_id: string;
        };
        Returns: Json;
      };
      set_profile_paused: {
        Args: { p_operation_id: string; p_paused: boolean; p_profile_id: string };
        Returns: Json;
      };
      set_task_snooze: {
        Args: {
          p_expected_revision: number;
          p_operation_id: string;
          p_task_id: string;
          p_until: string;
        };
        Returns: Json;
      };
      worker_acquire_job: { Args: { p_worker_id: string }; Returns: Json };
      worker_apply_retention: { Args: { p_worker_id: string }; Returns: Json };
      worker_block_usage_pool: {
        Args: { p_pool_id: string; p_reason: string; p_until: string; p_worker_id: string };
        Returns: undefined;
      };
      worker_complete_attempt: {
        Args: {
          p_execution_id: string;
          p_lease_token: string;
          p_payload: Json;
          p_worker_id: string;
        };
        Returns: Json;
      };
      worker_heartbeat: { Args: { p_capabilities?: Json; p_worker_id: string }; Returns: Json };
      worker_mark_launched: {
        Args: {
          p_execution_id: string;
          p_lease_token: string;
          p_snapshot: Json;
          p_worker_id: string;
        };
        Returns: Json;
      };
      worker_mark_pull_request_sync_failed: {
        Args: { p_error: string; p_pull_request_id: string; p_status: string; p_worker_id: string };
        Returns: undefined;
      };
      worker_plan_notification: {
        Args: {
          p_exclude_stale?: boolean;
          p_profile_id: string;
          p_slot_at: string;
          p_worker_id: string;
        };
        Returns: Json;
      };
      worker_raise_ops_alert: {
        Args: { p_kind: string; p_message: string; p_profile_id: string; p_worker_id: string };
        Returns: Json;
      };
      worker_record_discovery: {
        Args: {
          p_error: string;
          p_incomplete_scopes: Json;
          p_profile_id: string;
          p_status: string;
          p_worker_id: string;
        };
        Returns: undefined;
      };
      worker_record_rate_limits: {
        Args: { p_rows: Json; p_worker_id: string };
        Returns: undefined;
      };
      worker_release_job: {
        Args: {
          p_disposition: string;
          p_error_class: string;
          p_error_message: string;
          p_execution_id: string;
          p_lease_token: string;
          p_pool_block?: Json;
          p_retry_after_seconds?: number;
          p_worker_id: string;
        };
        Returns: Json;
      };
      worker_renew_lease: {
        Args: { p_execution_id: string; p_lease_token: string; p_worker_id: string };
        Returns: Json;
      };
      worker_resolve_unknown: {
        Args: {
          p_error_message: string;
          p_execution_id: string;
          p_lease_token: string;
          p_resolution: string;
          p_worker_id: string;
        };
        Returns: Json;
      };
      worker_set_reviewer_identity: {
        Args: { p_github_id: string; p_profile_id: string; p_worker_id: string };
        Returns: undefined;
      };
      worker_sync_pull_request: {
        Args: { p_pr: Json; p_profile_id: string; p_request: Json; p_worker_id: string };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema['Enums']
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
