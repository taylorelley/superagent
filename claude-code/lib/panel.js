/**
 * The Superagent panel, drawn in a Claude Code pane.
 *
 * The layout is `core/panel.js`, the same function OpenCode's sidebar draws:
 * it builds its tree through a factory (`h.box`, `h.text`), so the two hosts
 * differ only in that factory. This one turns OpenTUI-shaped props into the
 * elements a Claude Code render hook gets from `$.ui.resolve(e)`:
 *
 * - `fg` → a theme `color`, or `dimColor` for the muted token;
 * - `attributes` with the bold bit → `bold`;
 * - `onMouseDown` → a `Button` (Claude Code's pressable element), whose
 *   children may only be text, so a pressable row keeps its text runs and
 *   drops its spacer boxes.
 */

import { renderPanel } from '../../core/panel.js';

/** A sentinel the factory turns into `dimColor` rather than a colour. */
const MUTED = '\u0000muted';

/** The panel's colour tokens as Claude Code theme keys. */
export const PANEL_THEME = {
  text: undefined,
  textMuted: MUTED,
  accent: 'claude',
  info: 'suggestion',
  success: 'success',
  error: 'error',
  warning: 'warning',
};

const BOLD = 1;

const textStyle = (props) => {
  const style = {};
  if (props?.fg === MUTED) style.dimColor = true;
  else if (typeof props?.fg === 'string') style.color = props.fg;
  if (typeof props?.attributes === 'number' && props.attributes & BOLD) style.bold = true;
  return style;
};

const BOX_PROPS = [
  'flexDirection',
  'justifyContent',
  'alignItems',
  'flexGrow',
  'marginTop',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
];

const boxStyle = (props) => {
  const style = {};
  for (const key of BOX_PROPS) if (props?.[key] !== undefined) style[key] = props[key];
  return style;
};

/**
 * A factory over a surface's element table (`{ Box, Text, Button }`).
 *
 * Every pressable element gets a stable key from its position, so a redraw
 * keeps focus where it was.
 */
export const panelFactory = (elements, width = 35) => {
  const { Box, Text, Button } = elements;
  /** Each text element drawn, and how many columns it takes. */
  const texts = new WeakMap();
  let pressables = 0;

  const text = (props, children) => {
    const content = (children ?? []).map((c) => String(c ?? '')).join('');
    const node = Text({ ...textStyle(props), children: content });
    if (typeof props?.onMouseDown === 'function' && Button) {
      const onPress = props.onMouseDown;
      pressables += 1;
      return Button({
        key: `superagent-press-${pressables}`,
        label: content,
        plain: true,
        onPress: () => onPress(),
        children: [node],
      });
    }
    if (node && typeof node === 'object') texts.set(node, content.length);
    return node;
  };

  const box = (props, children) => {
    const kids = (children ?? []).filter((c) => c !== null && c !== undefined);
    if (typeof props?.onMouseDown === 'function' && Button) {
      const onPress = props.onMouseDown;
      // A Button holds only text, so a spacer box becomes the spaces it stood
      // for: the row's width less its text, inside the panel's padding.
      const used = kids.reduce(
        (n, c) => n + (typeof c === 'string' ? c.length : (texts.get(c) ?? 0)),
        0,
      );
      const gap = ' '.repeat(Math.max(1, width - used));
      const runs = kids.map((c) => (typeof c === 'string' || texts.has(c) ? c : gap));
      pressables += 1;
      return Button({
        key: `superagent-press-${pressables}`,
        label: 'Superagent',
        plain: true,
        onPress: () => onPress(),
        children: runs,
      });
    }
    return Box({ ...boxStyle(props), children: kids });
  };

  return { text, box };
};

/** Draw the panel for a pane `width` columns wide. */
export const drawPanel = (model, elements, width) =>
  renderPanel({ ...model, theme: PANEL_THEME, width }, panelFactory(elements, width));
