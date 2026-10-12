'use strict';

/**
 * 任务"还在跑"的判定 SQL 片段——**唯一真相源**：/api/v1/task-feed（滚动屏）与主控制台
 * （sessionRegistry 的 runningFloors）都靠它，保证两边口径完全一致，不会一边判活一边判死。
 *
 * 心跳窗口（@cutoff，默认 10min）内还有 active 心跳 = 真在跑；但纯思考（模型在生成、还没调工具）
 * 期间 agent 不发任何心跳，心跳会过期把任务误判成取消 → 主控制台 / 滚动屏在长思考时随机掉回「待命」。
 * 所以再给"最后状态仍是 active"的任务一个更长宽限：只要最近一次 active 状态（state_since）不早于
 * @grace_cutoff，就仍然算在跑。长思考是连续的 thinking，state_since 不会太旧；真死的进程
 * （active 状态卡在很久以前）才会超出宽限被正常判死。
 *
 * 注意：本片段假定查询里 tasks 别名为 `t`、task_runs 别名为 `tr`、members 别名为 `m`。
 *
 * @returns {string} 可直接 `${taskAliveSql()}` 内插的 SQL 条件（外层再 AND 上 t.state='running'）
 */
function taskAliveSql() {
  return `(
    EXISTS (
      SELECT 1 FROM session_status ss
       WHERE ss.member_id = t.member_id AND ss.session_id = tr.session_id
         AND ss.task_id = t.id
         AND (ss.last_heartbeat_at > @cutoff
              OR (ss.state IN ('busy', 'thinking', 'blocked') AND ss.state_since > @grace_cutoff))
    ) OR (
      (tr.session_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM session_status ss
         WHERE ss.member_id = t.member_id AND ss.session_id = tr.session_id
      )) AND EXISTS (
        SELECT 1 FROM agent_status s
         WHERE s.task_id = t.id
           AND (s.last_heartbeat_at > @cutoff
                OR (s.state IN ('busy','thinking','blocked') AND s.state_since > @grace_cutoff))
      )
    )
  )`;
}

module.exports = { taskAliveSql };
