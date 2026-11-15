<!-- The Other frameworks page (docs/guide/frameworks.md) includes this file whole. A syncom store is a Svelte
     store: `$openTasks` subscribes when the component mounts and stops when it is destroyed. -->
<script>
  import { openTasks } from './board.js';
</script>

<ul>
  {#each $openTasks as row (row.id)}
    <li>{row.title}</li>
  {/each}
</ul>
