// docs-examples: browser-only (React is not a dependency of this repository; docs/examples/react.mjs runs the store half)
// The React page (docs/guide/react.md) shows the regions of this file. The components call createElement (as `h`)
// so the file runs without a build step; in JSX, h('li', { key }, title) is <li key={key}>{title}</li>.

// #region component
import { createElement as h, useSyncExternalStore } from 'react';
import { board, openTasks } from './board.js';

export const OpenTasks = () => {
  const rows = useSyncExternalStore(openTasks.subscribe, openTasks.getSnapshot);
  return h(
    'ul',
    null,
    rows.map((row) =>
      h(
        'li',
        { key: row.id },
        h('input', {
          type: 'checkbox',
          checked: row.done,
          onChange: () => board.Task.update(row.id, { done: !row.done }),
        }),
        row.title,
      ),
    ),
  );
};
// #endregion component

// #region hook
import { useMemo } from 'react';
import { toStore } from '@alexify/syncom/store';

// A store per set of arguments: made again only when they change, so `subscribe` keeps its identity.
export const useTasks = (done) => {
  const store = useMemo(() => toStore(board.Task.select({ done }).order('title'), { initial: [] }), [done]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};
// #endregion hook

// #region task
import { taskStore } from './board.js';

export const TaskTitle = ({ id }) => {
  const store = useMemo(() => taskStore(id), [id]);
  const task = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (task === undefined) return h('span', null, '…'); // the first read has not answered yet
  if (task === null) return h('span', null, 'deleted');
  return h('span', null, task.title);
};
// #endregion task
