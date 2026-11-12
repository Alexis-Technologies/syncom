import { expectType } from 'tsd';
import { graphql } from '../src/connector/graphql.js';
import type { GraphqlHandlers } from '../src/connector/graphql.js';
import { replicate } from '../src/connector/connector.js';
import { createDatabase } from '../index.js';

const db = await createDatabase({ path: 'data' });
const handlers = graphql<{ title: string }, number>({
  url: 'https://api.example.com/graphql',
  pull: {
    query: 'query pull($since: Int) { pull(since: $since) { documents { id data deleted } checkpoint } }',
    variables: (checkpoint, batchSize) => ({ since: checkpoint, limit: batchSize }),
    read: (data) => ({ documents: data.pull.documents, checkpoint: data.pull.checkpoint as number }),
  },
  push: {
    query: 'mutation push($rows: [Row!]!) { push(rows: $rows) { conflicts { id data deleted } } }',
    variables: (rows) => ({ rows }),
    read: (data) => data.push.conflicts,
  },
  stream: (emit) => () => void emit('RESYNC'),
});
expectType<GraphqlHandlers<{ title: string }, number>>(handlers);
replicate(db, { name: 'gql', collection: 'Task', ...handlers });
graphql({
  request: async () => ({}),
  push: { query: 'mutation p { p }', variables: (rows) => ({ rows }), read: () => undefined },
});
