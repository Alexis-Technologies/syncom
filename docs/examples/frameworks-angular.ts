// The Other frameworks page (docs/guide/frameworks.md) includes this file whole. toObservable() hands Angular an
// interop Observable: the `async` pipe and toSignal() read it as they read an RxJS Observable.
import { Component } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { toObservable } from '@alexify/syncom/store';
import { openTasks } from './board.js';

@Component({
  selector: 'open-tasks',
  standalone: true,
  template: `
    <ul>
      @for (row of rows(); track row.id) {
        <li>{{ row.title }}</li>
      }
    </ul>
  `,
})
export class OpenTasksComponent {
  // A signal that follows the store; Angular unsubscribes when the component is destroyed.
  readonly rows = toSignal(toObservable(openTasks), { requireSync: true });
}
