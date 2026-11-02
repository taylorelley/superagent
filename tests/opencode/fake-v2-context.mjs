/**
 * A fake OpenCode V2 plugin context, for driving the plugin without a binary.
 *
 * It models the parts of the V2 contract the plugin depends on, the way the
 * host behaves:
 *
 *   - `transform(callback)` registers a synchronous editor callback, and every
 *     read (`list()`, `editor()`) *replays* every registered transform onto a
 *     fresh value — so a transform with side effects, or one that is not
 *     idempotent, shows up here the same way it would in OpenCode.
 *   - agents start from OpenCode's built-ins, with `Agent.Info.default`'s
 *     shape for a fresh `update(id)`.
 *   - `hook(name, fn)` registrations are recorded and can be fired with
 *     `fire(domain, name, event)`.
 *   - `event.subscribe` returns an async iterable fed by `emit(event)`.
 */

const defaultAgent = (id) => ({
  id,
  name: id,
  request: { settings: {}, headers: {}, body: {} },
  mode: 'primary',
  hidden: false,
  permissions: [
    { action: '*', resource: '*', effect: 'allow' },
    { action: 'read', resource: '*.env', effect: 'ask' },
  ],
});

const BUILTIN_AGENTS = ['build', 'plan', 'general', 'explore'];

/** An agent editor over a Map, matching V2's `AgentEditor`. */
export const makeAgentEditor = (initial = BUILTIN_AGENTS) => {
  const agents = new Map(initial.map((id) => [id, defaultAgent(id)]));
  const state = { default: undefined };
  return {
    agents,
    state,
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    default: (id) => {
      state.default = id;
    },
    update: (id, fn) => {
      if (!agents.has(id)) agents.set(id, defaultAgent(id));
      fn(agents.get(id));
    },
    remove: (id) => agents.delete(id),
  };
};

export const makeSkillEditor = (initial = []) => {
  const skills = new Map(initial.map((s) => [s.id, s]));
  return {
    skills,
    list: () => [...skills.values()],
    get: (id) => skills.get(id),
    add: (skill) => skills.set(skill.id, skill),
    update: (id, fn) => skills.has(id) && fn(skills.get(id)),
    remove: (id) => skills.delete(id),
  };
};

export const makeCommandEditor = () => {
  const commands = new Map();
  return { commands, add: (definition) => commands.set(definition.name, definition) };
};

/** A domain with replayable transforms. `make` builds a fresh editor. */
const transformDomain = (make) => {
  const transforms = [];
  const build = () => {
    const editor = make();
    for (const fn of transforms) fn(editor);
    return editor;
  };
  return {
    transforms,
    transform: async (fn) => {
      transforms.push(fn);
      return { dispose: async () => transforms.splice(transforms.indexOf(fn), 1) };
    },
    reload: async () => {},
    editor: build,
  };
};

export const makeContext = ({
  directory = process.cwd(),
  builtinAgents = BUILTIN_AGENTS,
  userSkills = [],
  existingCommands = [],
} = {}) => {
  const hooks = { session: {}, tool: {}, permission: {}, shell: {} };
  const hookDomain = (domain) => async (name, fn) => {
    (hooks[domain][name] ??= []).push(fn);
    return { dispose: async () => {} };
  };

  const agent = transformDomain(() => makeAgentEditor(builtinAgents));
  const skill = transformDomain(() => makeSkillEditor(userSkills));
  const command = transformDomain(() => makeCommandEditor());

  const listeners = new Set();
  const prompts = [];

  const ctx = {
    app: { version: '2.2.5' },
    location: { directory, project: { id: 'p', directory, canonical: directory } },
    options: {},
    agent: { ...agent, list: async () => ({ data: agent.editor().list() }) },
    skill: { ...skill, list: async () => ({ data: skill.editor().list() }) },
    command: {
      ...command,
      list: async () => ({
        data: [
          ...existingCommands.map((name) => ({ name })),
          ...[...command.editor().commands.values()].map(({ name, description }) => ({
            name,
            description,
          })),
        ],
      }),
    },
    session: {
      hook: hookDomain('session'),
      prompt: async (input) => {
        prompts.push(input);
        return { id: `inbox_${prompts.length}` };
      },
    },
    tool: { hook: hookDomain('tool') },
    permission: { hook: hookDomain('permission') },
    shell: { hook: hookDomain('shell') },
    event: {
      subscribe: ({ types, signal } = {}) => ({
        [Symbol.asyncIterator]() {
          const queue = [];
          let wake = null;
          const listener = (event) => {
            if (types && !types.includes(event.type)) return;
            queue.push(event);
            wake?.();
          };
          listeners.add(listener);
          signal?.addEventListener('abort', () => wake?.());
          return {
            next: async () => {
              while (!queue.length) {
                if (signal?.aborted) {
                  listeners.delete(listener);
                  return { done: true, value: undefined };
                }
                await new Promise((resolve) => (wake = resolve));
                wake = null;
              }
              return { done: false, value: queue.shift() };
            },
            return: async () => {
              listeners.delete(listener);
              return { done: true, value: undefined };
            },
          };
        },
      }),
    },
    storage: new Map(),
  };

  return {
    ctx,
    hooks,
    prompts,
    agents: () => agent.editor(),
    skills: () => skill.editor(),
    commands: () => command.editor().commands,
    /** Fire every hook registered under `domain`/`name` with `event`, in order. */
    fire: async (domain, name, event) => {
      for (const fn of hooks[domain][name] ?? []) await fn(event);
      return event;
    },
    /** Publish an event to every subscriber, then let their loops run. */
    emit: async (event) => {
      for (const listener of listeners) listener(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
};

/** A V2 model-request message. */
export const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
export const assistantMessage = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
export const messageText = (message) =>
  (message?.content ?? []).map((part) => part.text ?? '').join('');
