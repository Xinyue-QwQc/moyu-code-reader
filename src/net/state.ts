import type * as vscode from 'vscode';

const writes = new WeakMap<vscode.Memento, Promise<void>>();

/** Memento persists an entire extension snapshot: serialize writers even when their keys differ. */
export function updateMemento(state: vscode.Memento, key: string, value: unknown): Promise<void> {
  const snapshot = value !== undefined ? JSON.parse(JSON.stringify(value)) : undefined;
  const next = (writes.get(state) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await state.update(key, snapshot);
  });
  writes.set(state, next);
  return next;
}
