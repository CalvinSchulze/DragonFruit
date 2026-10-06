/**
 * Test-only stand-in for `@lingui/core/macro`.
 *
 * The `msg` macro is compile-time: `@lingui/swc-plugin` rewrites it during the
 * Next build, and the runtime package it comes from (`@lingui/core/macro`)
 * imports `babel-plugin-macros`, which is deliberately not installed. So a Node
 * test that imports any module calling `msg` would fail to even load it.
 *
 * `src/supports/__tests__/autoSupportPanel.test.tsx` registers a resolve hook
 * pointing `@lingui/core/macro` here before it dynamically imports the panel.
 * The descriptor this returns is the shape the macro produces for a static
 * message — `{ id, message }` — and the real `i18n._` falls back to `message`
 * when the id is not in the catalog, so the rendered English text is the
 * message the source wrote.
 */
export function msg(descriptor, ...values) {
  if (typeof descriptor === 'object' && !Array.isArray(descriptor)) return descriptor;
  const message = String.raw({ raw: descriptor }, ...values);
  return { id: message, message };
}

export const t = msg;
export const defineMessage = msg;
export const plural = (value) => String(value);
export const select = (value) => String(value);
export const selectOrdinal = (value) => String(value);
export const ph = (value) => String(value);
