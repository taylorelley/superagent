import * as board from '../../core/board.js';
import { checkTool, toolAction } from './permissions.js';
import { describeTool } from '../../core/activity.js';

const context = (event, text) =>
  text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
const childId = (value) => {
  if (typeof value === 'string') {
    try {
      return childId(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value?.agent_id ?? value?.id ?? value?.session_id ?? null;
};
export function handleEvent(input, state, settings, adapter) {
  board.restoreBoardState(state.boards);
  const event = input.hook_event_name;
  const session = (state.sessions[input.session_id] ??= {});
  const roleName = input.agent_type ?? session.role;
  const isController =
    !input.agent_id && (!roleName || roleName === 'default' || roleName === 'superagent');
  const role = isController
    ? settings.agents.setDefaultAgent !== false
      ? adapter.orchestrator
      : null
    : adapter.registered.find((r) => r.name === roleName);
  let output = {};
  if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'PostCompact') {
    const controller = isController && settings.agents.setDefaultAgent !== false;
    const bootstrap = !session.bootstrapped || event === 'PostCompact';
    output = context(
      event,
      [
        controller && bootstrap ? role?.prompt : '',
        bootstrap && isController ? adapter.bootstrap : '',
        settings.board.enabled ? board.renderBoard(input.session_id) : '',
        ...adapter.warnings,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    session.bootstrapped = true;
  }
  if (event === 'PreModelRequest')
    state.activity[input.agent_id ?? input.session_id] = {
      tool: 'thinking',
      startedAt: Date.now(),
    };
  if (event === 'PostModelRequest') delete state.activity[input.agent_id ?? input.session_id];
  if (event === 'SubagentStart') {
    state.sessions[input.agent_id] = { role: input.agent_type, parent: input.session_id };
  }
  if (event === 'PreToolUse') {
    const command = input.tool_input?.cmd ?? input.tool_input?.command ?? '';
    const skill =
      typeof command === 'string' ? command.match(/[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md/) : null;
    if (skill) session.skill = skill[1];
    if (/(?:^|[.:])update_plan$/.test(input.tool_name) && Array.isArray(input.tool_input?.plan)) {
      const steps = input.tool_input.plan;
      session.plan = {
        name: input.tool_input.explanation ?? 'Task plan',
        total: steps.length,
        done: steps.filter((s) => s.status === 'completed').length,
        current: steps.find((s) => s.status === 'in_progress')?.step,
      };
    }

    const requestedRole = input.tool_input?.agent_type;
    const unavailable =
      /spawn_agent$/.test(input.tool_name) &&
      typeof requestedRole === 'string' &&
      requestedRole.startsWith('superagent-') &&
      !adapter.specialists.some((r) => r.name === requestedRole);
    const result = unavailable
      ? {
          effect: 'deny',
          reason: `Superagent role ${requestedRole} is disabled, uninstalled, or requires a refresh and new session`,
        }
      : checkTool(role?.rules ?? [], input.tool_name, input.tool_input, input.cwd);
    if (result.effect === 'deny' || result.effect === 'ask') {
      output = {
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: result.effect,
          permissionDecisionReason: result.reason,
        },
      };
    } else {
      state.activity[input.agent_id ?? input.session_id] = {
        tool: describeTool(toolAction(input.tool_name) ?? input.tool_name, {
          ...input.tool_input,
          command: input.tool_input?.cmd ?? input.tool_input?.command,
          agent: input.tool_input?.agent_type,
        }),
        startedAt: Date.now(),
      };
      if (/(?:send_input|followup_task|resume_agent)$/.test(input.tool_name)) {
        board.reviveChild(input.tool_input?.target ?? input.tool_input?.id);
      }
      if (toolAction(input.tool_name) === 'subagent' && /spawn_agent$/.test(input.tool_name)) {
        const args = {
          agent: input.tool_input.agent_type,
          description: input.tool_input.description ?? input.tool_input.message?.split('\n')[0],
          prompt: input.tool_input.message ?? input.tool_input.prompt,
          background: true,
        };
        board.onDispatch(input.session_id, input.tool_use_id, args, settings);
        if (args.prompt !== (input.tool_input.message ?? input.tool_input.prompt)) {
          const key = 'message' in input.tool_input ? 'message' : 'prompt';
          output = {
            hookSpecificOutput: {
              hookEventName: event,
              updatedInput: { ...input.tool_input, [key]: args.prompt },
            },
          };
        }
      }
    }
  }
  if (event === 'PostToolUse') {
    delete state.activity[input.agent_id ?? input.session_id];
    if (/spawn_agent$/.test(input.tool_name)) {
      const child = childId(input.tool_response);
      if (child) board.linkChild(input.session_id, input.tool_use_id, child);
      else board.failDispatch(input.session_id, input.tool_use_id, 'Dispatch returned no child id');
    }
    if (/close_agent$/.test(input.tool_name))
      board.settleChild(input.tool_input?.target ?? input.tool_input?.id, 'error', 'Agent closed');
    output = context(event, settings.board.enabled ? board.renderBoard(input.session_id) : '');
  }
  if (event === 'SubagentStop') {
    const answer = input.last_assistant_message;
    board.settleChild(
      input.agent_id,
      typeof answer === 'string' && answer.trim() ? 'completed' : 'error',
      answer || 'Agent stopped without a final answer',
    );
    delete state.activity[input.agent_id];
  }
  if (event === 'Interrupt' || event === 'SessionEnd') {
    if (input.agent_id) board.settleChild(input.agent_id, 'error', event);
    delete state.activity[input.agent_id ?? input.session_id];
  }
  state.boards = board.exportBoardState();
  return output;
}
